import test from "node:test"
import assert from "node:assert/strict"
import {
  agentResultMarkdown,
  formatCost,
  formatTokens,
  renderReport,
  renderStatus,
} from "../plugins/squad/src/report.ts"
import type { AgentRunResult, RunState, TaskState } from "../plugins/squad/src/types.ts"

function state(): RunState {
  return {
    runId: "20260101-120000-abcdef12",
    task: "Add auth",
    project: "C:/repo",
    base: "origin/dev",
    baseSource: "origin/dev",
    branch: "squad-auth-abcdef12",
    status: "delivered",
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:10:00.000Z",
    finishedAt: "2026-01-01T12:10:00.000Z",
    plan: {
      summary: "Add auth",
      verification: ["npm test"],
      tasks: [{
        id: "api",
        title: "Auth API",
        role: "executor",
        files: ["src/auth/**"],
        dependsOn: [],
        instructions: "Implement",
        acceptance: ["works"],
      }],
    },
    tasks: {
      api: {
        id: "api",
        title: "Auth API",
        role: "executor",
        status: "done",
        dependsOn: [],
        files: ["src/auth/**"],
        commit: "abcdef123456",
      },
    },
    gate: {
      ok: true,
      commands: ["npm test"],
      output: "[exit 0]",
      startedAt: "2026-01-01T12:05:00.000Z",
      finishedAt: "2026-01-01T12:06:00.000Z",
    },
    questions: [],
    board: [],
    artifacts: {
      runDir: "C:/repo/.squad/runs/20260101-120000-abcdef12",
      report: "C:/repo/SQUAD_REPORT.md",
      summary: "C:/repo/.squad/runs/20260101-120000-abcdef12/summary.md",
    },
    warnings: [],
    commits: [{ taskId: "api", commit: "abcdef123456", title: "Auth API" }],
    diffStat: "src/auth/login.ts | 10 ++++++++++",
    changedFiles: ["src/auth/login.ts"],
  }
}

test("renderReport: contains branch, gate and review command", () => {
  const report = renderReport(state(), { analystDigest: "analysis", criticDigest: "critique" })
  assert.match(report, /squad-auth-abcdef12/)
  assert.match(report, /npm test/)
  assert.match(report, /git switch squad-auth-abcdef12/)
  assert.match(report, /Auth API/)
  assert.match(report, /analysis/)
  assert.match(report, /critique/)
})

test("renderStatus: compact task table", () => {
  const text = renderStatus(state())
  assert.match(text, /tasks: 1 done/)
  assert.match(text, /gate: OK/)
  assert.match(text, /api/)
})

test("format helpers", () => {
  assert.equal(formatCost(0.123456), "0.123456")
  assert.equal(formatCost({ input: 1, output: 2 }), "3.000000")
  assert.equal(formatTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }), "in 1, out 2, reason 3, cache 4/5")
})

test("agentResultMarkdown", () => {
  const result: AgentRunResult = {
    id: "api",
    role: "executor",
    status: "ok",
    text: "done",
    sessionID: "ses-1",
    durationMs: 1200,
  }
  const task: TaskState = {
    id: "api",
    title: "Auth API",
    role: "executor",
    status: "done",
    dependsOn: [],
    files: [],
  }
  assert.match(agentResultMarkdown(result, task), /done/)
  assert.match(agentResultMarkdown(result, task), /Auth API/)
})
