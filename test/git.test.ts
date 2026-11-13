import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile, access } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  baselineWorktree,
  capturePatch,
  changedFiles,
  cherryPick,
  commitWorktree,
  createWorktree,
  currentHead,
  deleteBranch,
  changedFiles as _unused,
  diffStat,
  resolveBase,
  syncUntracked,
  removeWorktree,
} from "../plugins/squad/src/git.ts"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true })
  return String(result.stdout ?? "").trim()
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "squad-git-"))
  const repo = path.join(root, "repo")
  await execFileAsync("git", ["init", "-q", repo], { windowsHide: true })
  await git(repo, ["config", "user.name", "Test"])
  await git(repo, ["config", "user.email", "test@local"])
  await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8")
  await git(repo, ["add", "-A"])
  await git(repo, ["commit", "-q", "-m", "base"])
  return { root, repo }
}

test("git: worktree baseline, patch, cherry-pick and cleanup", async () => {
  const { root, repo } = await makeRepo()
  const worktree = path.join(root, "wt")
  const integration = path.join(root, "integration")
  try {
    await writeFile(path.join(repo, "untracked.txt"), "local\n", "utf8")
    await writeFile(path.join(repo, ".env"), "SECRET=1\n", "utf8")
    const base = await resolveBase(repo)
    assert.equal(base.ref, "HEAD")
    await createWorktree(repo, worktree, "squad-agent", base.ref)
    const copied = await syncUntracked(repo, worktree)
    assert.equal(copied.copied >= 1, true)
    assert.equal(existsSync(path.join(worktree, "untracked.txt")), true)
    assert.equal(existsSync(path.join(worktree, ".env")), false)

    const baseline = await baselineWorktree(worktree)
    assert.equal(await currentHead(worktree), baseline)
    const noChange = await commitWorktree(worktree, "noop")
    assert.equal(noChange, null)

    await writeFile(path.join(worktree, "tracked.txt"), "changed\n", "utf8")
    const commit = await commitWorktree(worktree, "squad(api): change tracked")
    assert.ok(commit)
    const patch = await capturePatch(worktree, baseline)
    assert.match(patch, /tracked\.txt/)
    assert.doesNotMatch(patch, /untracked\.txt/)
    assert.doesNotMatch(patch, /SECRET/)

    const integrationBase = await currentHead(repo)
    await createWorktree(repo, integration, "squad-integration", integrationBase)
    const picked = await cherryPick(integration, commit!)
    assert.equal(picked.ok, true)
    assert.deepEqual(await changedFiles(integration, integrationBase), ["tracked.txt"])
    assert.match(await diffStat(integration, integrationBase), /tracked\.txt/)

    await removeWorktree(repo, worktree)
    await removeWorktree(repo, integration)
    await deleteBranch(repo, "squad-agent")
    await deleteBranch(repo, "squad-integration")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("git: createWorktree refuses an existing directory", async () => {
  const { root, repo } = await makeRepo()
  const worktree = path.join(root, "wt")
  try {
    await createWorktree(repo, worktree, "squad-one", "HEAD")
    await assert.rejects(() => createWorktree(repo, worktree, "squad-two", "HEAD"), /уже существует|already exists/)
  } finally {
    await removeWorktree(repo, worktree)
    await rm(root, { recursive: true, force: true })
  }
})
