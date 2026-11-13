import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { detectVerification, runGate } from "../plugins/squad/src/gate.ts"
import type { RepoRules } from "../plugins/squad/src/types.ts"

const rules: RepoRules = { text: "", verification: [], sources: [] }

test("runGate: pass and fail", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "squad-gate-"))
  try {
    const pass = await runGate(cwd, ['node -e "console.log(1)"'], 10_000)
    assert.equal(pass.ok, true)
    assert.match(pass.output, /\[exit 0\]/)

    const fail = await runGate(cwd, ['node -e "process.exit(3)"'], 10_000)
    assert.equal(fail.ok, false)
    assert.match(fail.output, /\[exit 3\]/)

    const none = await runGate(cwd, [], 10_000)
    assert.equal(none.ok, false)
    assert.match(none.output, /Не найдены команды/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("detectVerification: package manager and explicit commands", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "squad-gate-"))
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node -e 0", lint: "node -e 0" },
    }), "utf8")
    await writeFile(path.join(cwd, "bun.lock"), "", "utf8")
    const commands = await detectVerification(cwd, undefined, rules)
    assert.deepEqual(commands, ["bun run test", "bun run lint"])

    const explicit = await detectVerification(cwd, undefined, rules, ["echo explicit"])
    assert.deepEqual(explicit, ["echo explicit"])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
