import type { AgentRunResult, PlanTask, SquadPlan } from "./types.ts"

export interface SessionRecord {
  id: string
  [key: string]: unknown
}

export interface AgentContext {
  session: {
    create(input: {
      title: string
      agent: string
      parentID?: string
      model?: unknown
      location: { directory: string }
    }): Promise<SessionRecord>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
    interrupt(input: { sessionID: string; resume: boolean }): Promise<unknown>
    context(input: { sessionID: string }): Promise<unknown>
    get(input: { sessionID: string }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<unknown>
  }
}

export interface RunAgentInput {
  task: PlanTask
  plan: SquadPlan
  prompt: string
  location: string
  parentSessionID?: string
  model?: unknown
  timeoutMs: number
  runId: string
  onSession?: (sessionID: string) => void
}

export function extractAssistantText(messages: unknown): string {
  const list = Array.isArray(messages)
    ? messages
    : Array.isArray((messages as { data?: unknown })?.data)
      ? (messages as { data: unknown[] }).data
      : []
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index] as {
      type?: string
      role?: string
      content?: unknown[]
      parts?: unknown[]
    } | undefined
    if (!message) continue
    if (message.type !== "assistant" && message.role !== "assistant") continue
    const content = Array.isArray(message.content)
      ? message.content
      : Array.isArray(message.parts)
        ? message.parts
        : []
    const text = content
      .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void,
): Promise<T | { timedOut: true }> {
  if (!timeoutMs || timeoutMs <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      try {
        await onTimeout()
      } catch {
        // Interrupt is best-effort; the run must continue.
      }
      resolve({ timedOut: true })
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

export async function runAgent(ctx: AgentContext, input: RunAgentInput): Promise<AgentRunResult> {
  const started = Date.now()
  let sessionID = ""
  let status: AgentRunResult["status"] = "ok"
  let error = ""
  let text = ""
  let info: unknown
  let messages: unknown

  try {
    const session = await ctx.session.create({
      title: `squad ${input.runId} ${input.task.id}`,
      agent: input.task.role,
      parentID: input.parentSessionID,
      model: input.model || undefined,
      location: { directory: input.location },
    })
    sessionID = session.id
    input.onSession?.(sessionID)
    await ctx.session.prompt({ sessionID, text: input.prompt })
    const waited = await withTimeout(
      ctx.session.wait({ sessionID }),
      input.timeoutMs,
      () => ctx.session.interrupt({ sessionID, resume: false }).then(() => undefined),
    )
    if (waited && typeof waited === "object" && "timedOut" in waited && waited.timedOut) {
      status = "timeout"
      error = `timeout ${Math.round(input.timeoutMs / 60_000)}m`
    }
    messages = await ctx.session.context({ sessionID })
    text = extractAssistantText(messages)
    if (!text && status === "ok") {
      status = "empty"
      error = "agent returned no text"
    }
    try {
      info = await ctx.session.get({ sessionID })
    } catch {
      // Session info is optional; the run must not fail because cost data is missing.
    }
  } catch (caught) {
    status = "error"
    error = String((caught as Error)?.message ?? caught)
  }

  const record = asRecord(info)
  return {
    id: input.task.id,
    role: input.task.role,
    status,
    text,
    sessionID,
    durationMs: Date.now() - started,
    error: error || undefined,
    cost: record?.cost,
    tokens: record?.tokens,
    messages,
    info,
  }
}

export async function promptSession(
  ctx: AgentContext,
  sessionID: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ status: "ok" | "timeout" | "error"; text: string; error?: string }> {
  try {
    await ctx.session.prompt({ sessionID, text: prompt })
    const waited = await withTimeout(
      ctx.session.wait({ sessionID }),
      timeoutMs,
      () => ctx.session.interrupt({ sessionID, resume: false }).then(() => undefined),
    )
    if (waited && typeof waited === "object" && "timedOut" in waited && waited.timedOut) {
      return { status: "timeout", text: "", error: `timeout ${Math.round(timeoutMs / 1000)}s` }
    }
    const messages = await ctx.session.context({ sessionID })
    const text = extractAssistantText(messages)
    return { status: text ? "ok" : "error", text, error: text ? undefined : "empty response" }
  } catch (caught) {
    return { status: "error", text: "", error: String((caught as Error)?.message ?? caught) }
  }
}

export async function createLidSession(
  ctx: AgentContext,
  input: {
    project: string
    parentSessionID?: string
    model?: unknown
    runId: string
    title: string
  },
): Promise<SessionRecord> {
  return ctx.session.create({
    title: `squad lid ${input.runId} ${input.title}`,
    agent: "team-lid",
    parentID: input.parentSessionID,
    model: input.model || undefined,
    location: { directory: input.project },
  })
}

export async function runLidPrompt(
  ctx: AgentContext,
  input: {
    prompt: string
    project: string
    parentSessionID?: string
    model?: unknown
    timeoutMs: number
    runId: string
    title: string
  },
): Promise<{ status: "ok" | "timeout" | "error"; text: string; sessionID: string; error?: string }> {
  let sessionID = ""
  try {
    const session = await createLidSession(ctx, input)
    sessionID = session.id
    const result = await promptSession(ctx, sessionID, input.prompt, input.timeoutMs)
    return { ...result, sessionID }
  } catch (caught) {
    return { status: "error", text: "", sessionID, error: String((caught as Error)?.message ?? caught) }
  }
}
