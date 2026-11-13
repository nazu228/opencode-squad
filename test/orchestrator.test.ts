import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { orchestrate } from "../plugins/squad/src/orchestrator.ts"
import type { SquadOptions } from "../plugins/squad/src/types.ts"
import type { AgentContext } from "../plugins/squad/src/session.ts"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true })
  return String(result.stdout ?? "").trim()
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "squad-orch-"))
  const repo = path.join(root, "repo")
  await execFileAsync("git", ["init", "-q", repo], { windowsHide: true })
  await git(repo, ["config", "user.name", "Test"])
  await git(repo, ["config", "user.email", "test@local"])
  await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8")
  await git(repo, ["add", "-A"])
  await git(repo, ["commit", "-q", "-m", "base"])
  return { root, repo }
}

function makePlan(verification = 'node -e "process.exit(0)"') {
  return {
    summary: "Test plan",
    verification: [verification],
    tasks: [
      {
        id: "research",
        title: "Research",
        role: "analyst",
        files: [],
        dependsOn: [],
        instructions: "Research the repo",
        acceptance: ["findings"],
      },
      {
        id: "build",
        title: "Build",
        role: "executor",
        files: ["changed.txt"],
        dependsOn: ["research"],
        instructions: "Create changed.txt",
        acceptance: ["changed.txt exists"],
      },
      {
        id: "review",
        title: "Review",
        role: "critic",
        files: [],
        dependsOn: ["build"],
        instructions: "Review the change",
        acceptance: ["no blockers"],
      },
    ],
  }
}

class FakeContext implements AgentContext {
  sessions = new Map<string, { agent: string; location: string; prompt: string; response: string }>()
  syntheticMessages: string[] = []
  private counter = 0

  constructor(private options: { write?: boolean; verification?: string } = {}) {}

  async sessionCreate(input: {
    title: string
    agent: string
    parentID?: string
    model?: unknown
    location: { directory: string }
  }) {
    const id = `ses-${++this.counter}`
    this.sessions.set(id, { agent: input.agent, location: input.location.directory, prompt: "", response: "" })
    return { id }
  }

  readonly session = {
    create: async (input: {
      title: string
      agent: string
      parentID?: string
      model?: unknown
      location: { directory: string }
    }) => this.sessionCreate(input),
    prompt: async (input: { sessionID: string; text: string }) => {
      const session = this.sessions.get(input.sessionID)
      if (!session) throw new Error(`unknown session ${input.sessionID}`)
      session.prompt = input.text
      if (session.agent === "team-lid") {
        session.response = input.text.includes("Составь план")
          ? `\`\`\`json\n${JSON.stringify(makePlan(this.options.verification))}\n\`\`\``
          : "STOP"
      } else if (session.agent === "executor" || session.agent === "visual-executor") {
        if (this.options.write !== false) {
          await writeFile(path.join(session.location, "changed.txt"), `changed by ${session.agent}\n`, "utf8")
        }
        session.response = "# Отчёт\nготово"
      } else if (session.agent === "analyst") {
        session.response = "# Анализ\nнайдено"
      } else {
        session.response = "# Критика\nок"
      }
    },
    wait: async () => undefined,
    interrupt: async () => undefined,
    context: async (input: { sessionID: string }) => {
      const session = this.sessions.get(input.sessionID)
      return [{ type: "assistant", content: [{ type: "text", text: session?.response ?? "" }] }]
    },
    get: async (input: { sessionID: string }) => ({ id: input.sessionID, cost: 0, tokens: { input: 1, output: 1 } }),
    synthetic: async (input: { sessionID: string; text: string }) => {
      this.syntheticMessages.push(input.text)
    },
  }
}

test("orchestrate: full plan -> worktree -> gate -> branch -> report", async () => {
  const { root, repo } = await makeRepo()
  const fake = new FakeContext()
  const progress: string[] = []
  const options: SquadOptions = {
    task: "Create changed.txt",
    maxTasks: 8,
    roles: ["analyst", "executor", "visual-executor", "critic"],
    concurrency: 2,
    timeoutMinutes: 1,
    ideal: false,
    verify: [],
    keepWorktrees: false,
    parentSessionID: "parent",
  }
  try {
    const result = await orchestrate({
      ctx: fake as unknown as AgentContext,
      options,
      project: repo,
      projectId: "test",
      parentSessionID: "parent",
      model: undefined,
      progress: async (message) => {
        progress.push(message)
      },
    })
    assert.equal(result.status, "delivered", result.error)
    assert.match(result.branch, /^squad-/)
    assert.equal(existsSync(result.reportPath), true)
    assert.equal(existsSync(path.join(result.runDir, "state.json")), true)
    assert.equal(existsSync(path.join(result.runDir, "events.jsonl")), true)
    assert.equal(existsSync(path.join(result.runDir, "plan.json")), true)
    assert.equal(existsSync(path.join(result.runDir, "results", "build.md")), true)
    assert.equal(existsSync(path.join(result.runDir, "patches", "build.patch")), true)
    const branches = await git(repo, ["branch", "--list", result.branch])
    assert.match(branches, /squad-/)
    const changed = await git(repo, ["show", `${result.branch}:changed.txt`])
    assert.match(changed, /changed by executor/)
    const status = await git(repo, ["status", "--porcelain"])
    assert.equal(status, "")
    const report = await readFile(result.reportPath, "utf8")
    assert.match(report, /git switch/)
    assert.match(report, /changed.txt/)
    assert.ok(progress.some((line) => /Lid fix|Verification|интеграция/.test(line)) || progress.length > 0)
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"])
    assert.doesNotMatch(worktrees, /integration/)
  } finally {
    await rm(path.join(os.homedir(), ".local", "share", "opencode", "squad", "worktrees", "test"), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("orchestrate: failed builder is not integrated", async () => {
  const { root, repo } = await makeRepo()
  const fake = new FakeContext({ write: false })
  const options: SquadOptions = {
    task: "Create changed.txt",
    maxTasks: 8,
    roles: ["analyst", "executor", "visual-executor", "critic"],
    concurrency: 2,
    timeoutMinutes: 1,
    ideal: false,
    verify: [],
    keepWorktrees: false,
  }
  try {
    const result = await orchestrate({
      ctx: fake as unknown as AgentContext,
      options,
      project: repo,
      projectId: "test",
      parentSessionID: "parent",
      model: undefined,
      progress: async () => undefined,
    })
    assert.equal(result.status, "failed")
    const tree = await git(repo, ["ls-tree", "--name-only", result.branch])
    assert.doesNotMatch(tree, /changed\.txt/)
    const state = JSON.parse(await readFile(path.join(result.runDir, "state.json"), "utf8"))
    assert.equal(state.tasks.build.status, "failed")
    assert.equal(state.tasks.build.commit, undefined)
  } finally {
    await rm(path.join(os.homedir(), ".local", "share", "opencode", "squad", "worktrees", "test"), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("orchestrate: red gate fails and keeps the integration worktree", async () => {
  const { root, repo } = await makeRepo()
  const fake = new FakeContext({ verification: 'node -e "process.exit(1)"' })
  const options: SquadOptions = {
    task: "Create changed.txt",
    maxTasks: 8,
    roles: ["analyst", "executor", "visual-executor", "critic"],
    concurrency: 2,
    timeoutMinutes: 1,
    ideal: false,
    verify: [],
    keepWorktrees: false,
  }
  try {
    const result = await orchestrate({
      ctx: fake as unknown as AgentContext,
      options,
      project: repo,
      projectId: "test",
      parentSessionID: "parent",
      model: undefined,
      progress: async () => undefined,
    })
    assert.equal(result.status, "failed")
    const state = JSON.parse(await readFile(path.join(result.runDir, "state.json"), "utf8"))
    assert.equal(state.gate.ok, false)
    assert.equal(existsSync(state.integrationWorktree), true)
    const report = await readFile(result.reportPath, "utf8")
    assert.match(report, /FAIL|exit 1/)
  } finally {
    await rm(path.join(os.homedir(), ".local", "share", "opencode", "squad", "worktrees", "test"), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
