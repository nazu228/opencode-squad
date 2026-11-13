export interface DagTask {
  id: string
  dependsOn: string[]
}

export type DagStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped"

export interface DagResult<T> {
  statuses: Record<string, DagStatus>
  results: Record<string, T>
  errors: Record<string, string>
}

export interface DagHooks {
  onStatus?: (taskId: string, status: DagStatus, error?: string) => void | Promise<void>
}

export function validateDag(tasks: readonly DagTask[]): void {
  const ids = new Set(tasks.map((task) => task.id))
  if (ids.size !== tasks.length) throw new Error("DAG: ID задач должны быть уникальны.")
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`DAG: "${task.id}" зависит от неизвестной "${dependency}".`)
    }
  }
  topologicalOrder(tasks)
}

export function topologicalOrder(tasks: readonly DagTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const order: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`DAG: цикл зависимостей вокруг "${id}".`)
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    order.push(id)
  }
  for (const task of tasks) visit(task.id)
  return order
}

export async function runDag<T>(
  tasks: readonly DagTask[],
  concurrency: number,
  run: (task: DagTask) => Promise<T>,
  hooks: DagHooks = {},
): Promise<DagResult<T>> {
  validateDag(tasks)
  const statuses: Record<string, DagStatus> = {}
  const results: Record<string, T> = {}
  const errors: Record<string, string> = {}
  for (const task of tasks) statuses[task.id] = "pending"

  const notify = async (taskId: string, status: DagStatus, error?: string): Promise<void> => {
    statuses[taskId] = status
    if (error) errors[taskId] = error
    await hooks.onStatus?.(taskId, status, error)
  }

  const running = new Map<string, Promise<void>>()
  const limit = Math.max(1, Math.min(concurrency, tasks.length))
  const byId = new Map(tasks.map((task) => [task.id, task]))

  for (;;) {
    let changed = false
    for (const task of tasks) {
      if (statuses[task.id] !== "pending") continue
      const dependencies = task.dependsOn.map((id) => statuses[id] ?? "pending")
      if (dependencies.some((status) => status === "failed" || status === "skipped")) {
        await notify(task.id, "skipped", "Зависимость не выполнена.")
        changed = true
      } else if (dependencies.every((status) => status === "done")) {
        await notify(task.id, "ready")
        changed = true
      }
    }

    for (const task of tasks) {
      if (running.size >= limit) break
      if (statuses[task.id] !== "ready") continue
      statuses[task.id] = "running"
      const promise = (async () => {
        try {
          const value = await run(byId.get(task.id)!)
          results[task.id] = value
          await notify(task.id, "done")
        } catch (error) {
          await notify(task.id, "failed", String((error as Error)?.message ?? error))
        } finally {
          running.delete(task.id)
        }
      })()
      running.set(task.id, promise)
    }

    if (!running.size) {
      const pending = tasks.filter((task) => statuses[task.id] === "pending")
      if (!pending.length) break
      if (!changed) {
        for (const task of pending) {
          await notify(task.id, "failed", "DAG застрял: зависимость не стала done.")
        }
        break
      }
      continue
    }

    await Promise.race([...running.values()])
  }

  return { statuses, results, errors }
}
