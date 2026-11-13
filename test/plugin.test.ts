import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../plugins/squad/index.ts"

test("plugin registers tools and commands", async () => {
  const tools: { name: string }[] = []
  const commands: { name: string }[] = []
  const ctx = {
    tool: {
      transform: async (fn: (editor: { add: (tool: { name: string }) => void }) => void) => {
        fn({ add: (tool) => tools.push(tool) })
      },
    },
    command: {
      transform: async (fn: (editor: { add: (command: { name: string }) => void }) => void) => {
        fn({ add: (command) => commands.push(command) })
      },
    },
  }
  await plugin.setup(ctx as never)
  assert.deepEqual(tools.map((tool) => tool.name), ["squad", "squad_status", "squad_board"])
  assert.deepEqual(commands.map((command) => command.name), ["squad", "squad-status", "squad-answer"])
})
