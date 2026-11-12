import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const execFileAsync = promisify(execFile)

const ROLE_ORDER = ["analyst", "executor", "visual-executor", "critic"]
const KNOWN_ROLES = new Set(ROLE_ORDER)

const ANALYST_FOCUS = [
  "архитектура и структура проекта",
  "зависимости, сборка и окружение",
  "существующие паттерны и соглашения",
  "тесты, проверки и CI",
  "документация и комментарии",
  "безопасность и секреты",
  "производительность",
  "UI/UX, стили и компоненты",
  "данные, API и контракты",
  "риски, legacy и скрытые связи",
]

const EXEC_FOCUS = [
  "core-логика и API",
  "тесты и краевые случаи",
  "рефакторинг и интеграция",
  "производительность",
  "безопасность и валидация",
  "данные и миграции",
  "документация и примеры",
  "сборка и конфигурация",
]

const VIS_FOCUS = [
  "layout и компоненты",
  "стили и дизайн-система",
  "адаптивность и брейкпоинты",
  "доступность и клавиатурная навигация",
  "ассеты и иконки",
  "UX-тексты и состояния",
  "визуальные состояния и анимации",
  "интеграция визуала с core-логикой",
]

const CRITIC_FOCUS = [
  "корректность и регрессии",
  "безопасность",
  "тесты и покрытие",
  "UX и визуал",
  "производительность",
  "поддерживаемость и сложность",
  "архитектура и контракты",
  "краевые случаи и ошибки",
]

const SECRET_PATHSPECS = [
  ":(exclude,glob).env",
  ":(exclude,glob).env.*",
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)node_modules",
  ":(exclude,glob)node_modules/**",
  ":(exclude,glob).venv",
  ":(exclude,glob).venv/**",
  ":(exclude,glob)venv",
  ":(exclude,glob)venv/**",
  ":(exclude,glob)vendor",
  ":(exclude,glob)vendor/**",
  ":(exclude,glob).squad",
  ":(exclude,glob).squad/**",
]

function safeName(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "agent"
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 220)
}

function tokenSummary(tokens) {
  if (!tokens || typeof tokens !== "object") return "-"
  const parts = []
  if (tokens.input != null) parts.push(`in ${tokens.input}`)
  if (tokens.output != null) parts.push(`out ${tokens.output}`)
  if (tokens.reasoning != null && tokens.reasoning > 0) parts.push(`reason ${tokens.reasoning}`)
  const cache = tokens.cache
  if (cache && (cache.read != null || cache.write != null)) {
    parts.push(`cache ${cache.read ?? 0}/${cache.write ?? 0}`)
  }
  return parts.length ? parts.join(", ") : "-"
}

function costSummary(cost) {
  if (typeof cost === "number") return cost.toFixed(6)
  if (cost == null) return "-"
  return String(cost)
}

function shortError(value, max = 1200) {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function assertSafeProject(project) {
  const normalized = path.resolve(project).toLowerCase()
  const home = path.resolve(os.homedir()).toLowerCase()
  const root = path.parse(normalized).root.toLowerCase()
  const forbidden = new Set([root, home, path.join(home, ".config", "opencode").toLowerCase()])
  const forbiddenRoots =
    process.platform === "win32"
      ? ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"]
      : ["/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys", "/opt"]
  for (const entry of forbiddenRoots) forbidden.add(entry)
  const inForbiddenRoot = forbiddenRoots.some(
    (entry) => normalized === entry || normalized.startsWith(`${entry}${path.sep}`),
  )
  if (forbidden.has(normalized) || inForbiddenRoot) {
    throw new Error(
      `Squad нельзя запускать в системной директории: ${project}. Перейди в папку проекта и повтори /squad.`,
    )
  }
}

async function cmd(file, args, options: any = {}) {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout ?? 0,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) },
  })
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") }
}

function git(project, args, options = {}) {
  return cmd("git", ["-C", project, ...args], options)
}

async function tryGit(project, args, options = {}) {
  try {
    return await git(project, args, options)
  } catch {
    return null
  }
}

async function copyRecursive(src, dst) {
  const info = await lstat(src)
  if (info.isSymbolicLink()) {
    const target = await readlink(src)
    await mkdir(path.dirname(dst), { recursive: true })
    try { await symlink(target, dst) } catch {}
    return
  }
  if (info.isDirectory()) {
    await mkdir(dst, { recursive: true })
    for (const entry of await readdir(src)) {
      await copyRecursive(path.join(src, entry), path.join(dst, entry))
    }
    return
  }
  await mkdir(path.dirname(dst), { recursive: true })
  await copyFile(src, dst)
}

async function ensureExclude(project, lines) {
  const gitPath = await tryGit(project, ["rev-parse", "--git-path", "info/exclude"])
  if (!gitPath || !gitPath.stdout.trim()) return
  let excludePath = gitPath.stdout.trim()
  if (!path.isAbsolute(excludePath)) excludePath = path.resolve(project, excludePath)
  await mkdir(path.dirname(excludePath), { recursive: true })
  let content = ""
  if (existsSync(excludePath)) content = await readFile(excludePath, "utf8")
  const existing = new Set(content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  let changed = false
  for (const line of lines) {
    if (!existing.has(line)) {
      if (content && !content.endsWith("\n")) content += "\n"
      content += `${line}\n`
      existing.add(line)
      changed = true
    }
  }
  if (changed) await writeFile(excludePath, content)
}

async function ensureGit(project) {
  const isRepo = !!(await tryGit(project, ["rev-parse", "--is-inside-work-tree"]))
  if (!isRepo) {
    await git(project, ["init"])
  }
  const headBefore = await tryGit(project, ["rev-parse", "HEAD"])
  const needsBaseline = !headBefore || !headBefore.stdout.trim()
  const excludes = needsBaseline
    ? [
        ".squad/",
        "node_modules/",
        ".env",
        ".env.*",
        "!.env.example",
        ".venv/",
        "venv/",
        "vendor/",
        "__pycache__/",
        "dist/",
        "build/",
        "*.log",
        ".DS_Store",
      ]
    : [".squad/", ".env", ".env.*", "!.env.example"]
  await ensureExclude(project, excludes)
  for (const [key, value] of [
    ["user.name", "Squad"],
    ["user.email", "squad@local"],
  ]) {
    const current = await tryGit(project, ["config", "--get", key])
    if (!current || !current.stdout.trim()) await git(project, ["config", key, value])
  }
  if (needsBaseline) {
    await git(project, ["add", "-A"])
    try {
      await git(project, ["commit", "-m", "chore(squad): baseline", "--no-gpg-sign", "--no-verify"])
    } catch {
      await git(project, ["commit", "--allow-empty", "-m", "chore(squad): baseline", "--no-gpg-sign", "--no-verify"])
    }
  }
  return { initialized: !isRepo, baseline: needsBaseline }
}

async function getBase(project) {
  const head = (await git(project, ["rev-parse", "HEAD"])).stdout.trim()
  let base = head
  let dirty = false
  const status = (await git(project, ["status", "--porcelain"])).stdout
  if (status.trim()) {
    dirty = true
    const stash = await tryGit(project, ["stash", "create"])
    if (stash && stash.stdout.trim()) base = stash.stdout.trim()
  }
  const untrackedRaw = (await git(project, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
  const untracked = untrackedRaw.split("\0").filter(Boolean)
  return { head, base, dirty, untracked }
}

async function createWorktree(ctx, project, runId, id, base) {
  const projectID = safeName(ctx.location?.project?.id || "project")
  const root = path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "squad",
    "worktrees",
    projectID,
    runId,
  )
  await mkdir(root, { recursive: true })
  const dir = path.join(root, safeName(id))
  const branch = `squad/${runId}/${safeName(id)}`
  try {
    await git(project, ["worktree", "add", "-b", branch, dir, base])
  } catch (error) {
    const head = (await git(project, ["rev-parse", "HEAD"])).stdout.trim()
    await git(project, ["worktree", "add", "-b", `${branch}-head`, dir, head])
    return { dir, branch: `${branch}-head`, baseline: head }
  }
  return { dir, branch, baseline: base }
}

async function syncWorktree(project, dir, untracked) {
  for (const rel of untracked) {
    if (!rel || rel.startsWith(".squad/") || rel.startsWith(".squad\\")) continue
    try {
      const src = path.join(project, rel)
      const dst = path.join(dir, rel)
      await copyRecursive(src, dst)
    } catch {
      // Untracked files are best-effort: a missing local file must not break the run.
    }
  }
  for (const name of ["node_modules", ".venv", "venv", "vendor"]) {
    const src = path.join(project, name)
    const dst = path.join(dir, name)
    if (existsSync(src) && !existsSync(dst)) {
      try {
        await symlink(src, dst, process.platform === "win32" ? "junction" : "dir")
      } catch {
        // Dependencies can be reinstalled by the agent; isolation still works without the symlink.
      }
    }
  }
}

async function capturePatch(project, worktree, runDir, id, baseline) {
  try {
    await git(worktree, ["add", "-A", "--", ".", ...SECRET_PATHSPECS])
  } catch {
    await git(worktree, ["add", "-A"])
    try {
      await git(worktree, ["reset", "--", ".env", ".env.local", "node_modules", ".venv", "venv", "vendor"])
    } catch {}
  }
  const diff = await git(worktree, ["diff", "--cached", baseline, "--binary"])
  const patchPath = path.join(runDir, "patches", `${safeName(id)}.patch`)
  await writeFile(patchPath, diff.stdout)
  const names = await git(worktree, ["diff", "--cached", baseline, "--name-only"])
  const files = names.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  try {
    await git(worktree, ["commit", "-m", `squad: ${id}`, "--no-gpg-sign", "--no-verify"])
  } catch {}
  return { id, path: patchPath, files, worktree, branch: null, empty: !diff.stdout.trim(), baseline }
}

function extractAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : Array.isArray(messages?.data) ? messages.data : []
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]
    if (!message) continue
    if (message.type !== "assistant" && message.role !== "assistant") continue
    const content = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : []
    const text = content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      try { await onTimeout() } catch {}
      resolve({ timedOut: true })
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function renderResult(result) {
  return `# ${result.id}\n\n- Role: ${result.role}\n- Session: ${result.sessionID || "-"}\n- Status: ${result.status}${result.error ? ` (${result.error})` : ""}\n- Duration: ${Math.round((result.durationMs || 0) / 1000)}s\n- Cost: ${costSummary(result.info?.cost)}\n- Tokens: ${tokenSummary(result.info?.tokens)}\n\n## Result\n\n${result.text || "_Нет текста_"}\n`
}

async function runAgent(ctx, options): Promise<any> {
  const { role, id, prompt, location, parentID, model, timeoutMs, runDir } = options
  const started = Date.now()
  let sessionID = ""
  let status = "ok"
  let error = ""
  let text = ""
  let info = null
  try {
    const session = await ctx.session.create({
      title: `squad ${id}`,
      agent: role,
      parentID,
      model: model || undefined,
      location: { directory: location },
    })
    sessionID = session.id
    await ctx.session.prompt({ sessionID, text: prompt })
    const waited = await withTimeout(ctx.session.wait({ sessionID }), timeoutMs, async () => {
      try { await ctx.session.interrupt({ sessionID, resume: false }) } catch {}
    })
    if (waited && waited.timedOut) {
      status = "timeout"
      error = `timeout ${Math.round(timeoutMs / 60000)}m`
    }
    const messages = await ctx.session.context({ sessionID })
    text = extractAssistantText(messages)
    if (!text && status === "ok") {
      status = "empty"
      error = "agent returned no text"
    }
    try { info = await ctx.session.get({ sessionID }) } catch {}
    try {
      await mkdir(path.join(runDir, "logs"), { recursive: true })
      await writeFile(
        path.join(runDir, "logs", `${safeName(id)}.json`),
        JSON.stringify({ sessionID, role, info, messages }, null, 2),
      )
    } catch {}
  } catch (caught) {
    status = "error"
    error = String(caught?.message ?? caught)
  }
  const result = {
    sessionID,
    role,
    id,
    status,
    error,
    text,
    info,
    durationMs: Date.now() - started,
  }
  try {
    await mkdir(path.join(runDir, "results"), { recursive: true })
    await writeFile(path.join(runDir, "results", `${safeName(id)}.md`), renderResult(result))
  } catch {}
  return result
}

async function runPool(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        results[index] = {
          id: items[index]?.id || `item-${index}`,
          role: items[index]?.role || "unknown",
          status: "error",
          error: String(error?.message ?? error),
          text: "",
          durationMs: 0,
        }
      }
    }
  })
  await Promise.all(workers)
  return results
}

function digest(results, maxPer = 6000, maxTotal = 60000) {
  let output = ""
  for (const result of results) {
    const chunk = `### ${result.id} (${result.status})\n${String(result.text || "").slice(0, maxPer)}\n\n`
    if (output.length + chunk.length > maxTotal) {
      output += `... остальные отчёты лежат в ${result.id}.md\n`
      break
    }
    output += chunk
  }
  return output.trim() || "_Нет результатов._"
}

function analystPrompt(task, instance, focus, runDir) {
  return `Ты — ${instance.id}, аналитик squad. Тимлид — Lid (team-lid). Ты работаешь по его заданию.

## Задача
${task}

## Твой фокус
${focus}

## Что нужно сделать
1. Изучи проект: структуру, ключевые файлы, зависимости, тесты, документацию, паттерны.
2. Найди всё, что нужно для качественного выполнения задачи.
3. Отдельно отметь файлы и места, которые придётся менять.
4. Оцени риски, ограничения и неизвестные.
5. Если данных не хватает — сформулируй вопросы к Lid.

## Жёсткие правила
- НЕ редактируй файлы. Только чтение, поиск, git-инспекция и безопасные команды.
- Не читай .env и секреты.
- Каждое утверждение подкрепляй ссылкой path/to/file:line.
- Не давай абстрактных советов — только по этому проекту.
- Верни структурированный отчёт на русском.

Артефакты запуска: ${runDir}
`
}

function builderPrompt(options) {
  const {
    task,
    instance,
    role,
    focus,
    researchDigest,
    coreDigest,
    corePatches,
    runDir,
    location,
    isWorktree,
  } = options
  const isVisual = role === "visual-executor"
  const roleText = isVisual
    ? `Ты — ${instance.id}, визуальный исполнитель squad. Тимлид — Lid (team-lid). Ты подчиняешься Lid в первую очередь и executor во вторую.`
    : `Ты — ${instance.id}, основной исполнитель squad. Тимлид — Lid (team-lid). Ты подчиняешься Lid.`
  const workText = isWorktree
    ? `Ты работаешь в изолированном git worktree: ${location}. Изменения должны остаться в нём.`
    : `Ты работаешь в общей рабочей копии проекта: ${location}.`
  const visualText = isVisual
    ? `## Связь с executor
Сначала прочитай отчёт и изменения executor. Core-патчи: ${corePatches.length ? corePatches.join(", ") : "нет"}.
Если ты работаешь в worktree, core-изменения уже применены и закоммичены как \`squad: core baseline\`. Не применяй их повторно.
Если ты работаешь в общей рабочей копии, изменения executor уже могут быть в файлах — проверь \`git status\` и \`git diff\`.
Не ломай контракты executor. Если нужно изменить core-логику — опиши это в отчёте как зависимость.
Задачи от Lid приоритетнее задач от executor.`
    : `## Зона ответственности
Core-логика, API, данные, тесты, исправления. Не создавай и не меняй HTML/CSS/UI-компоненты/ассеты — это зона visual-executor. Если без минимальной заглушки нельзя проверить core — сделай её и явно опиши в отчёте, чтобы visual-executor её заменил.`
  return `${roleText}

## Задача
${task}

## Твой фокус
${focus}

## Рабочая копия
${workText}

${visualText}

## Исследование аналитиков
${researchDigest}

${isVisual ? `## Результаты core-исполнителей\n${coreDigest}` : ""}

## Что нужно сделать
1. Прочитай отчёт аналитиков и существующий код.
2. Реализуй свою часть задачи.
3. Запусти релевантные тесты, линтеры или сборку. Если проверка падает — почини или зафиксируй.
4. В конце верни отчёт: что сделано, изменённые файлы, как проверить, риски, что осталось.

## Жёсткие правила
- Не читай .env и секреты.
- Не выходи за пределы проекта/worktree.
- Не делай git push, не переписывай историю, не удаляй чужие изменения.
- Не выдумывай результаты проверок.
- Пиши на русском.

Артефакты запуска: ${runDir}
`
}

function criticPrompt(options) {
  const { task, instance, focus, builderResults, applyResults, changedFiles, projectDiff, runDir, project } = options
  const builderDigest = digest(builderResults, 5000, 50000)
  const integration = applyResults.length
    ? applyResults.map((item) => `- ${item.ok ? "OK" : "FAIL"}: ${item.patch}${item.error ? ` — ${shortError(item.error)}` : ""}`).join("\n")
    : "- Патчи не применялись (общая рабочая копия)."
  return `Ты — ${instance.id}, критик squad. Тимлид — Lid (team-lid). Ты не редактируешь файлы.

## Задача
${task}

## Твой фокус
${focus}

## Материалы
Проект: ${project}
Артефакты: ${runDir}

### Изменённые файлы
${changedFiles.length ? changedFiles.map((f) => `- ${f}`).join("\n") : "_git status пуст._"}

### Diff stat
\`\`\`
${projectDiff || "нет diff"}
\`\`\`

### Интеграция патчей
${integration}

### Отчёты исполнителей
${builderDigest}

## Что проверить
1. Корректность и регрессии.
2. Безопасность и утечки секретов.
3. Тесты и краевые случаи.
4. UX/визуал, если применимо.
5. Производительность и поддерживаемость.
6. Контракты и обратную совместимость.

## Жёсткие правила
- НЕ редактируй файлы и не применяй патчи.
- Не читай .env и секреты.
- Сортируй замечания: blocker / major / minor / nit.
- Ссылайся на path:line.
- Если всё хорошо — скажи это фактами, без выдуманных проблем.
- Верни отчёт на русском.

Артефакты запуска: ${runDir}
`
}

function buildInstances(count, roles) {
  const order = roles && roles.length ? roles : ROLE_ORDER
  const counts = new Map()
  const instances = []
  for (let index = 0; index < count; index++) {
    const role = order[index % order.length]
    const current = (counts.get(role) || 0) + 1
    counts.set(role, current)
    instances.push({ role, index: current, id: `${role}-${current}` })
  }
  return instances
}

function normalizeRoles(values) {
  const roles = []
  for (const raw of values) {
    const value = String(raw || "").trim().toLowerCase()
    if (!value) continue
    const alias =
      value === "coder" || value === "builder" || value === "dev"
        ? "executor"
        : value === "visual" || value === "viz" || value === "designer"
          ? "visual-executor"
          : value === "reviewer" || value === "review"
            ? "critic"
            : value === "researcher" || value === "scout" || value === "explore"
              ? "analyst"
              : value
    if (!KNOWN_ROLES.has(alias)) {
      throw new Error(
        `Неизвестная роль "${raw}". Доступны: ${ROLE_ORDER.join(", ")} (алиасы: coder, visual, reviewer, researcher).`,
      )
    }
    roles.push(alias)
  }
  return roles
}

function parseSquadArgs(raw) {
  let text = String(raw ?? "").trim()
  text = text.replace(/^\/squad\b/i, "").trim()
  const options = {
    count: 4,
    roles: [],
    concurrency: 8,
    worktrees: undefined,
    keepWorktrees: false,
    timeoutMinutes: 15,
    task: "",
    error: "",
  }
  if (!text) {
    options.error = "Формат: /squad <2-100> <задача> или /squad --agents <2-100> <задача>."
    return options
  }
  let match = text.match(/^--agents(?:=|\s+)(\d+)\b/i)
  if (match) {
    options.count = Number(match[1])
    text = text.slice(match[0].length).trim()
  } else {
    match = text.match(/^(\d+)\b/)
    if (match) {
      options.count = Number(match[1])
      text = text.slice(match[0].length).trim()
    }
  }
  let scanning = true
  while (scanning) {
    scanning = false
    match = text.match(/^--roles(?:=|\s+)([^\s]+)\s*/i)
    if (match) {
      try {
        options.roles = normalizeRoles(match[1].split(","))
      } catch (error) {
        options.error = String(error?.message ?? error)
        return options
      }
      text = text.slice(match[0].length)
      scanning = true
      continue
    }
    match = text.match(/^--concurrency(?:=|\s+)(\d+)\s*/i)
    if (match) {
      options.concurrency = Number(match[1])
      text = text.slice(match[0].length)
      scanning = true
      continue
    }
    match = text.match(/^--timeout(?:=|\s+)(\d+)\s*/i)
    if (match) {
      options.timeoutMinutes = Number(match[1])
      text = text.slice(match[0].length)
      scanning = true
      continue
    }
    match = text.match(/^--(no-worktrees|keep-worktrees)\b\s*/i)
    if (match) {
      if (match[1].toLowerCase() === "no-worktrees") options.worktrees = false
      else options.keepWorktrees = true
      text = text.slice(match[0].length)
      scanning = true
      continue
    }
    match = text.match(/^--worktrees\b\s*/i)
    if (match) {
      options.worktrees = true
      text = text.slice(match[0].length)
      scanning = true
      continue
    }
  }
  options.task = text.trim()
  if (!Number.isFinite(options.count) || options.count < 2 || options.count > 100) {
    options.error = "Количество агентов должно быть от 2 до 100."
    return options
  }
  if (!options.task) {
    options.error = "Не указана задача. Формат: /squad <2-100> <задача>."
    return options
  }
  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) options.concurrency = 8
  options.concurrency = Math.min(options.concurrency, 100)
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes < 1) options.timeoutMinutes = 15
  options.timeoutMinutes = Math.min(options.timeoutMinutes, 120)
  return options
}

function tableRows(results) {
  return results
    .map(
      (result) =>
        `| ${escapeCell(result.id)} | ${escapeCell(result.role)} | ${escapeCell(result.status)} | ${escapeCell(result.sessionID || "-")} | ${escapeCell(costSummary(result.info?.cost))} | ${escapeCell(tokenSummary(result.info?.tokens))} | ${escapeCell(result.patch ? path.basename(result.patch) : "-")} |`,
    )
    .join("\n")
}

function renderSummary(data) {
  const { runId, task, project, instances, analysts, core, visual, critics, applyResults, changedFiles, projectDiff, startedAt, finishedAt, worktreesEnabled, concurrency, runDir } = data
  const all = [...analysts, ...core, ...visual, ...critics]
  const criticDigest = critics.length
    ? digest(critics, 3000, 30000)
    : "_Критиков не было — финальную критику делает Lid._"
  const applied = applyResults.length
    ? applyResults.map((item) => `- ${item.ok ? "OK" : "FAIL"}: ${path.basename(item.patch)}${item.error ? ` — ${shortError(item.error)}` : ""}`).join("\n")
    : "- Патчи не применялись (общая рабочая копия)."
  return `# Squad run ${runId}

- **Задача:** ${task}
- **Проект:** ${project}
- **Агентов:** ${instances.length}
- **Concurrency:** ${concurrency}
- **Worktrees:** ${worktreesEnabled ? "да" : "нет"}
- **Начало:** ${startedAt.toISOString()}
- **Конец:** ${finishedAt.toISOString()}
- **Артефакты:** ${runDir}
- **Отчёт:** ${path.join(project, "SQUAD_REPORT.md")}

## Состав squad

| ID | Роль | Статус | Сессия | Стоимость | Токены | Патч |
| --- | --- | --- | --- | --- | --- | --- |
${tableRows(all) || "| - | - | - | - | - | - | - |"}

## Фазы

- Аналитики: ${analysts.length}
- Core-исполнители: ${core.length}
- Визуальные исполнители: ${visual.length}
- Критики: ${critics.length}

## Интеграция

${applied}

## Изменённые файлы

${changedFiles.length ? changedFiles.map((file) => `- ${file}`).join("\n") : "_Нет изменений в git status._"}

## Diff stat

\`\`\`
${projectDiff || "нет diff"}
\`\`\`

## Критика

${criticDigest}

## Результаты по агентам

${all.map((result) => `- ${result.id}: ${path.join(runDir, "results", `${safeName(result.id)}.md`)}`).join("\n") || "- нет"}
`
}

function renderReportDraft(summary) {
  return `# SQUAD_REPORT

> Черновик создан автоматически оркестратором squad. Lid должен проверить факты, разобрать критику и обновить отчёт.

${summary.replace(/^# Squad run[^\n]*\n/, "")}

## Следующие шаги

- Проверить изменённые файлы и diff.
- Разобрать blocker/major замечания критиков.
- Запустить финальные проверки.
`
}

async function orchestrate(ctx, options, progress) {
  const project = options.projectDir || ctx.location?.project?.canonical || ctx.location?.directory
  if (!project) throw new Error("Не удалось определить директорию проекта.")
  assertSafeProject(project)
  const instances = buildInstances(options.count, options.roles || [])
  const worktreesEnabled = options.worktrees === true || (options.worktrees !== false && options.count > 4)
  const concurrency = Math.max(1, Math.min(options.concurrency || 8, options.count))
  const timeoutMs = Math.max(1, options.timeoutMinutes || 15) * 60000
  const parentID = options.parentSessionID
  let parentModel: any = null
  if (parentID) {
    try {
      const parent = await ctx.session.get({ sessionID: parentID })
      parentModel = parent?.model || null
    } catch {}
  }
  const runId = `${stamp()}-${Math.random().toString(36).slice(2, 7)}`
  const runDir = path.join(project, ".squad", "runs", runId)
  await mkdir(path.join(runDir, "results"), { recursive: true })
  await mkdir(path.join(runDir, "patches"), { recursive: true })
  await mkdir(path.join(runDir, "logs"), { recursive: true })
  const startedAt = new Date()
  const log = []
  const note = async (message) => {
    log.push(message)
    try { await progress(message) } catch {}
  }

  await note(`Squad: старт. Агентов: ${options.count}. Проект: ${project}`)
  await ensureGit(project)
  const baseInfo = await getBase(project)
  await note(`Squad: git готов. База ${baseInfo.base.slice(0, 8)}${baseInfo.dirty ? " (с локальными изменениями)" : ""}`)
  if (baseInfo.dirty && baseInfo.base === baseInfo.head) {
    await note("Squad: локальные изменения не удалось включить в snapshot — worktrees стартуют с HEAD")
  }

  const analysts = instances.filter((item) => item.role === "analyst")
  const coreInstances = instances.filter((item) => item.role === "executor")
  const visualInstances = instances.filter((item) => item.role === "visual-executor")
  const criticInstances = instances.filter((item) => item.role === "critic")

  let analystResults = []
  if (analysts.length) {
    await note(`Squad: фаза 1 — аналитики (${analysts.length})`)
    analystResults = await runPool(analysts, concurrency, async (instance) => {
      const focus = ANALYST_FOCUS[(instance.index - 1) % ANALYST_FOCUS.length]
      const result = await runAgent(ctx, {
        role: "analyst",
        id: instance.id,
        prompt: analystPrompt(options.task, instance, focus, runDir),
        location: project,
        parentID,
        model: parentModel,
        timeoutMs,
        runDir,
      })
      await note(`Squad: ${instance.id} — ${result.status}`)
      return result
    })
  }

  const researchDigest = digest(analystResults)

  let coreResults = []
  const corePatches = []
  if (coreInstances.length) {
    await note(`Squad: фаза 2 — core-исполнители (${coreInstances.length})`)
    coreResults = await runPool(coreInstances, concurrency, async (instance) => {
      const focus = EXEC_FOCUS[(instance.index - 1) % EXEC_FOCUS.length]
      let location = project
      let worktree = null
      if (worktreesEnabled) {
        try {
          worktree = await createWorktree(ctx, project, runId, instance.id, baseInfo.base)
          await syncWorktree(project, worktree.dir, baseInfo.untracked)
          location = worktree.dir
        } catch (error) {
          await note(`Squad: worktree для ${instance.id} не создан — работаю в проекте (${String(error?.message ?? error)})`)
        }
      }
      const result = await runAgent(ctx, {
        role: "executor",
        id: instance.id,
        prompt: builderPrompt({
          task: options.task,
          instance,
          role: "executor",
          focus,
          researchDigest,
          coreDigest: "",
          corePatches: [],
          runDir,
          location,
          isWorktree: !!worktree,
        }),
        location,
        parentID,
        model: parentModel,
        timeoutMs,
        runDir,
      })
      result.worktree = worktree?.dir
      result.branch = worktree?.branch
      if (worktree?.dir) {
        try {
          const patch = await capturePatch(project, worktree.dir, runDir, instance.id, worktree.baseline)
          patch.branch = worktree.branch
          result.patch = patch.path
          result.changedFiles = patch.files
          result.patchEmpty = patch.empty
          corePatches.push(patch)
        } catch (error) {
          result.patchError = String(error?.message ?? error)
        }
      }
      await note(`Squad: ${instance.id} — ${result.status}${result.patch ? `, patch ${path.basename(result.patch)}` : ""}`)
      return result
    })
  }

  let visualResults = []
  const visualPatches = []
  if (visualInstances.length) {
    await note(`Squad: фаза 3 — визуальные исполнители (${visualInstances.length})`)
    visualResults = await runPool(visualInstances, concurrency, async (instance) => {
      const focus = VIS_FOCUS[(instance.index - 1) % VIS_FOCUS.length]
      let location = project
      let worktree = null
      if (worktreesEnabled) {
        try {
          worktree = await createWorktree(ctx, project, runId, instance.id, baseInfo.base)
          await syncWorktree(project, worktree.dir, baseInfo.untracked)
          let appliedCore = 0
          for (const patch of corePatches) {
            if (patch.empty) continue
            try {
              await git(worktree.dir, ["apply", "--check", "--3way", "--whitespace=nowarn", patch.path])
              await git(worktree.dir, ["apply", "--3way", "--whitespace=nowarn", patch.path])
              appliedCore++
            } catch {
              await note(`Squad: ${instance.id} не смог применить core patch ${path.basename(patch.path)}`)
            }
          }
          // Commit the core baseline inside the visual worktree. Without this,
          // the visual patch would contain core changes too and integration
          // would apply them twice.
          if (appliedCore > 0) {
            try {
              await git(worktree.dir, ["add", "-A", "--", ".", ...SECRET_PATHSPECS])
            } catch {
              await git(worktree.dir, ["add", "-A"])
            }
            try {
              await git(worktree.dir, ["commit", "-m", "squad: core baseline", "--no-gpg-sign", "--no-verify"])
            } catch {}
            try {
              worktree.baseline = (await git(worktree.dir, ["rev-parse", "HEAD"])).stdout.trim()
            } catch {}
          }
          location = worktree.dir
        } catch (error) {
          await note(`Squad: worktree для ${instance.id} не создан — работаю в проекте (${String(error?.message ?? error)})`)
        }
      }
      const result = await runAgent(ctx, {
        role: "visual-executor",
        id: instance.id,
        prompt: builderPrompt({
          task: options.task,
          instance,
          role: "visual-executor",
          focus,
          researchDigest,
          coreDigest: digest(coreResults, 5000, 40000),
          corePatches: corePatches.map((patch) => patch.path),
          runDir,
          location,
          isWorktree: !!worktree,
        }),
        location,
        parentID,
        model: parentModel,
        timeoutMs,
        runDir,
      })
      result.worktree = worktree?.dir
      result.branch = worktree?.branch
      if (worktree?.dir) {
        try {
          const patch = await capturePatch(project, worktree.dir, runDir, instance.id, worktree.baseline)
          patch.branch = worktree.branch
          result.patch = patch.path
          result.changedFiles = patch.files
          result.patchEmpty = patch.empty
          visualPatches.push(patch)
        } catch (error) {
          result.patchError = String(error?.message ?? error)
        }
      }
      await note(`Squad: ${instance.id} — ${result.status}${result.patch ? `, patch ${path.basename(result.patch)}` : ""}`)
      return result
    })
  }

  const applyResults = []
  if (worktreesEnabled) {
    await note("Squad: интеграция патчей")
    for (const patch of [...corePatches, ...visualPatches]) {
      if (patch.empty) {
        applyResults.push({ patch: patch.path, ok: true, empty: true })
        continue
      }
      try {
        await git(project, ["apply", "--check", "--3way", "--whitespace=nowarn", patch.path])
      } catch (error) {
        applyResults.push({ patch: patch.path, ok: false, error: `check failed: ${String(error?.message ?? error)}` })
        await note(`Squad: patch ${path.basename(patch.path)} не прошёл проверку — оставил Lid`)
        continue
      }
      try {
        await git(project, ["apply", "--3way", "--whitespace=nowarn", patch.path])
        applyResults.push({ patch: patch.path, ok: true })
      } catch (error) {
        applyResults.push({ patch: patch.path, ok: false, error: String(error?.message ?? error) })
        await note(`Squad: patch ${path.basename(patch.path)} не применился — оставил Lid`)
      }
    }
  }

  let projectDiff = ""
  let changedFiles = []
  try {
    projectDiff = (await git(project, ["diff", "HEAD", "--stat"])).stdout.trim()
    const status = (await git(project, ["status", "--porcelain", "-uall"])).stdout.trim()
    changedFiles = status ? status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
  } catch {}

  let criticResults = []
  if (criticInstances.length) {
    await note(`Squad: фаза 4 — критики (${criticInstances.length})`)
    const builderResults = [...coreResults, ...visualResults]
    criticResults = await runPool(criticInstances, concurrency, async (instance) => {
      const focus = CRITIC_FOCUS[(instance.index - 1) % CRITIC_FOCUS.length]
      const result = await runAgent(ctx, {
        role: "critic",
        id: instance.id,
        prompt: criticPrompt({
          task: options.task,
          instance,
          focus,
          builderResults,
          applyResults,
          changedFiles,
          projectDiff,
          runDir,
          project,
        }),
        location: project,
        parentID,
        model: parentModel,
        timeoutMs,
        runDir,
      })
      await note(`Squad: ${instance.id} — ${result.status}`)
      return result
    })
  } else {
    await note("Squad: критиков нет — финальную критику делает Lid")
  }

  const finishedAt = new Date()
  const data = {
    runId,
    task: options.task,
    project,
    instances,
    analysts: analystResults,
    core: coreResults,
    visual: visualResults,
    critics: criticResults,
    applyResults,
    changedFiles,
    projectDiff,
    startedAt,
    finishedAt,
    worktreesEnabled,
    concurrency,
    runDir,
    log,
  }
  const summary = renderSummary(data)
  await writeFile(path.join(runDir, "summary.md"), summary)
  await writeFile(path.join(project, "SQUAD_REPORT.md"), renderReportDraft(summary))
  await note(`Squad: готово. Отчёт: ${path.join(project, "SQUAD_REPORT.md")}`)

  if (worktreesEnabled && !options.keepWorktrees) {
    const allBuilders = [...coreResults, ...visualResults]
    for (const builder of allBuilders) {
      if (!builder.worktree) continue
      if (!builder.patch || builder.patchError) continue
      const failed = applyResults.some((item) => !item.ok && item.patch === builder.patch)
      if (failed) continue
      try { await git(project, ["worktree", "remove", "--force", builder.worktree]) } catch {}
      if (builder.branch) {
        try { await git(project, ["branch", "-D", builder.branch]) } catch {}
      }
    }
  }

  return { summary, runDir, project, runId, instances }
}

function toolInputFromValue(input) {
  const count = Number(input?.count ?? 4)
  const task = String(input?.task ?? "").trim()
  if (!Number.isFinite(count) || count < 2 || count > 100) {
    throw new Error("count должен быть от 2 до 100.")
  }
  if (!task) throw new Error("task обязателен.")
  const roles = input?.roles ? normalizeRoles(String(input.roles).split(",")) : []
  return {
    count,
    task,
    roles,
    concurrency: Number(input?.concurrency ?? 8),
    worktrees: typeof input?.worktrees === "boolean" ? input.worktrees : undefined,
    keepWorktrees: input?.keep_worktrees === true,
    timeoutMinutes: Number(input?.timeout_minutes ?? 15),
  }
}

export default Plugin.define({
  id: "squad",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "squad",
        description:
          "Запускает отряд из N агентов над одной задачей: аналитики, core-исполнители, визуальные исполнители и критики. Используй, когда пользователь просит /squad или многоагентную работу.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Задача для отряда" },
            count: {
              type: "integer",
              minimum: 2,
              maximum: 100,
              description: "Сколько агентов запустить (2-100). По умолчанию 4.",
            },
            roles: {
              type: "string",
              description:
                "Опционально: список ролей через запятую. Доступны analyst, executor, visual-executor, critic.",
            },
            concurrency: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Сколько агентов работать одновременно. По умолчанию 8.",
            },
            timeout_minutes: {
              type: "integer",
              minimum: 1,
              maximum: 120,
              description: "Таймаут на одного агента в минутах. По умолчанию 15.",
            },
            worktrees: {
              type: "boolean",
              description:
                "Создавать ли git worktrees. По умолчанию true при count > 4, иначе false.",
            },
            keep_worktrees: {
              type: "boolean",
              description: "Оставить worktrees после запуска. По умолчанию false.",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "squad",
            resources: ["run"],
            save: ["run"],
          })
          const parsed = toolInputFromValue(input)
          const result = await orchestrate(
            ctx,
            {
              ...parsed,
              parentSessionID: context.sessionID,
              projectDir: ctx.location?.project?.canonical || ctx.location?.directory,
            },
            async (status) => {
              try { await context.progress({ status }) } catch {}
            },
          )
          return { content: result.summary }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "squad",
        description:
          "Запустить отряд агентов: /squad <2-100> <задача>, /squad --agents <N> <задача>, флаги --roles, --concurrency, --timeout, --no-worktrees, --keep-worktrees",
        execute: async ({ sessionID, prompt, delivery }) => {
          try {
            const parsed = parseSquadArgs(prompt?.text || "")
            if (parsed.error) {
              await ctx.session.synthetic({
                sessionID,
                text: `Squad: ${parsed.error}`,
                description: "squad",
              })
              return
            }
            const projectDir = ctx.location?.project?.canonical || ctx.location?.directory
            assertSafeProject(projectDir)
            try {
              await ctx.session.switchAgent({ sessionID, agent: "team-lid" })
            } catch {}
            const plannedRoles = [...new Set(buildInstances(parsed.count, parsed.roles).map((item) => item.role))]
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: запускаю ${parsed.count} агентов. Роли: ${plannedRoles.join(", ")}.`,
              description: "squad",
            })
            const result = await orchestrate(
              ctx,
              {
                ...parsed,
                parentSessionID: sessionID,
                projectDir,
              },
              async (status) => {
                try {
                  await ctx.session.synthetic({ sessionID, text: status, description: "squad" })
                } catch {}
              },
            )
            const leadPrompt = `Ты — Lid (team-lid). Запуск squad ${result.runId} завершён.

## Краткая сводка
${result.summary}

## Полные материалы
- Полная сводка: ${path.join(result.runDir, "summary.md")}
- Результаты агентов: ${path.join(result.runDir, "results")}
- Патчи: ${path.join(result.runDir, "patches")}
- Черновик отчёта: ${path.join(result.project, "SQUAD_REPORT.md")}

## Твоя задача
1. Прочитай полную сводку и ключевые результаты агентов.
2. Проверь фактические изменения в проекте: git status, git diff, открой изменённые файлы.
3. Если какой-то патч не применился — реши, применять его вручную или зафиксировать как риск.
4. Разбери замечания критиков: blocker и major обязательно, minor — по возможности.
5. Если у аналитика или критика остались вопросы, продолжи его сессию через \`subagent\` с \`sessionID\` из сводки и получи ответ.
6. Обнови SQUAD_REPORT.md: задача, состав squad, что сделано, изменённые файлы, критика и решения, риски, как проверить, следующие шаги.
7. Ответь пользователю кратко: сколько агентов работало, что сделано, где отчёт, какие файлы изменены, что осталось.
Не запускай /squad повторно. Не создавай дополнительных субагентов без явной необходимости; если создал — укажи их отдельно в отчёте.`
            const payload: any = { sessionID, text: leadPrompt }
            if (delivery) payload.delivery = delivery
            await ctx.session.prompt(payload)
          } catch (error) {
            try {
              await ctx.session.synthetic({
                sessionID,
                text: `Squad: ошибка запуска — ${String(error?.message ?? error)}`,
                description: "squad",
              })
            } catch {}
          }
        },
      })
    })
  },
})
