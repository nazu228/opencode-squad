import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RunStore } from "../plugins/squad/src/event-store.ts"
import { renderStatus } from "../plugins/squad/src/report.ts"
import type { SquadPlan } from "../plugins/squad/src/types.ts"

const plan: SquadPlan = {
  summary: "Test plan",
  verification: ["node -e \"process.exit(0)\""],
  tasks: [
    {
      id: "api",
      title: "API",
      role: "executor",
      files: ["src/api/**"],
      dependsOn: [],
      instructions: "Implement API",
      acceptance: ["works"],
    },
  ],
}

test("RunStore: persists events, state, tasks, board and questions", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "squad-store-"))
  try {
    const store = await RunStore.create({ project, task: "Test task", base: "HEAD", branch: "squad-test" })
    assert.equal(store.state.status, "planning")
    await store.setStatus("running")
    await store.setPlan(plan)
    await store.setTask("api", { status: "running", startedAt: new Date().toISOString() })
    await store.addBoard({ from: "api", type: "status", text: "started", taskId: "api" })
    const question = await store.addQuestion({ from: "api", text: "Need a decision", destructive: false, taskId: "api" })
    await store.answerQuestion(question.id, "Proceed", "user")
    await store.setGate({
      ok: true,
      commands: ["node -e \"process.exit(0)\""],
      output: "ok",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    })
    await store.addCommit("api", "abcdef123456", "API")
    await store.writeResult("api", "# result")
    await store.writePatch("api", "diff --git a/x b/x\n")
    await store.writeText("note.md", "hello")
    await store.setStatus("delivered")

    const state = await RunStore.read(project, store.state.runId)
    assert.ok(state)
    assert.equal(state?.runId, store.state.runId)
    assert.equal(state?.tasks.api?.status, "running")
    assert.equal(state?.questions[0]?.status, "answered")
    assert.equal(state?.gate?.ok, true)
    assert.equal(state?.commits[0]?.commit, "abcdef123456")
    assert.equal(await readFile(path.join(store.runDir, "results", "api.md"), "utf8"), "# result")
    assert.equal(await readFile(path.join(store.runDir, "note.md"), "utf8"), "hello")

    const list = await RunStore.list(project)
    assert.equal(list.length, 1)
    assert.match(renderStatus(state!), /squad-test/)
    assert.match(renderStatus(state!), /api/)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test("RunStore: rejects path traversal in run id", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "squad-store-"))
  try {
    assert.equal(await RunStore.read(project, "../../etc"), undefined)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})
