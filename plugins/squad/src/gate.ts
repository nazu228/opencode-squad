import { exec } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { GateResult, RepoRules, SquadPlan } from "./types.ts"

const execAsync = promisify(exec)

interface ShellResult {
  code: number
  output: string
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  try {
    const result = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    const output = [String(result.stdout ?? ""), String(result.stderr ?? "")].filter(Boolean).join("\n").trim()
    return { code: 0, output }
  } catch (error) {
    const value = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string; message?: string }
    const output = [String(value.stdout ?? ""), String(value.stderr ?? "")].filter(Boolean).join("\n").trim()
    if (value.killed) return { code: 124, output: `${output}\n[timeout after ${Math.round(timeoutMs / 1000)}s]`.trim() }
    return { code: typeof value.code === "number" ? value.code : 1, output: output || String(value.message ?? error) }
  }
}

async function packageScripts(project: string): Promise<Record<string, string>> {
  const file = path.join(project, "package.json")
  if (!existsSync(file)) return {}
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { scripts?: Record<string, string> }
    return value.scripts ?? {}
  } catch {
    return {}
  }
}

function packageManager(project: string): string {
  if (existsSync(path.join(project, "bun.lockb")) || existsSync(path.join(project, "bun.lock"))) return "bun"
  if (existsSync(path.join(project, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(path.join(project, "yarn.lock"))) return "yarn"
  return "npm"
}

function scriptCommand(manager: string, script: string): string {
  if (manager === "yarn") return `yarn ${script}`
  if (manager === "bun") return `bun run ${script}`
  if (manager === "pnpm") return `pnpm run ${script}`
  return `npm run ${script}`
}

export async function detectVerification(project: string, plan: SquadPlan | undefined, rules: RepoRules, explicit: readonly string[] = []): Promise<string[]> {
  if (explicit.length) return [...explicit]
  if (plan?.verification?.length) return [...plan.verification]
  if (rules.verification.length) return [...rules.verification]

  const commands: string[] = []
  const scripts = await packageScripts(project)
  if (Object.keys(scripts).length) {
    const manager = packageManager(project)
    for (const name of ["test", "lint", "typecheck", "build"]) {
      if (scripts[name]) commands.push(scriptCommand(manager, name))
    }
    if (!commands.length && scripts.check) commands.push(scriptCommand(manager, "check"))
    if (commands.length) return commands
  }
  if (existsSync(path.join(project, "Cargo.toml"))) commands.push("cargo test")
  else if (existsSync(path.join(project, "go.mod"))) commands.push("go test ./...")
  else if (existsSync(path.join(project, "pyproject.toml")) || existsSync(path.join(project, "pytest.ini"))) {
    commands.push("python -m pytest")
  } else if (existsSync(path.join(project, "pom.xml"))) commands.push("mvn test")
  else if (existsSync(path.join(project, "build.gradle")) || existsSync(path.join(project, "build.gradle.kts"))) {
    commands.push(process.platform === "win32" ? "gradlew.bat test" : "./gradlew test")
  } else if (existsSync(path.join(project, "Makefile")) || existsSync(path.join(project, "makefile"))) {
    // A Makefile may not have a test target; do not guess.
  }
  return commands
}

export async function runGate(worktree: string, commands: readonly string[], timeoutMs = 15 * 60_000): Promise<GateResult> {
  const startedAt = new Date().toISOString()
  if (!commands.length) {
    return {
      ok: false,
      commands: [],
      output: "Не найдены команды verification. Укажи их в плане Lid или через --verify.",
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  }
  const lines: string[] = []
  let ok = true
  for (const command of commands) {
    lines.push(`$ ${command}`)
    const result = await runShell(command, worktree, timeoutMs)
    if (result.output) lines.push(result.output)
    lines.push(`[exit ${result.code}]`)
    if (result.code !== 0) {
      ok = false
      break
    }
  }
  return {
    ok,
    commands: [...commands],
    output: lines.join("\n").trim(),
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}
