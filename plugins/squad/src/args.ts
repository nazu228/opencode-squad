import type { SquadOptions, SquadRole } from "./types.ts"

export const ROLE_ORDER: SquadRole[] = ["analyst", "executor", "visual-executor", "critic"]

const ROLE_ALIASES: Record<string, SquadRole> = {
  analyst: "analyst",
  researcher: "analyst",
  scout: "analyst",
  explore: "analyst",
  executor: "executor",
  coder: "executor",
  builder: "executor",
  dev: "executor",
  "visual-executor": "visual-executor",
  visual: "visual-executor",
  viz: "visual-executor",
  designer: "visual-executor",
  critic: "critic",
  reviewer: "critic",
  review: "critic",
}

export const USAGE = [
  "Формат: /squad [--agents N] [--roles a,b] [--concurrency N] [--timeout N] [--ideal] [--base ref] [--verify \"cmd\"] <задача>",
  "Пример: /squad 4 Добавь JWT-авторизацию и тесты",
  "Пример: /squad --agents 6 --ideal --verify \"npm test\" Отрефактори модуль оплаты",
  "Всегда используется git worktree и отдельная integration-ветка; основное рабочее дерево не меняется.",
].join("\n")

export const STATUS_USAGE = "Формат: /squad-status [run-id]. Без run-id показывается последний запуск."
export const ANSWER_USAGE = "Формат: /squad-answer <question-id> <ответ>."

function normalizeRole(raw: string): SquadRole {
  const value = raw.trim().toLowerCase()
  const role = ROLE_ALIASES[value]
  if (!role) {
    throw new Error(
      `Неизвестная роль "${raw}". Доступны: ${ROLE_ORDER.join(", ")} (алиасы: coder, visual, reviewer, researcher).`,
    )
  }
  return role
}

export function normalizeRoles(values: readonly string[]): SquadRole[] {
  const roles: SquadRole[] = []
  for (const value of values) {
    for (const part of String(value).split(",")) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const role = normalizeRole(trimmed)
      if (!roles.includes(role)) roles.push(role)
    }
  }
  return roles.length ? roles : [...ROLE_ORDER]
}

export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let escaped = false
  const text = String(input ?? "")
  for (const char of text) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (escaped) current += "\\"
  if (quote) throw new Error("Незакрытая кавычка в аргументах.")
  if (current) tokens.push(current)
  return tokens
}

function readValue(tokens: string[], index: number, flag: string): { value: string; next: number } {
  const token = tokens[index] ?? ""
  const eq = token.indexOf("=")
  if (eq >= 0) return { value: token.slice(eq + 1), next: index + 1 }
  const value = tokens[index + 1]
  if (value == null) throw new Error(`Флаг ${flag} требует значение.`)
  return { value, next: index + 2 }
}

function parseInteger(value: string, flag: string): number {
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`Флаг ${flag} требует целое число.`)
  return number
}

function finalize(options: SquadOptions): SquadOptions {
  if (!options.task.trim()) throw new Error("Не указана задача.")
  if (options.maxTasks < 1 || options.maxTasks > 12) {
    throw new Error("Количество задач (--agents) должно быть от 1 до 12.")
  }
  if (options.concurrency < 1) options.concurrency = 8
  if (options.concurrency > 12) options.concurrency = 12
  options.concurrency = Math.min(options.concurrency, options.maxTasks)
  if (options.timeoutMinutes < 1) options.timeoutMinutes = 15
  if (options.timeoutMinutes > 120) options.timeoutMinutes = 120
  if (!options.roles.length) options.roles = [...ROLE_ORDER]
  if (/(^|\s)(идеально|ideal)(\s|$)/i.test(options.task)) options.ideal = true
  return options
}

export function parseSquadArgs(raw: string): SquadOptions {
  let text = String(raw ?? "").trim()
  text = text.replace(/^\/squad\b/i, "").trim()
  if (!text) throw new Error(USAGE)

  const tokens = tokenize(text)
  const options: SquadOptions = {
    task: "",
    maxTasks: 8,
    roles: [],
    concurrency: 8,
    timeoutMinutes: 15,
    ideal: false,
    verify: [],
    keepWorktrees: false,
  }

  let index = 0
  if (tokens[0] && /^\d+$/.test(tokens[0])) {
    options.maxTasks = Number(tokens[0])
    index = 1
  }
  let sawTask = false
  const taskTokens: string[] = []
  while (index < tokens.length) {
    const token = tokens[index] ?? ""
    if (sawTask || !token.startsWith("--")) {
      sawTask = true
      taskTokens.push(token)
      index++
      continue
    }
    const flag = token.split("=")[0]!.toLowerCase()
    if (flag === "--agents" || flag === "--max-tasks") {
      const { value, next } = readValue(tokens, index, flag)
      options.maxTasks = parseInteger(value, flag)
      index = next
      continue
    }
    if (flag === "--roles") {
      const { value, next } = readValue(tokens, index, flag)
      options.roles = normalizeRoles([value])
      index = next
      continue
    }
    if (flag === "--concurrency") {
      const { value, next } = readValue(tokens, index, flag)
      options.concurrency = parseInteger(value, flag)
      index = next
      continue
    }
    if (flag === "--timeout") {
      const { value, next } = readValue(tokens, index, flag)
      options.timeoutMinutes = parseInteger(value, flag)
      index = next
      continue
    }
    if (flag === "--base") {
      const { value, next } = readValue(tokens, index, flag)
      options.base = value
      index = next
      continue
    }
    if (flag === "--verify") {
      const { value, next } = readValue(tokens, index, flag)
      if (value.trim()) options.verify.push(value.trim())
      index = next
      continue
    }
    if (flag === "--ideal") {
      options.ideal = true
      index++
      continue
    }
    if (flag === "--keep-worktrees") {
      options.keepWorktrees = true
      index++
      continue
    }
    if (flag === "--no-worktrees") {
      throw new Error("Squad v2 всегда использует worktree и отдельную ветку. Убери --no-worktrees.")
    }
    if (flag === "--help") {
      throw new Error(USAGE)
    }
    throw new Error(`Неизвестный флаг "${token}".\n${USAGE}`)
  }

  options.task = taskTokens.join(" ").trim()
  return finalize(options)
}

export function parseToolInput(input: unknown): SquadOptions {
  const value = (input ?? {}) as Record<string, unknown>
  const task = String(value.task ?? "").trim()
  if (!task) throw new Error("task обязателен.")
  const rolesValue = value.roles
  const roles = rolesValue == null
    ? [...ROLE_ORDER]
    : normalizeRoles(Array.isArray(rolesValue) ? rolesValue.map(String) : [String(rolesValue)])
  const verifyValue = value.verify
  const verify = verifyValue == null
    ? []
    : Array.isArray(verifyValue)
      ? verifyValue.map(String).filter(Boolean)
      : [String(verifyValue)].filter(Boolean)
  const options: SquadOptions = {
    task,
    maxTasks: value.agents == null ? 8 : Number(value.agents),
    roles,
    concurrency: value.concurrency == null ? 8 : Number(value.concurrency),
    timeoutMinutes: value.timeout_minutes == null ? 15 : Number(value.timeout_minutes),
    ideal: value.ideal === true,
    base: value.base == null ? undefined : String(value.base),
    verify,
    keepWorktrees: value.keep_worktrees === true,
  }
  return finalize(options)
}

export function parseStatusArgs(raw: string): { runId?: string } {
  const text = String(raw ?? "").trim().replace(/^\/squad-status\b/i, "").trim()
  if (!text) return {}
  const [runId, ...rest] = tokenize(text)
  if (!runId || rest.length) throw new Error(STATUS_USAGE)
  return { runId }
}

export function parseAnswerArgs(raw: string): { questionId: string; text: string } {
  const text = String(raw ?? "").trim().replace(/^\/squad-answer\b/i, "").trim()
  if (!text) throw new Error(ANSWER_USAGE)
  const tokens = tokenize(text)
  const questionId = tokens.shift()
  if (!questionId) throw new Error(ANSWER_USAGE)
  const answer = tokens.join(" ").trim()
  if (!answer) throw new Error(ANSWER_USAGE)
  return { questionId, text: answer }
}

export function buildInstances(count: number, roles: readonly SquadRole[]): { role: SquadRole; index: number; id: string }[] {
  const order = roles.length ? [...roles] : [...ROLE_ORDER]
  const counts = new Map<SquadRole, number>()
  const instances: { role: SquadRole; index: number; id: string }[] = []
  for (let i = 0; i < count; i++) {
    const role = order[i % order.length]!
    const current = (counts.get(role) ?? 0) + 1
    counts.set(role, current)
    instances.push({ role, index: current, id: `${role}-${current}` })
  }
  return instances
}
