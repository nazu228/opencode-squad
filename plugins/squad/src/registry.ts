import type { RunStore } from "./event-store.ts"
import type { SquadQuestion } from "./types.ts"

export interface RunContext {
  runId: string
  project: string
  store: RunStore
  parentSessionID: string
  lidSessionID?: string
  taskSessions: Map<string, string>
}

const runs = new Map<string, RunContext>()
const sessions = new Map<string, { runId: string; taskId?: string }>()
const activeParents = new Set<string>()

export function registerRun(context: RunContext): void {
  runs.set(context.runId, context)
  activeParents.add(context.parentSessionID)
}

export function unregisterRun(runId: string): void {
  const context = runs.get(runId)
  if (context) activeParents.delete(context.parentSessionID)
  runs.delete(runId)
  for (const [sessionID, value] of sessions) {
    if (value.runId === runId) sessions.delete(sessionID)
  }
}

export function registerSession(sessionID: string, runId: string, taskId?: string): void {
  sessions.set(sessionID, { runId, taskId })
  if (!taskId) return
  const context = runs.get(runId)
  if (context) context.taskSessions.set(taskId, sessionID)
}

export function unregisterSession(sessionID: string): void {
  sessions.delete(sessionID)
}

export function sessionContext(sessionID: string): { run: RunContext; taskId?: string } | undefined {
  const value = sessions.get(sessionID)
  if (!value) return undefined
  const run = runs.get(value.runId)
  return run ? { run, taskId: value.taskId } : undefined
}

export function runContext(runId: string): RunContext | undefined {
  return runs.get(runId)
}

export function findQuestion(questionId: string): { run: RunContext; question: SquadQuestion } | undefined {
  for (const run of runs.values()) {
    const question = run.store.state.questions.find((item) => item.id === questionId)
    if (question) return { run, question }
  }
  return undefined
}

export function isActiveParent(sessionID: string): boolean {
  return activeParents.has(sessionID)
}

export function activeRuns(): RunContext[] {
  return [...runs.values()]
}
