import { execFile } from "node:child_process"
import { copyFile, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const SECRET_PATHSPECS = [
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
  ":(exclude,glob)graphify-out",
  ":(exclude,glob)graphify-out/**",
  ":(exclude,glob)dist",
  ":(exclude,glob)dist/**",
  ":(exclude,glob)build",
  ":(exclude,glob)build/**",
  ":(exclude,glob)target",
  ":(exclude,glob)target/**",
  ":(exclude,glob).next",
  ":(exclude,glob).next/**",
  ":(exclude,glob)coverage",
  ":(exclude,glob)coverage/**",
  ":(exclude,glob)__pycache__",
  ":(exclude,glob)__pycache__/**",
  ":(exclude,glob)*.log",
  ":(exclude,glob)*.tmp",
  ":(exclude,glob)*.pem",
  ":(exclude,glob)*.key",
  ":(exclude,glob)*.p12",
  ":(exclude,glob)id_rsa*",
]

const EXCLUDED_DIRS = new Set([
  ".git",
  ".squad",
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  ".cache",
  "__pycache__",
  "graphify-out",
])

const MAX_COPY_FILES = 200
const MAX_COPY_BYTES = 50 * 1024 * 1024
const MAX_ONE_FILE = 10 * 1024 * 1024

export interface GitOutput {
  stdout: string
  stderr: string
}

export interface BaseInfo {
  ref: string
  commit: string
  source: string
}

export interface CopyResult {
  copied: number
  skipped: number
  bytes: number
}

function errorText(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string; message?: string }
  return String(value?.stderr || value?.stdout || value?.message || error || "unknown git error").trim()
}

export async function exec(file: string, args: string[], options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<GitOutput> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 0,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    })
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") }
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export function git(cwd: string, args: string[], options: { timeout?: number } = {}): Promise<GitOutput> {
  return exec("git", ["-C", cwd, ...args], options)
}

export async function tryGit(cwd: string, args: string[]): Promise<GitOutput | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

export async function repoRoot(project: string): Promise<string> {
  const result = await tryGit(project, ["rev-parse", "--show-toplevel"])
  const root = result?.stdout.trim()
  if (!root) throw new Error(`Squad требует git-репозиторий, а "${project}" им не является.`)
  return path.resolve(root)
}

export function assertSafeProject(project: string): void {
  const normalized = path.resolve(project).toLowerCase()
  const home = path.resolve(os.homedir()).toLowerCase()
  const root = path.parse(normalized).root.toLowerCase()
  const forbidden = new Set([root, home])
  const forbiddenRoots = process.platform === "win32"
    ? ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"]
    : ["/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys", "/opt"]
  for (const entry of forbiddenRoots) forbidden.add(entry)
  for (const entry of [
    path.join(home, ".config", "opencode"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
  ]) {
    forbiddenRoots.push(entry.toLowerCase())
  }
  const inForbiddenRoot = forbiddenRoots.some(
    (entry) => normalized === entry || normalized.startsWith(`${entry}${path.sep}`),
  )
  if (forbidden.has(normalized) || inForbiddenRoot) {
    throw new Error(`Squad нельзя запускать в системной или чувствительной директории: ${project}.`)
  }
}

export async function resolveBase(project: string, requested?: string): Promise<BaseInfo> {
  if (requested?.trim()) {
    const result = await tryGit(project, ["rev-parse", "--verify", `${requested.trim()}^{commit}`])
    const commit = result?.stdout.trim()
    if (!commit) throw new Error(`База "${requested}" не найдена в репозитории.`)
    return { ref: requested.trim(), commit, source: "explicit" }
  }
  const dev = await tryGit(project, ["rev-parse", "--verify", "origin/dev^{commit}"])
  const devCommit = dev?.stdout.trim()
  if (devCommit) return { ref: "origin/dev", commit: devCommit, source: "origin/dev" }
  const remoteHead = await tryGit(project, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (remoteHead?.stdout.trim()) {
    const ref = remoteHead.stdout.trim()
    const verified = await tryGit(project, ["rev-parse", "--verify", `${ref}^{commit}`])
    const commit = verified?.stdout.trim()
    if (commit) return { ref, commit, source: "origin HEAD" }
  }
  const head = await tryGit(project, ["rev-parse", "--verify", "HEAD"])
  const commit = head?.stdout.trim()
  if (!commit) throw new Error("В репозитории нет HEAD: сделай хотя бы один коммит.")
  return { ref: "HEAD", commit, source: "HEAD" }
}

export function safeName(value: string, fallback = "task"): string {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return text || fallback
}

export function branchName(task: string, runId: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const slug = safeName(words[0] ?? "run", "run")
  const short = safeName(runId.split("-").at(-1) ?? runId, "run").slice(0, 8)
  return `squad-${slug}-${short}`
}

export function worktreeRoot(projectId: string, runId: string): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "squad",
    "worktrees",
    safeName(projectId, "project"),
    safeName(runId, "run"),
  )
}

export async function ensureExclude(project: string, lines: readonly string[]): Promise<void> {
  const gitPath = await tryGit(project, ["rev-parse", "--git-path", "info/exclude"])
  const value = gitPath?.stdout.trim()
  if (!value) return
  let file = value
  if (!path.isAbsolute(file)) file = path.resolve(project, file)
  await mkdir(path.dirname(file), { recursive: true })
  let content = existsSync(file) ? await readFile(file, "utf8") : ""
  const existing = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  let changed = false
  for (const line of lines) {
    if (existing.has(line)) continue
    if (content && !content.endsWith("\n")) content += "\n"
    content += `${line}\n`
    existing.add(line)
    changed = true
  }
  if (changed) await writeFile(file, content, "utf8")
}

export async function createWorktree(project: string, directory: string, branch: string, base: string): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true })
  if (existsSync(directory)) throw new Error(`Worktree уже существует: ${directory}`)
  await git(project, ["worktree", "add", "-b", branch, directory, base])
}

export async function removeWorktree(project: string, directory: string): Promise<void> {
  if (!existsSync(directory)) return
  try {
    await git(project, ["worktree", "remove", "--force", directory])
  } catch {
    await tryGit(project, ["worktree", "prune"])
  }
}

export async function pruneWorktrees(project: string): Promise<void> {
  await tryGit(project, ["worktree", "prune"])
}

export async function deleteBranch(project: string, branch: string): Promise<void> {
  await tryGit(project, ["branch", "-D", branch])
}

async function copyRecursive(src: string, dst: string, budget: { files: number; bytes: number; skipped: number }): Promise<void> {
  if (budget.files >= MAX_COPY_FILES) {
    budget.skipped++
    return
  }
  const info = await lstat(src)
  if (info.isSymbolicLink()) {
    const target = await readlink(src)
    await mkdir(path.dirname(dst), { recursive: true })
    try {
      await symlink(target, dst)
      budget.files++
    } catch {
      budget.skipped++
    }
    return
  }
  if (info.isDirectory()) {
    const name = path.basename(src)
    if (EXCLUDED_DIRS.has(name)) {
      budget.skipped++
      return
    }
    await mkdir(dst, { recursive: true })
    for (const entry of await readdir(src)) {
      await copyRecursive(path.join(src, entry), path.join(dst, entry), budget)
    }
    return
  }
  if (!info.isFile()) {
    budget.skipped++
    return
  }
  if (info.size > MAX_ONE_FILE || budget.bytes + info.size > MAX_COPY_BYTES) {
    budget.skipped++
    return
  }
  await mkdir(path.dirname(dst), { recursive: true })
  await copyFile(src, dst)
  budget.files++
  budget.bytes += info.size
}

function isExcludedRelative(rel: string): boolean {
  const parts = rel.replace(/\\/g, "/").split("/")
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true
  const base = parts.at(-1) ?? ""
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return true
  return base.endsWith(".log") || base.endsWith(".tmp") || base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12")
}

export async function syncUntracked(project: string, worktree: string): Promise<CopyResult> {
  const result = await tryGit(project, ["ls-files", "--others", "--exclude-standard", "-z"])
  const untracked = (result?.stdout ?? "").split("\0").filter(Boolean)
  const budget = { files: 0, bytes: 0, skipped: 0 }
  for (const rel of untracked) {
    if (!rel || isExcludedRelative(rel)) {
      budget.skipped++
      continue
    }
    try {
      await copyRecursive(path.join(project, rel), path.join(worktree, rel), budget)
    } catch {
      budget.skipped++
    }
  }
  for (const name of ["node_modules", ".venv", "venv", "vendor"]) {
    const src = path.join(project, name)
    const dst = path.join(worktree, name)
    if (!existsSync(src) || existsSync(dst)) continue
    try {
      await symlink(src, dst, process.platform === "win32" ? "junction" : "dir")
    } catch {
      // Dependencies can be reinstalled by the agent; isolation still works without the symlink.
    }
  }
  return { copied: budget.files, skipped: budget.skipped, bytes: budget.bytes }
}

export async function baselineWorktree(worktree: string): Promise<string> {
  try {
    await git(worktree, ["add", "-A", "--", ".", ...SECRET_PATHSPECS])
  } catch {
    await git(worktree, ["add", "-A"])
    await tryGit(worktree, ["reset", "--", ".env", ".env.local", "node_modules", ".venv", "venv", "vendor"])
  }
  await git(worktree, [
    "-c", "user.name=Squad",
    "-c", "user.email=squad@local",
    "commit", "--allow-empty", "--no-gpg-sign", "--no-verify",
    "-m", "squad: workspace baseline",
  ])
  const head = await git(worktree, ["rev-parse", "HEAD"])
  return head.stdout.trim()
}

export async function commitWorktree(worktree: string, message: string): Promise<string | null> {
  try {
    await git(worktree, ["add", "-A", "--", ".", ...SECRET_PATHSPECS])
  } catch {
    await git(worktree, ["add", "-A"])
    await tryGit(worktree, ["reset", "--", ".env", ".env.local", "node_modules", ".venv", "venv", "vendor"])
  }
  const staged = await tryGit(worktree, ["diff", "--cached", "--quiet"])
  if (staged) return null
  await git(worktree, [
    "-c", "user.name=Squad",
    "-c", "user.email=squad@local",
    "commit", "--no-gpg-sign", "--no-verify",
    "-m", message,
  ])
  const head = await git(worktree, ["rev-parse", "HEAD"])
  return head.stdout.trim()
}

export async function capturePatch(worktree: string, baseline: string): Promise<string> {
  const diff = await git(worktree, ["diff", "--binary", `${baseline}..HEAD`])
  return diff.stdout
}

export async function cherryPick(worktree: string, commit: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await git(worktree, [
      "-c", "user.name=Squad",
      "-c", "user.email=squad@local",
      "cherry-pick", "--no-gpg-sign", commit,
    ])
    return { ok: true }
  } catch (error) {
    await tryGit(worktree, ["cherry-pick", "--abort"])
    return { ok: false, error: errorText(error) }
  }
}

export async function status(worktree: string): Promise<string> {
  const result = await git(worktree, ["status", "--porcelain", "-uall"])
  return result.stdout.trim()
}

export async function diffStat(worktree: string, base: string, head = "HEAD"): Promise<string> {
  const result = await git(worktree, ["diff", "--stat", `${base}..${head}`])
  return result.stdout.trim()
}

export async function changedFiles(worktree: string, base: string, head = "HEAD"): Promise<string[]> {
  const result = await git(worktree, ["diff", "--name-only", `${base}..${head}`])
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export async function logOneline(worktree: string, base: string, head = "HEAD"): Promise<string> {
  const result = await git(worktree, ["log", "--oneline", `${base}..${head}`])
  return result.stdout.trim()
}

export async function currentHead(worktree: string): Promise<string> {
  const result = await git(worktree, ["rev-parse", "HEAD"])
  return result.stdout.trim()
}

export async function branchExists(project: string, branch: string): Promise<boolean> {
  const result = await tryGit(project, ["rev-parse", "--verify", `refs/heads/${branch}`])
  return Boolean(result?.stdout.trim())
}

export async function isGitRepo(project: string): Promise<boolean> {
  const result = await tryGit(project, ["rev-parse", "--is-inside-work-tree"])
  return result?.stdout.trim() === "true"
}

export function shortError(value: unknown, max = 1600): string {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max)}…` : text
}
