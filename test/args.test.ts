import test from "node:test"
import assert from "node:assert/strict"
import { parseAnswerArgs, parseSquadArgs, parseStatusArgs, parseToolInput } from "../plugins/squad/src/args.ts"

test("parseSquadArgs: defaults", () => {
  const options = parseSquadArgs("Add JWT auth")
  assert.equal(options.task, "Add JWT auth")
  assert.equal(options.maxTasks, 8)
  assert.equal(options.concurrency, 8)
  assert.equal(options.timeoutMinutes, 15)
  assert.equal(options.ideal, false)
  assert.deepEqual(options.roles, ["analyst", "executor", "visual-executor", "critic"])
})

test("parseSquadArgs: flags, roles, quoted verify", () => {
  const options = parseSquadArgs(
    '--agents 4 --roles analyst,executor --concurrency 2 --timeout 5 --base HEAD --verify "npm test" Add auth',
  )
  assert.equal(options.maxTasks, 4)
  assert.deepEqual(options.roles, ["analyst", "executor"])
  assert.equal(options.concurrency, 2)
  assert.equal(options.timeoutMinutes, 5)
  assert.equal(options.base, "HEAD")
  assert.deepEqual(options.verify, ["npm test"])
  assert.equal(options.task, "Add auth")
})

test("parseSquadArgs: leading number is max tasks", () => {
  const options = parseSquadArgs("4 Add JWT auth")
  assert.equal(options.maxTasks, 4)
  assert.equal(options.task, "Add JWT auth")
})

test("parseSquadArgs: ideal keyword and flag", () => {
  assert.equal(parseSquadArgs("Сделай идеально авторизацию").ideal, true)
  assert.equal(parseSquadArgs("--ideal Add auth").ideal, true)
  assert.equal(parseSquadArgs("Add auth").ideal, false)
})

test("parseSquadArgs: invalid input", () => {
  assert.throws(() => parseSquadArgs(""), /Формат/)
  assert.throws(() => parseSquadArgs("--agents 13 Add auth"), /1 до 12/)
  assert.throws(() => parseSquadArgs("--roles nope Add auth"), /Неизвестная роль/)
  assert.throws(() => parseSquadArgs("--no-worktrees Add auth"), /worktree/)
})

test("parseToolInput: structured input", () => {
  const options = parseToolInput({
    task: "Refactor payments",
    agents: 3,
    roles: "executor, critic",
    concurrency: 2,
    timeout_minutes: 10,
    ideal: true,
    verify: ["npm test"],
    keep_worktrees: true,
  })
  assert.equal(options.maxTasks, 3)
  assert.deepEqual(options.roles, ["executor", "critic"])
  assert.equal(options.concurrency, 2)
  assert.equal(options.timeoutMinutes, 10)
  assert.equal(options.ideal, true)
  assert.deepEqual(options.verify, ["npm test"])
  assert.equal(options.keepWorktrees, true)
})

test("status and answer parsers", () => {
  assert.deepEqual(parseStatusArgs(""), {})
  assert.deepEqual(parseStatusArgs("20260101-120000-abcdef12"), { runId: "20260101-120000-abcdef12" })
  assert.deepEqual(parseAnswerArgs("q-123 да, делай"), { questionId: "q-123", text: "да, делай" })
  assert.throws(() => parseAnswerArgs(""), /Формат/)
})
