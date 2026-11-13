import test from "node:test"
import assert from "node:assert/strict"
import { defaultPlan, extractJson, parsePlan, planToMarkdown, validatePlan } from "../plugins/squad/src/plan.ts"
import type { SquadOptions } from "../plugins/squad/src/types.ts"

function options(overrides: Partial<SquadOptions> = {}): SquadOptions {
  return {
    task: "Add auth",
    maxTasks: 8,
    roles: ["analyst", "executor", "visual-executor", "critic"],
    concurrency: 8,
    timeoutMinutes: 15,
    ideal: false,
    verify: [],
    keepWorktrees: false,
    ...overrides,
  }
}

const valid = {
  summary: "Add auth in two tasks",
  base: "origin/dev",
  ideal: false,
  verification: ["npm test"],
  tasks: [
    {
      id: "api",
      title: "Auth API",
      role: "executor",
      files: ["src/auth/**", "test/auth/**"],
      dependsOn: [],
      instructions: "Implement auth",
      acceptance: ["login works"],
    },
    {
      id: "review",
      title: "Review auth",
      role: "critic",
      files: [],
      dependsOn: ["api"],
      instructions: "Review the auth change",
      acceptance: ["no blockers"],
    },
  ],
}

test("extractJson: fenced block with prose", () => {
  const value = extractJson(`Вот план:\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`)
  assert.equal((value as { summary: string }).summary, valid.summary)
})

test("validatePlan: valid plan", () => {
  const plan = validatePlan(valid, options())
  assert.equal(plan.tasks.length, 2)
  assert.equal(plan.tasks[0]?.id, "api")
  assert.deepEqual(plan.verification, ["npm test"])
})

test("validatePlan: overlapping ownership is rejected", () => {
  const value = structuredClone(valid)
  value.tasks[0]!.files = ["src/auth/**"]
  value.tasks[1] = {
    id: "other",
    title: "Other",
    role: "executor",
    files: ["src/auth/login.ts"],
    dependsOn: [],
    instructions: "Other",
    acceptance: [],
  }
  assert.throws(() => validatePlan(value, options()), /Пересекаются владения/)
})

test("validatePlan: cycles and unknown dependencies are rejected", () => {
  const value = structuredClone(valid)
  value.tasks[0]!.dependsOn = ["review"]
  value.tasks[1]!.dependsOn = ["api"]
  assert.throws(() => validatePlan(value, options()), /Цикл|цикл/)

  const unknown = structuredClone(valid)
  unknown.tasks[0]!.dependsOn = ["missing"]
  assert.throws(() => validatePlan(unknown, options()), /неизвестной/)
})

test("validatePlan: max tasks and allowed roles", () => {
  const tooMany = structuredClone(valid)
  tooMany.tasks = Array.from({ length: 3 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    role: "executor",
    files: [`src/${index}/**`],
    dependsOn: [],
    instructions: "x",
    acceptance: [],
  }))
  assert.throws(() => validatePlan(tooMany, options({ maxTasks: 2 })), /максимум 2/)

  const role = structuredClone(valid)
  role.tasks[0]!.role = "executor"
  assert.throws(() => validatePlan(role, options({ roles: ["analyst"] })), /запрещена/)
})

test("parsePlan and defaultPlan", () => {
  const plan = parsePlan(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, options())
  assert.equal(plan.tasks.length, 2)
  const fallback = defaultPlan(options())
  assert.equal(fallback.tasks.length, 1)
  assert.equal(fallback.tasks[0]?.role, "executor")
  assert.match(planToMarkdown(plan), /Auth API/)
})
