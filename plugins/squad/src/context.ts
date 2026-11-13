import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tryGit } from "./git.ts"
import type { RepoRules } from "./types.ts"

const RULE_FILE_LIMIT = 18_000
const TOTAL_RULE_LIMIT = 36_000

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

function relative(project: string, file: string): string {
  const rel = path.relative(project, file)
  return rel && !rel.startsWith("..") ? rel : file
}

export async function readRules(project: string): Promise<RepoRules> {
  const candidates = [
    path.join(project, "AGENTS.md"),
    path.join(project, ".opencode", "AGENTS.md"),
    path.join(project, "DECISIONS.md"),
    path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
  ]
  const parts: string[] = []
  const sources: string[] = []
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const raw = await readFile(file, "utf8")
      const text = clip(raw.trim(), RULE_FILE_LIMIT)
      if (!text) continue
      const label = file === path.join(os.homedir(), ".config", "opencode", "AGENTS.md")
        ? "global AGENTS.md (defaults; project rules override)"
        : relative(project, file)
      parts.push(`### ${label}\n${text}`)
      sources.push(label)
    } catch {
      // A missing or unreadable rules file must not block the run.
    }
  }
  return {
    text: clip(parts.join("\n\n"), TOTAL_RULE_LIMIT),
    verification: [],
    sources,
  }
}

export async function repoBrief(project: string): Promise<string> {
  const lines: string[] = []
  const files = await tryGit(project, ["ls-files"])
  const tracked = (files?.stdout ?? "").split(/\r?\n/).filter(Boolean)
  if (tracked.length) {
    lines.push(`Tracked files (${tracked.length}, first 250):`)
    lines.push(tracked.slice(0, 250).join("\n"))
  }
  const packageFile = path.join(project, "package.json")
  if (existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(await readFile(packageFile, "utf8")) as {
        name?: string
        scripts?: Record<string, string>
        workspaces?: unknown
      }
      lines.push("", `package.json: ${pkg.name ?? "unnamed"}`)
      if (pkg.scripts) {
        lines.push("scripts:")
        for (const [name, command] of Object.entries(pkg.scripts)) lines.push(`- ${name}: ${command}`)
      }
      if (pkg.workspaces) lines.push(`workspaces: ${JSON.stringify(pkg.workspaces)}`)
    } catch {
      // Malformed package.json is reported by the gate later.
    }
  }
  for (const name of ["README.md", "README", "readme.md"]) {
    const file = path.join(project, name)
    if (!existsSync(file)) continue
    try {
      const raw = await readFile(file, "utf8")
      lines.push("", `${name} (excerpt):`, raw.split(/\r?\n/).slice(0, 80).join("\n"))
    } catch {
      // Ignore unreadable readme.
    }
    break
  }
  return clip(lines.join("\n"), 12_000)
}
