import test from "node:test"
import assert from "node:assert/strict"
import { runDag, topologicalOrder } from "../plugins/squad/src/scheduler.ts"

test("runDag: respects dependencies and concurrency", async () => {
  const started: string[] = []
  let active = 0
  let peak = 0
  const result = await runDag(
    [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: [] },
    ],
    2,
    async (task) => {
      started.push(task.id)
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active--
      return task.id
    },
  )
  assert.equal(result.statuses.a, "done")
  assert.equal(result.statuses.b, "done")
  assert.equal(result.statuses.c, "done")
  assert.ok(started.indexOf("a") < started.indexOf("b"))
  assert.ok(peak <= 2)
})

test("runDag: failed dependency skips dependents", async () => {
  const result = await runDag(
    [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ],
    2,
    async (task) => {
      if (task.id === "a") throw new Error("boom")
      return task.id
    },
  )
  assert.equal(result.statuses.a, "failed")
  assert.equal(result.statuses.b, "skipped")
  assert.equal(result.statuses.c, "skipped")
  assert.match(result.errors.a ?? "", /boom/)
})

test("topologicalOrder and validation", () => {
  assert.deepEqual(topologicalOrder([
    { id: "b", dependsOn: ["a"] },
    { id: "a", dependsOn: [] },
  ]), ["a", "b"])
  assert.throws(() => topologicalOrder([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ]), /цикл/)
})
