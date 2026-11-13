import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type {
  BoardEntry,
  BoardEntryType,
  GateResult,
  PlanTask,
  RunState,
  SquadPlan,
  SquadQuestion,
  StatusSnapshot,
  TaskState,
} from "./types.ts"
import { planToMarkdown } from "./plan.ts"

const MAX_BOARD_IN_STATE = 500

function now(): string {
  return new Date().toISOString()
}

export function createRunId(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(temp, content, "utf8")
  await rename(temp, file)
}

function taskFromPlan(task: PlanTask): TaskState {
  return {
    id: task.id,
    title: task.title,
    role: task.role,
    status: "pending",
    dependsOn: [...task.dependsOn],
    files: [...task.files],
  }
}

export class RunStore {
  readonly project: string
  readonly runDir: string
  readonly statePath: string
  readonly eventsPath: string
  readonly resultsDir: string
  readonly patchesDir: string
  readonly logsDir: string
  state: RunState

  private constructor(project: string, state: RunState) {
    this.project = project
    this.runDir = state.artifacts.runDir
    this.statePath = path.join(this.runDir, "state.json")
    this.eventsPath = path.join(this.runDir, "events.jsonl")
    this.resultsDir = path.join(this.runDir, "results")
    this.patchesDir = path.join(this.runDir, "patches")
    this.logsDir = path.join(this.runDir, "logs")
    this.state = state
  }

  static async create(input: {
    project: string
    task: string
    base: string
    baseCommit?: string
    baseSource?: string
    branch: string
    runId?: string
  }): Promise<RunStore> {
    const runId = input.runId ?? createRunId()
    const runDir = path.join(input.project, ".squad", "runs", runId)
    await Promise.all([
      ensureDir(path.join(runDir, "results")),
      ensureDir(path.join(runDir, "patches")),
      ensureDir(path.join(runDir, "logs")),
    ])
    const createdAt = now()
    const state: RunState = {
      runId,
      task: input.task,
      project: input.project,
      base: input.base,
      baseCommit: input.baseCommit,
      baseSource: input.baseSource,
      branch: input.branch,
      status: "planning",
      createdAt,
      updatedAt: createdAt,
      tasks: {},
      questions: [],
      board: [],
      artifacts: {
        runDir,
        report: path.join(input.project, "SQUAD_REPORT.md"),
        summary: path.join(runDir, "summary.md"),
      },
      warnings: [],
      commits: [],
    }
    const store = new RunStore(input.project, state)
    await store.persist()
    await store.append("run.created", { task: input.task, base: input.base, branch: input.branch })
    return store
  }

  static async read(project: string, runId?: string): Promise<RunState | undefined> {
    const runsDir = path.join(project, ".squad", "runs")
    if (runId) {
      if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{8}$/.test(runId)) return undefined
      const file = path.join(runsDir, runId, "state.json")
      if (!existsSync(file)) return undefined
      return JSON.parse(await readFile(file, "utf8")) as RunState
    }
    if (!existsSync(runsDir)) return undefined
    const entries = await readdir(runsDir, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const dir of dirs) {
      const file = path.join(runsDir, dir, "state.json")
      if (!existsSync(file)) continue
      return JSON.parse(await readFile(file, "utf8")) as RunState
    }
    return undefined
  }

  static async list(project: string): Promise<RunState[]> {
    const runsDir = path.join(project, ".squad", "runs")
    if (!existsSync(runsDir)) return []
    const entries = await readdir(runsDir, { withFileTypes: true })
    const states: RunState[] = []
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const file = path.join(runsDir, entry.name, "state.json")
      if (!existsSync(file)) continue
      try {
        states.push(JSON.parse(await readFile(file, "utf8")) as RunState)
      } catch {
        // A partially written or corrupt run must not hide the others.
      }
    }
    return states
  }

  static snapshot(state: RunState): StatusSnapshot {
    return {
      runId: state.runId,
      task: state.task,
      status: state.status,
      branch: state.branch,
      base: state.base,
      updatedAt: state.updatedAt,
      gate: state.gate,
      tasks: Object.values(state.tasks),
      questions: state.questions,
      commits: state.commits,
    }
  }

  async persist(): Promise<void> {
    this.state.updatedAt = now()
    await atomicWrite(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  async append(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const event = { ts: now(), type, runId: this.state.runId, ...data }
    await ensureDir(this.runDir)
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8")
    await this.persist()
  }

  async setStatus(status: RunState["status"], error?: string): Promise<void> {
    this.state.status = status
    if (error) this.state.error = error
    if (status === "delivered" || status === "failed" || status === "cancelled") {
      this.state.finishedAt = now()
    }
    await this.append("run.status", { status, error })
  }

  async setPlan(plan: SquadPlan): Promise<void> {
    this.state.plan = plan
    this.state.tasks = Object.fromEntries(plan.tasks.map((task) => [task.id, taskFromPlan(task)]))
    const planJson = path.join(this.runDir, "plan.json")
    const planMarkdown = path.join(this.runDir, "plan.md")
    await writeFile(planJson, `${JSON.stringify(plan, null, 2)}\n`, "utf8")
    await writeFile(planMarkdown, planToMarkdown(plan), "utf8")
    this.state.artifacts.planJson = planJson
    this.state.artifacts.planMarkdown = planMarkdown
    await this.append("plan.created", { tasks: plan.tasks.length, summary: plan.summary })
  }

  async setTask(id: string, patch: Partial<TaskState>): Promise<void> {
    const current = this.state.tasks[id]
    if (!current) throw new Error(`Неизвестная задача "${id}".`)
    this.state.tasks[id] = { ...current, ...patch }
    await this.append("task.updated", { taskId: id, ...patch })
  }

  async setGate(gate: GateResult): Promise<void> {
    this.state.gate = gate
    await this.append("gate.finished", { ok: gate.ok, commands: gate.commands })
  }

  async addBoard(input: {
    from: string
    type: BoardEntryType
    text: string
    to?: string
    taskId?: string
  }): Promise<BoardEntry> {
    const entry: BoardEntry = {
      id: `b-${randomUUID().slice(0, 10)}`,
      ts: now(),
      from: input.from,
      type: input.type,
      text: input.text,
      to: input.to,
      taskId: input.taskId,
    }
    this.state.board.push(entry)
    if (this.state.board.length > MAX_BOARD_IN_STATE) {
      this.state.board = this.state.board.slice(-MAX_BOARD_IN_STATE)
    }
    await this.append("board.posted", { entry })
    return entry
  }

  async addQuestion(input: {
    from: string
    text: string
    destructive: boolean
    taskId?: string
  }): Promise<SquadQuestion> {
    const question: SquadQuestion = {
      id: `q-${randomUUID().slice(0, 10)}`,
      from: input.from,
      text: input.text,
      destructive: input.destructive,
      status: "pending",
      askedAt: now(),
      taskId: input.taskId,
    }
    this.state.questions.push(question)
    await this.addBoard({
      from: input.from,
      type: "question",
      text: input.text,
      taskId: input.taskId,
    })
    await this.append("question.asked", { question })
    return question
  }

  async answerQuestion(
    id: string,
    answer: string,
    answeredBy: string,
    status: "answered" | "assumed" | "stopped" = "answered",
  ): Promise<SquadQuestion | undefined> {
    const question = this.state.questions.find((item) => item.id === id)
    if (!question) return undefined
    question.status = status
    question.answer = answer
    question.answeredBy = answeredBy
    question.answeredAt = now()
    await this.addBoard({
      from: answeredBy,
      type: status === "answered" ? "answer" : "decision",
      text: answer,
      taskId: question.taskId,
    })
    await this.append("question.answered", { id, answer, answeredBy, status })
    return question
  }

  async addCommit(taskId: string, commit: string, title: string): Promise<void> {
    this.state.commits.push({ taskId, commit, title })
    await this.append("commit.created", { taskId, commit, title })
  }

  async addWarning(text: string): Promise<void> {
    this.state.warnings.push(text)
    await this.append("run.warning", { text })
  }

  async writeResult(id: string, text: string): Promise<string> {
    await ensureDir(this.resultsDir)
    const file = path.join(this.resultsDir, `${id}.md`)
    await writeFile(file, text, "utf8")
    return file
  }

  async writeLog(id: string, value: unknown): Promise<string> {
    await ensureDir(this.logsDir)
    const file = path.join(this.logsDir, `${id}.json`)
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    return file
  }

  async writePatch(id: string, patch: string): Promise<string> {
    await ensureDir(this.patchesDir)
    const file = path.join(this.patchesDir, `${id}.patch`)
    await writeFile(file, patch, "utf8")
    return file
  }

  async writeText(name: string, text: string): Promise<string> {
    await ensureDir(this.runDir)
    const file = path.join(this.runDir, name)
    await writeFile(file, text, "utf8")
    return file
  }

  boardDigest(limit = 30): string {
    const entries = this.state.board.slice(-limit)
    if (!entries.length) return "_Доска пуста._"
    return entries
      .map((entry) => `- [${entry.type}] ${entry.from}${entry.to ? ` -> ${entry.to}` : ""}: ${entry.text}`)
      .join("\n")
  }

  questionDigest(): string {
    const questions = this.state.questions.filter((question) => question.status === "pending")
    if (!questions.length) return ""
    return questions.map((question) => `- ${question.id} (${question.from}): ${question.text}`).join("\n")
  }
}
