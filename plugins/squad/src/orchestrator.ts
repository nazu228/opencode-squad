import path from "node:path"
import { writeFile } from "node:fs/promises"
import { createRunId, RunStore } from "./event-store.ts"
import {
  assertSafeProject,
  baselineWorktree,
  branchName,
  capturePatch,
  changedFiles as changedFilesInDiff,
  cherryPick,
  commitWorktree,
  createWorktree,
  currentHead,
  deleteBranch,
  diffStat,
  ensureExclude,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  resolveBase,
  safeName,
  syncUntracked,
  worktreeRoot,
  type BaseInfo,
} from "./git.ts"
import { readRules, repoBrief } from "./context.ts"
import { defaultPlan, parsePlan, planPrompt, planRetryPrompt } from "./plan.ts"
import { runDag, topologicalOrder } from "./scheduler.ts"
import { createLidSession, promptSession, runAgent, type AgentContext } from "./session.ts"
import { lidFixPrompt, taskPrompt } from "./prompts.ts"
import { detectVerification, runGate } from "./gate.ts"
import { agentResultMarkdown, renderReport, renderSummary } from "./report.ts"
import { cleanupRun } from "./questions.ts"
import { registerRun, registerSession, unregisterRun, type RunContext } from "./registry.ts"
import type {
  AgentRunResult,
  PlanTask,
  RepoRules,
  RunResult,
  RunState,
  SquadOptions,
  SquadPlan,
  TaskState,
} from "./types.ts"

const PLAN_TIMEOUT_MS = 6 * 60_000
const PLAN_ATTEMPTS = 3
const CRITIC_TIMEOUT_MS = 10 * 60_000

export interface OrchestratorInput {
  ctx: AgentContext
  options: SquadOptions
  project: string
  projectId: string
  parentSessionID?: string
  model?: unknown
  progress: (message: string) => Promise<void> | void
}

function now(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

async function progress(input: OrchestratorInput, message: string): Promise<void> {
  try {
    await input.progress(message)
  } catch {
    // Progress is cosmetic; never fail the run because the client closed.
  }
}

function taskById(tasks: readonly PlanTask[], id: string): PlanTask | undefined {
  return tasks.find((task) => task.id === id)
}

function digestResults(results: Map<string, AgentRunResult>, max = 60_000): string {
  const parts: string[] = []
  let length = 0
  for (const [id, result] of results) {
    if (result.status !== "ok" || !result.text) continue
    const chunk = `### ${id}\n${result.text.slice(0, 6000)}\n`
    if (length + chunk.length > max) break
    parts.push(chunk)
    length += chunk.length
  }
  return parts.join("\n").trim()
}

async function writeAgentArtifacts(store: RunStore, task: TaskState, result: AgentRunResult): Promise<void> {
  await store.writeResult(task.id, agentResultMarkdown(result, task))
  await store.writeLog(task.id, {
    sessionID: result.sessionID,
    info: result.info,
    messages: result.messages,
  })
}

async function runReadOnlyPhase(input: OrchestratorInput & {
  run: RunContext
  tasks: PlanTask[]
  plan: SquadPlan
  rules: RepoRules
  location: string
  isWorktree: boolean
  analystDigest: string
  label: string
}): Promise<Map<string, AgentRunResult>> {
  const results = new Map<string, AgentRunResult>()
  if (!input.tasks.length) return results
  const ids = new Set(input.tasks.map((task) => task.id))
  const dagTasks = input.tasks.map((task) => ({
    id: task.id,
    dependsOn: task.dependsOn.filter((dependency) => ids.has(dependency)),
  }))
  await runDag(dagTasks, input.options.concurrency, async (dagTask) => {
    const task = taskById(input.tasks, dagTask.id)!
    await input.run.store.setTask(task.id, { status: "running", startedAt: now() })
    await progress(input, `Squad: ${input.label} ${task.id}`)
    const prompt = taskPrompt({
      task,
      plan: input.plan,
      rules: input.rules,
      analystDigest: input.analystDigest,
      boardDigest: input.run.store.boardDigest(),
      project: input.project,
      worktree: input.location,
      branch: input.run.store.state.branch,
      isWorktree: input.isWorktree,
      runId: input.run.runId,
      runDir: input.run.store.state.artifacts.runDir,
    })
    const result = await runAgent(input.ctx, {
      task,
      plan: input.plan,
      prompt,
      location: input.location,
      parentSessionID: input.parentSessionID,
      model: input.model,
      timeoutMs: task.role === "critic" ? CRITIC_TIMEOUT_MS : input.options.timeoutMinutes * 60_000,
      runId: input.run.runId,
      onSession: (sessionID) => registerSession(sessionID, input.run.runId, task.id),
    })
    results.set(task.id, result)
    const stateTask = input.run.store.state.tasks[task.id]!
    await writeAgentArtifacts(input.run.store, stateTask, result)
    await input.run.store.setTask(task.id, {
      status: result.status === "ok" ? "done" : "failed",
      sessionID: result.sessionID,
      error: result.error,
      finishedAt: now(),
    })
    await input.run.store.addBoard({
      from: task.id,
      type: result.status === "ok" ? "status" : "decision",
      text: result.status === "ok" ? "готово" : `ошибка: ${result.error ?? result.status}`,
      taskId: task.id,
    })
    if (result.status !== "ok") throw new Error(`${task.id}: ${result.error ?? result.status}`)
    return result
  }, {
    onStatus: async (taskID, status) => {
      if (status !== "skipped") return
      await input.run.store.setTask(taskID, {
        status: "skipped",
        error: "Зависимость не выполнена.",
        finishedAt: now(),
      })
    },
  })
  return results
}

function crossPhaseFailed(task: PlanTask, plan: SquadPlan, state: RunState): boolean {
  return task.dependsOn.some((dependency) => {
    const dep = plan.tasks.find((item) => item.id === dependency)
    if (!dep) return false
    if (dep.role !== "analyst" && dep.role !== "critic") return false
    const status = state.tasks[dependency]?.status
    return status === "failed" || status === "skipped"
  })
}

async function runBuilderPhase(input: OrchestratorInput & {
  run: RunContext
  tasks: PlanTask[]
  plan: SquadPlan
  rules: RepoRules
  analystDigest: string
  baseInfo: BaseInfo
}): Promise<Map<string, AgentRunResult>> {
  const results = new Map<string, AgentRunResult>()
  if (!input.tasks.length) return results
  const ids = new Set(input.tasks.map((task) => task.id))
  const blocked = new Set<string>()
  for (const task of input.tasks) {
    if (crossPhaseFailed(task, input.plan, input.run.store.state)) blocked.add(task.id)
  }
  const dagTasks = input.tasks.map((task) => ({
    id: task.id,
    dependsOn: blocked.has(task.id) ? [] : task.dependsOn.filter((dependency) => ids.has(dependency)),
  }))
  await runDag(dagTasks, input.options.concurrency, async (dagTask) => {
    const task = taskById(input.tasks, dagTask.id)!
    if (blocked.has(task.id)) {
      await input.run.store.setTask(task.id, {
        status: "skipped",
        error: "Зависимость аналитика не выполнена.",
        finishedAt: now(),
      })
      throw new Error(`${task.id}: dependency failed`)
    }
    await input.run.store.setTask(task.id, { status: "running", startedAt: now() })
    await progress(input, `Squad: executor ${task.id}`)
    const shortRun = safeName(input.run.runId.split("-").at(-1) ?? input.run.runId, "run").slice(0, 8)
    const agentBranch = `squad-${shortRun}-${safeName(task.id, "task")}`
    const worktree = path.join(worktreeRoot(input.projectId, input.run.runId), safeName(task.id, "task"))
    let baseline = ""
    try {
      await createWorktree(input.project, worktree, agentBranch, input.baseInfo.ref)
      await syncUntracked(input.project, worktree)
      baseline = await baselineWorktree(worktree)
      await input.run.store.setTask(task.id, { worktree, branch: agentBranch })
    } catch (error) {
      await input.run.store.setTask(task.id, {
        status: "failed",
        error: `worktree: ${errorMessage(error)}`,
        finishedAt: now(),
      })
      throw error
    }
    const prompt = taskPrompt({
      task,
      plan: input.plan,
      rules: input.rules,
      analystDigest: input.analystDigest,
      boardDigest: input.run.store.boardDigest(),
      project: input.project,
      worktree,
      branch: agentBranch,
      isWorktree: true,
      runId: input.run.runId,
      runDir: input.run.store.state.artifacts.runDir,
    })
    const result = await runAgent(input.ctx, {
      task,
      plan: input.plan,
      prompt,
      location: worktree,
      parentSessionID: input.parentSessionID,
      model: input.model,
      timeoutMs: input.options.timeoutMinutes * 60_000,
      runId: input.run.runId,
      onSession: (sessionID) => registerSession(sessionID, input.run.runId, task.id),
    })
    results.set(task.id, result)
    const stateTask = input.run.store.state.tasks[task.id]!
    await writeAgentArtifacts(input.run.store, stateTask, result)
    await input.run.store.setTask(task.id, {
      sessionID: result.sessionID,
      worktree,
      branch: agentBranch,
    })
    if (result.status !== "ok" || !result.text.trim()) {
      await input.run.store.setTask(task.id, {
        status: "failed",
        error: result.error ?? "agent returned no usable result",
        finishedAt: now(),
      })
      await input.run.store.addBoard({
        from: task.id,
        type: "decision",
        text: `не интегрирую: ${result.error ?? result.status}`,
        taskId: task.id,
      })
      throw new Error(`${task.id}: ${result.error ?? result.status}`)
    }
    let commit: string | null = null
    try {
      commit = await commitWorktree(worktree, `squad(${task.id}): ${task.title}`)
      if (!commit) {
        const head = await currentHead(worktree)
        if (head !== baseline) commit = head
      }
    } catch (error) {
      await input.run.store.setTask(task.id, {
        status: "failed",
        error: `commit: ${errorMessage(error)}`,
        finishedAt: now(),
      })
      throw error
    }
    if (!commit) {
      await input.run.store.setTask(task.id, {
        status: "failed",
        error: "Агент не изменил ни одного файла.",
        finishedAt: now(),
      })
      throw new Error(`${task.id}: no changes`)
    }
    const patch = await capturePatch(worktree, baseline)
    const patchPath = await input.run.store.writePatch(task.id, patch)
    await input.run.store.setTask(task.id, {
      status: "done",
      commit,
      patch: patchPath,
      finishedAt: now(),
    })
    await input.run.store.addCommit(task.id, commit, task.title)
    await input.run.store.addBoard({
      from: task.id,
      type: "status",
      text: `готово, commit ${commit.slice(0, 8)}`,
      taskId: task.id,
    })
    return result
  }, {
    onStatus: async (taskID, status) => {
      if (status !== "skipped") return
      await input.run.store.setTask(taskID, {
        status: "skipped",
        error: "Зависимость не выполнена.",
        finishedAt: now(),
      })
    },
  })
  return results
}

async function createIntegration(input: OrchestratorInput & {
  run: RunContext
  plan: SquadPlan
  builders: PlanTask[]
  baseInfo: BaseInfo
}): Promise<{ dir: string; error?: string }> {
  const dir = path.join(worktreeRoot(input.projectId, input.run.runId), "integration")
  try {
    await createWorktree(input.project, dir, input.run.store.state.branch, input.baseInfo.ref)
  } catch (error) {
    return { dir, error: errorMessage(error) }
  }
  input.run.store.state.integrationWorktree = dir
  await input.run.store.append("integration.created", { dir, branch: input.run.store.state.branch })
  const order = topologicalOrder(input.builders.map((task) => ({ id: task.id, dependsOn: task.dependsOn })))
  for (const id of order) {
    const task = input.builders.find((item) => item.id === id)
    const stateTask = input.run.store.state.tasks[id]
    if (!task || !stateTask || stateTask.status !== "done" || !stateTask.commit) continue
    const picked = await cherryPick(dir, stateTask.commit)
    if (!picked.ok) {
      return { dir, error: `cherry-pick ${id}: ${picked.error ?? "conflict"}` }
    }
  }
  input.run.store.state.diffStat = await diffStat(dir, input.baseInfo.ref)
  input.run.store.state.changedFiles = await changedFilesInDiff(dir, input.baseInfo.ref)
  await input.run.store.append("integration.updated", {
    commits: input.run.store.state.commits.length,
    changedFiles: input.run.store.state.changedFiles,
  })
  return { dir }
}

async function fixGateWithLid(input: OrchestratorInput & {
  run: RunContext
  rules: RepoRules
  integrationDir: string
  ideal: boolean
  gateOutput: string
  diffStat: string
  changedFiles: string
}): Promise<Awaited<ReturnType<typeof runGate>>> {
  const rounds = input.ideal ? 8 : 2
  let gate = await runGate(input.integrationDir, input.run.store.state.gate?.commands ?? [], input.options.timeoutMinutes * 60_000)
  for (let round = 1; round <= rounds && !gate.ok; round++) {
    await progress(input, `Squad: Lid fix verification, round ${round}`)
    let lidSessionID = ""
    try {
      const lid = await createLidSession(input.ctx, {
        project: input.integrationDir,
        parentSessionID: input.parentSessionID,
        model: input.model,
        runId: input.run.runId,
        title: `fix-${round}`,
      })
      lidSessionID = lid.id
      registerSession(lid.id, input.run.runId)
      const result = await promptSession(
        input.ctx,
        lidSessionID,
        lidFixPrompt({
          state: input.run.store.state,
          gateOutput: gate.output,
          diffStat: input.diffStat,
          changedFiles: input.changedFiles,
          rules: input.rules,
          worktree: input.integrationDir,
        }),
        input.options.timeoutMinutes * 60_000,
      )
      if (result.status !== "ok" || !result.text.trim() || /^\s*STOP\b/i.test(result.text)) break
      const before = await currentHead(input.integrationDir)
      await commitWorktree(input.integrationDir, `squad: verification fix ${round}`)
      const after = await currentHead(input.integrationDir)
      if (after !== before) {
        await input.run.store.addCommit("lid", after, `verification fix ${round}`)
        input.run.store.state.diffStat = await diffStat(input.integrationDir, input.run.store.state.base)
        input.run.store.state.changedFiles = await changedFilesInDiff(input.integrationDir, input.run.store.state.base)
      }
    } catch (error) {
      await input.run.store.addWarning(`Lid fix round ${round}: ${errorMessage(error)}`)
      break
    }
    gate = await runGate(input.integrationDir, gate.commands, input.options.timeoutMinutes * 60_000)
    input.run.store.state.gate = gate
    await input.run.store.setGate(gate)
  }
  return gate
}

async function finalize(input: OrchestratorInput & {
  run: RunContext
  ideal: boolean
  analystDigest: string
  criticDigest: string
  delivered: boolean
  error?: string
}): Promise<RunResult> {
  const { run, store } = { run: input.run, store: input.run.store }
  const status = input.delivered ? "delivered" : "failed"
  await store.setStatus(status, input.error)
  if (store.state.integrationWorktree) {
    try {
      store.state.diffStat = await diffStat(store.state.integrationWorktree, store.state.base)
      store.state.changedFiles = await changedFilesInDiff(store.state.integrationWorktree, store.state.base)
    } catch {
      // The diff may be unavailable after a failed worktree; the report still has commits.
    }
    await store.append("run.diff", {
      diffStat: store.state.diffStat ?? "",
      changedFiles: store.state.changedFiles ?? [],
    })
  }
  const summary = renderSummary(store.state)
  await store.writeText("summary.md", summary)
  const report = renderReport(store.state, {
    analystDigest: input.analystDigest,
    criticDigest: input.criticDigest,
  })
  await writeFile(store.state.artifacts.report, report, "utf8")
  await store.writeText("SQUAD_REPORT.md", report)
  await progress(input, `Squad: ${status}. Ветка: ${store.state.branch}`)
  if (input.options.keepWorktrees) {
    await store.addWarning("Worktrees оставлены по флагу --keep-worktrees.")
  }
  for (const task of Object.values(store.state.tasks)) {
    if (!task.worktree) continue
    if (input.options.keepWorktrees || task.status !== "done") continue
    await removeWorktree(input.project, task.worktree)
    if (task.branch) await deleteBranch(input.project, task.branch)
  }
  if (store.state.integrationWorktree && !input.options.keepWorktrees && input.delivered) {
    await removeWorktree(input.project, store.state.integrationWorktree)
  }
  await pruneWorktrees(input.project)
  cleanupRun(run.runId)
  unregisterRun(run.runId)
  return {
    runId: store.state.runId,
    status: store.state.status,
    summary,
    reportPath: store.state.artifacts.report,
    branch: store.state.branch,
    runDir: store.state.artifacts.runDir,
    error: store.state.error,
  }
}

export async function orchestrate(input: OrchestratorInput): Promise<RunResult> {
  assertSafeProject(input.project)
  const project = await repoRoot(input.project)
  await ensureExclude(project, [".squad/", "SQUAD_REPORT.md"])
  const runId = createRunId()
  const branch = branchName(input.options.task, runId)
  let baseInfo: BaseInfo = await resolveBase(project, input.options.base)
  const store = await RunStore.create({
    project,
    task: input.options.task,
    base: baseInfo.ref,
    baseSource: baseInfo.source,
    branch,
    runId,
  })
  const run: RunContext = {
    runId,
    project,
    store,
    parentSessionID: input.parentSessionID ?? "",
    taskSessions: new Map(),
  }
  registerRun(run)
  const ctxInput = { ...input, project }
  try {
    await store.setStatus("planning")
    await progress(ctxInput, `Squad: старт ${runId}`)
    const rules = await readRules(project)
    const brief = await repoBrief(project)
    const lid = await createLidSession(input.ctx, {
      project,
      parentSessionID: input.parentSessionID,
      model: input.model,
      runId,
      title: "plan",
    })
    run.lidSessionID = lid.id
    registerSession(lid.id, runId)
    let plan: SquadPlan | undefined
    let planError = ""
    for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
      const prompt = attempt === 1
        ? planPrompt({ task: input.options.task, rules, repoBrief: brief, options: input.options })
        : planRetryPrompt(planError)
      const result = await promptSession(input.ctx, lid.id, prompt, PLAN_TIMEOUT_MS)
      if (result.status !== "ok" || !result.text.trim()) {
        planError = result.error ?? "Lid вернул пустой ответ."
        continue
      }
      try {
        plan = parsePlan(result.text, input.options)
        break
      } catch (error) {
        planError = errorMessage(error)
      }
    }
    if (!plan) {
      plan = defaultPlan(input.options)
      await store.addWarning(`Lid не дал валидный план: ${planError}. Использован fallback.`)
    }
    if (plan.base && !input.options.base && plan.base !== baseInfo.ref) {
      try {
        baseInfo = await resolveBase(project, plan.base)
        store.state.base = baseInfo.ref
        store.state.baseSource = baseInfo.source
        await store.append("run.base", { base: baseInfo.ref, source: baseInfo.source })
      } catch (error) {
        await store.addWarning(`База из плана недоступна: ${errorMessage(error)}`)
      }
    }
    await store.setPlan(plan)
    const ideal = input.options.ideal || plan.ideal === true
    await store.setStatus("running")
    await progress(ctxInput, `Squad: план ${plan.tasks.length} задач, база ${baseInfo.ref}`)

    const analysts = plan.tasks.filter((task) => task.role === "analyst")
    const analystResults = await runReadOnlyPhase({
      ...ctxInput,
      run,
      tasks: analysts,
      plan,
      rules,
      location: project,
      isWorktree: false,
      analystDigest: "",
      label: "analyst",
    })
    const analystDigest = digestResults(analystResults)

    const builders = plan.tasks.filter((task) => task.role === "executor" || task.role === "visual-executor")
    const builderResults = await runBuilderPhase({
      ...ctxInput,
      run,
      tasks: builders,
      plan,
      rules,
      analystDigest,
      baseInfo,
    })

    let integrationError: string | undefined
    let gate = undefined as Awaited<ReturnType<typeof runGate>> | undefined
    if (builders.length) {
      await progress(ctxInput, "Squad: интеграция")
      const integration = await createIntegration({ ...ctxInput, run, plan, builders, baseInfo })
      integrationError = integration.error
      if (!integrationError) {
        const verification = await detectVerification(project, plan, rules, input.options.verify)
        await store.setStatus("verifying")
        gate = await runGate(integration.dir, verification, input.options.timeoutMinutes * 60_000)
        store.state.gate = gate
        await store.setGate(gate)
        if (!gate.ok) {
          gate = await fixGateWithLid({
            ...ctxInput,
            run,
            rules,
            integrationDir: integration.dir,
            ideal,
            gateOutput: gate.output,
            diffStat: store.state.diffStat ?? "",
            changedFiles: (store.state.changedFiles ?? []).join("\n"),
          })
          store.state.gate = gate
          await store.setGate(gate)
        }
      }
    }

    const critics = plan.tasks.filter((task) => task.role === "critic")
    const criticDigestPrefix = [
      digestResults(builderResults),
      gate ? `## Verification\n${gate.output}` : "",
      integrationError ? `## Integration error\n${integrationError}` : "",
    ].filter(Boolean).join("\n\n")
    const criticResults = await runReadOnlyPhase({
      ...ctxInput,
      run,
      tasks: critics,
      plan,
      rules,
      location: store.state.integrationWorktree ?? project,
      isWorktree: Boolean(store.state.integrationWorktree),
      analystDigest: criticDigestPrefix,
      label: "critic",
    })
    const criticDigest = digestResults(criticResults)

    const builderFailed = builders.some((task) => store.state.tasks[task.id]?.status !== "done")
    const snapshot = store.state
    const delivered = !integrationError && !builderFailed && (builders.length === 0 || gate?.ok === true)
    const failure = integrationError ?? (builderFailed ? "Часть builder-задач не выполнена." : gate && !gate.ok ? "Verification gate красный." : undefined)
    return await finalize({
      ...ctxInput,
      run,
      ideal,
      analystDigest,
      criticDigest,
      delivered,
      error: failure,
    })
  } catch (error) {
    try {
      await store.setStatus("failed", errorMessage(error))
      const report = renderReport(store.state)
      await writeFile(store.state.artifacts.report, report, "utf8")
      await store.writeText("SQUAD_REPORT.md", report)
      await store.writeText("summary.md", renderSummary(store.state))
    } catch {
      // The original failure is more useful than a secondary report failure.
    }
    cleanupRun(runId)
    unregisterRun(runId)
    return {
      runId,
      status: store.state.status,
      summary: renderSummary(store.state),
      reportPath: store.state.artifacts.report,
      branch: store.state.branch,
      runDir: store.state.artifacts.runDir,
      error: errorMessage(error),
    }
  }
}
