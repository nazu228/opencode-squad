import type { PlanTask, RepoRules, SquadOptions, SquadPlan, SquadRole } from "./types.ts"
import { ROLE_ORDER } from "./args.ts"

const ROLE_SET = new Set<SquadRole>(ROLE_ORDER)
const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,48}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} должен быть непустой строкой.`)
  return value.trim()
}

function asStringArray(value: unknown, field: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${field} должен быть массивом строк.`)
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field}[${index}] должен быть непустой строкой.`)
    return item.trim()
  })
}

export function extractJson(text: string): unknown {
  const blocks = [...String(text ?? "").matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  const candidates = blocks.map((match) => match[1] ?? "")
  if (!candidates.length) {
    const first = String(text ?? "").indexOf("{")
    const last = String(text ?? "").lastIndexOf("}")
    if (first >= 0 && last > first) candidates.push(String(text).slice(first, last + 1))
  }
  const errors: string[] = []
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim())
      if (isRecord(parsed) && "tasks" in parsed) return parsed
    } catch (error) {
      errors.push(String((error as Error)?.message ?? error))
    }
  }
  throw new Error(`Lid не вернул валидный JSON-план${errors.length ? `: ${errors.join("; ")}` : "."}`)
}

function normalizeGlob(value: string): string {
  let path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  path = path.replace(/\/+$/, "")
  const star = path.indexOf("*")
  if (star >= 0) path = path.slice(0, star).replace(/\/+$/, "")
  return path
}

function overlaps(left: string, right: string): boolean {
  const a = normalizeGlob(left)
  const b = normalizeGlob(right)
  if (!a || !b) return true
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function validateOwnership(tasks: PlanTask[]): void {
  const builders = tasks.filter((task) => task.role === "executor" || task.role === "visual-executor")
  for (let i = 0; i < builders.length; i++) {
    const left = builders[i]!
    if (!left.files.length) throw new Error(`Задача "${left.id}" роли ${left.role} должна указать files.`)
    for (let j = i + 1; j < builders.length; j++) {
      const right = builders[j]!
      for (const leftFile of left.files) {
        for (const rightFile of right.files) {
          if (overlaps(leftFile, rightFile)) {
            throw new Error(
              `Пересекаются владения файлами: "${left.id}" (${leftFile}) и "${right.id}" (${rightFile}). Lid должен развести задачи или сделать зависимость.`,
            )
          }
        }
      }
    }
  }
}

function validateDependencies(tasks: PlanTask[]): void {
  const ids = new Set(tasks.map((task) => task.id))
  if (ids.size !== tasks.length) throw new Error("ID задач должны быть уникальны.")
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Задача "${task.id}" зависит от неизвестной "${dependency}".`)
      if (dependency === task.id) throw new Error(`Задача "${task.id}" не может зависеть от себя.`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Цикл зависимостей вокруг задачи "${id}".`)
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}

export function validatePlan(value: unknown, options: SquadOptions): SquadPlan {
  if (!isRecord(value)) throw new Error("План должен быть JSON-объектом.")
  const summary = asString(value.summary, "summary")
  const verification = asStringArray(value.verification, "verification")
  const base = value.base == null ? undefined : asString(value.base, "base")
  const ideal = value.ideal === true
  const rawTasks = value.tasks
  if (!Array.isArray(rawTasks) || !rawTasks.length) throw new Error("tasks должен быть непустым массивом.")
  if (rawTasks.length > options.maxTasks) {
    throw new Error(`План содержит ${rawTasks.length} задач, а максимум ${options.maxTasks}. Сожми план.`)
  }
  if (rawTasks.length > 12) throw new Error("Squad v2 разрешает не больше 12 задач.")
  const allowedRoles = new Set(options.roles.length ? options.roles : ROLE_ORDER)
  const tasks: PlanTask[] = rawTasks.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`tasks[${index}] должен быть объектом.`)
    const id = asString(raw.id, `tasks[${index}].id`).toLowerCase()
    if (!TASK_ID.test(id)) throw new Error(`tasks[${index}].id "${id}" содержит недопустимые символы.`)
    const title = asString(raw.title, `tasks[${index}].title`)
    const role = asString(raw.role, `tasks[${index}].role`) as SquadRole
    if (!ROLE_SET.has(role)) throw new Error(`tasks[${index}].role "${role}" неизвестна.`)
    if (!allowedRoles.has(role)) throw new Error(`Роль "${role}" запрещена флагом --roles.`)
    const files = asStringArray(raw.files, `tasks[${index}].files`)
    const dependsOn = asStringArray(raw.dependsOn, `tasks[${index}].dependsOn`).map((item) => item.toLowerCase())
    const instructions = raw.instructions == null
      ? title
      : asString(raw.instructions, `tasks[${index}].instructions`)
    const acceptance = asStringArray(raw.acceptance, `tasks[${index}].acceptance`)
    return { id, title, role, files, dependsOn, instructions, acceptance }
  })
  validateDependencies(tasks)
  validateOwnership(tasks)
  return { summary, base, verification, ideal, tasks }
}

export function parsePlan(text: string, options: SquadOptions): SquadPlan {
  return validatePlan(extractJson(text), options)
}

export function defaultPlan(options: SquadOptions): SquadPlan {
  const role: SquadRole = options.roles.includes("executor")
    ? "executor"
    : options.roles.includes("visual-executor")
      ? "visual-executor"
      : options.roles[0] ?? "executor"
  const builder = role === "executor" || role === "visual-executor"
  return {
    summary: "Lid не вернул валидный план; используется минимальный fallback: одна задача на всю работу.",
    verification: options.verify,
    tasks: [
      {
        id: "main",
        title: options.task.slice(0, 120),
        role,
        files: builder ? ["**"] : [],
        dependsOn: [],
        instructions: options.task,
        acceptance: ["Задача реализована", "Проверки проекта проходят"],
      },
    ],
  }
}

export function planToMarkdown(plan: SquadPlan): string {
  const lines = [
    "# Squad plan",
    "",
    plan.summary,
    "",
    `- Base: ${plan.base ?? "auto"}`,
    `- Ideal: ${plan.ideal ? "yes" : "no"}`,
    `- Verification: ${plan.verification.length ? plan.verification.join("; ") : "auto-detect"}`,
    "",
    "| ID | Role | Title | Files | Depends on |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const task of plan.tasks) {
    lines.push(
      `| ${task.id} | ${task.role} | ${task.title.replace(/\|/g, "\\|")} | ${task.files.join("<br>") || "-"} | ${task.dependsOn.join(", ") || "-"} |`,
    )
  }
  return `${lines.join("\n")}\n`
}

export function planPrompt(input: {
  task: string
  rules: RepoRules
  repoBrief: string
  options: SquadOptions
}): string {
  const roles = input.options.roles.length ? input.options.roles : ROLE_ORDER
  return `Ты — Lid, тимлид автономного отряда. Составь план выполнения задачи и верни ТОЛЬКО JSON-объект в одном блоке \`\`\`json.

## Задача
${input.task}

## Ограничения
- Максимум задач: ${input.options.maxTasks}. Максимум агентов: 12.
- Разрешённые роли: ${roles.join(", ")}.
- Задачи executor и visual-executor должны иметь непересекающиеся files (glob-паттерны). Пересечение запрещено: сделай зависимость или разведи файлы.
- dependsOn — только существующие id, без циклов.
- Для нетривиальной задачи добавь хотя бы одну задачу critic. Critic выполняется после интеграции и не меняет файлы.
- Verification — реальные команды проверки проекта. Не выдумывай команды; если не знаешь, верни пустой массив, и плагин попробует определить их сам.
- Если задача требует повышенной надёжности или пользователь просит «идеально», поставь "ideal": true.
- Не добавляй задачи «на будущее», не проси у пользователя подтверждения, не пиши prose вне JSON.

## Формат
\`\`\`json
{
  "summary": "короткое описание плана",
  "base": "origin/dev или null",
  "ideal": false,
  "verification": ["команда 1", "команда 2"],
  "tasks": [
    {
      "id": "auth-api",
      "title": "Короткое название",
      "role": "executor",
      "files": ["src/auth/**", "test/auth/**"],
      "dependsOn": [],
      "instructions": "Что именно сделать, с учётом контекста проекта",
      "acceptance": ["Что должно быть верно после задачи"]
    }
  ]
}
\`\`\`

## Правила проекта (AGENTS.md / DECISIONS.md)
${input.rules.text || "Правила проекта не найдены."}

## Краткий срез репозитория
${input.repoBrief}
`
}

export function planRetryPrompt(error: string): string {
  return `План не прошёл валидацию: ${error}

Верни исправленный план. Только JSON в одном блоке \`\`\`json, без пояснений.`
}

export function planDigest(plan: SquadPlan, max = 6000): string {
  return planToMarkdown(plan).slice(0, max)
}
