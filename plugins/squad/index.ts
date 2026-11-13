import { Plugin } from "@opencode/plugin"
import path from "node:path"
import { parseAnswerArgs, parseSquadArgs, parseStatusArgs, parseToolInput, ANSWER_USAGE, STATUS_USAGE, USAGE } from "./src/args.ts"
import { RunStore } from "./src/event-store.ts"
import { orchestrate } from "./src/orchestrator.ts"
import { renderStatus } from "./src/report.ts"
import { answerQuestion, askQuestion } from "./src/questions.ts"
import { isActiveParent, sessionContext } from "./src/registry.ts"
import type { AgentContext } from "./src/session.ts"

function projectOf(ctx: { location?: { project?: { canonical?: string; id?: string }; directory?: string } }): string {
  return ctx.location?.project?.canonical || ctx.location?.directory || process.cwd()
}

function projectIdOf(ctx: { location?: { project?: { id?: string } } }, project: string): string {
  return ctx.location?.project?.id || path.basename(project)
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

export default Plugin.define({
  id: "squad",
  async setup(ctx) {
    const agentContext = ctx as unknown as AgentContext

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "squad",
        description:
          "Запускает автономный отряд: Lid планирует, агенты работают в git worktrees, проверки идут через жёсткий gate, результат — отдельная ветка и отчёт.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Задача для отряда" },
            agents: { type: "integer", minimum: 1, maximum: 12, description: "Максимум задач/агентов. По умолчанию 8." },
            roles: { type: "string", description: "Роли через запятую: analyst, executor, visual-executor, critic" },
            concurrency: { type: "integer", minimum: 1, maximum: 12, description: "Параллельных задач. По умолчанию 8." },
            timeout_minutes: { type: "integer", minimum: 1, maximum: 120, description: "Таймаут одного агента. По умолчанию 15." },
            ideal: { type: "boolean", description: "До 8 раундов доработки вместо 2." },
            base: { type: "string", description: "Базовая ветка/ref. По умолчанию origin/dev, затем origin HEAD, затем HEAD." },
            verify: { type: "array", items: { type: "string" }, description: "Команды verification. Если пусто — из плана/CI/package.json." },
            keep_worktrees: { type: "boolean", description: "Оставить worktrees после run." },
          },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "squad",
            resources: ["run"],
            save: ["run"],
          })
          if (isActiveParent(context.sessionID) || sessionContext(context.sessionID)) {
            throw new Error("Рекурсивный /squad запрещён.")
          }
          const options = parseToolInput(input)
          const project = projectOf(ctx)
          const parent = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
          const model = (parent as { model?: unknown } | undefined)?.model
          const result = await orchestrate({
            ctx: agentContext,
            options,
            project,
            projectId: projectIdOf(ctx, project),
            parentSessionID: context.sessionID,
            model,
            progress: async (status) => {
              try {
                await context.progress({ status })
              } catch {
                // Progress is best-effort.
              }
            },
          })
          return { content: result.summary }
        },
      })

      editor.add({
        name: "squad_status",
        description: "Показывает статус запуска squad: задачи, ветка, gate, вопросы.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            run_id: { type: "string", description: "ID запуска. Без него показывается последний." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const project = projectOf(ctx)
          const state = await RunStore.read(project, (input as { run_id?: string }).run_id)
          if (!state) return { content: "Squad: запусков не найдено." }
          return { content: renderStatus(state) }
        },
      })

      editor.add({
        name: "squad_board",
        description: "Общая доска squad: read, post, ask, answer, status. Доступна только агентам внутри активного run.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "post", "ask", "answer", "status"] },
            text: { type: "string", description: "Текст заметки, вопроса или ответа." },
            to: { type: "string", description: "Адресат заметки." },
            task_id: { type: "string", description: "ID задачи, если нужно явно." },
            question_id: { type: "string", description: "ID вопроса для answer." },
            destructive: { type: "boolean", description: "Вопрос про необратимое действие." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const found = sessionContext(context.sessionID)
          if (!found) return { content: "Squad board доступна только агенту внутри активного run." }
          const { run, taskId } = found
          const value = input as {
            action: string
            text?: string
            to?: string
            task_id?: string
            question_id?: string
            destructive?: boolean
          }
          const from = value.task_id || taskId || "agent"
          if (value.action === "read") {
            return {
              content: `${renderStatus(run.store.state)}\n\n## Board\n${run.store.boardDigest()}\n\n## Questions\n${run.store.questionDigest() || "_нет открытых вопросов_"}`,
            }
          }
          if (value.action === "status") return { content: renderStatus(run.store.state) }
          if (value.action === "post") {
            const text = String(value.text ?? "").trim()
            if (!text) throw new Error("text обязателен для post.")
            const entry = await run.store.addBoard({ from, type: "note", text, to: value.to, taskId: taskId ?? value.task_id })
            return { content: `Записано: ${entry.id}` }
          }
          if (value.action === "ask") {
            const text = String(value.text ?? "").trim()
            if (!text) throw new Error("text обязателен для ask.")
            const question = await askQuestion(agentContext, run, {
              from,
              text,
              destructive: value.destructive === true,
              taskId: taskId ?? value.task_id,
              taskSessionID: context.sessionID,
              parentSessionID: run.parentSessionID,
            })
            return { content: `Вопрос ${question.id} поставлен. Если ответа нет, через 60 секунд его увидит Lid.` }
          }
          if (value.action === "answer") {
            const questionID = String(value.question_id ?? "").trim()
            const text = String(value.text ?? "").trim()
            if (!questionID || !text) throw new Error("question_id и text обязательны для answer.")
            const ok = await answerQuestion(agentContext, questionID, text, from)
            return { content: ok ? `Ответ на ${questionID} записан.` : `Вопрос ${questionID} не найден.` }
          }
          throw new Error(`Неизвестное действие squad_board: ${value.action}`)
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "squad",
        description: "Запустить автономный отряд: /squad [--agents N] [--roles a,b] [--ideal] <задача>",
        execute: async ({ sessionID, prompt }) => {
          try {
            if (isActiveParent(sessionID)) throw new Error("В этой сессии уже идёт squad. Дождись завершения.")
            const options = parseSquadArgs(prompt?.text || "")
            const project = projectOf(ctx)
            const parent = await ctx.session.get({ sessionID }).catch(() => undefined)
            const model = (parent as { model?: unknown } | undefined)?.model
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: старт. Задача: ${options.task.slice(0, 160)}`,
              description: "squad",
            })
            const result = await orchestrate({
              ctx: agentContext,
              options,
              project,
              projectId: projectIdOf(ctx, project),
              parentSessionID: sessionID,
              model,
              progress: async (status) => {
                try {
                  await ctx.session.synthetic({ sessionID, text: status, description: "squad" })
                } catch {
                  // The user may have closed the session; the run keeps going.
                }
              },
            })
            await ctx.session.synthetic({
              sessionID,
              text: `${result.summary}\n\nОтчёт: ${result.reportPath}\nВетка: ${result.branch}`,
              description: "squad",
            })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ошибка — ${errorMessage(error)}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })

      editor.add({
        name: "squad-status",
        description: "Показать статус squad: /squad-status [run-id]",
        execute: async ({ sessionID, prompt }) => {
          try {
            const { runId } = parseStatusArgs(prompt?.text || "")
            const project = projectOf(ctx)
            const state = await RunStore.read(project, runId)
            await ctx.session.synthetic({
              sessionID,
              text: state ? renderStatus(state) : "Squad: запусков не найдено.",
              description: "squad",
            })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ${errorMessage(error)}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })

      editor.add({
        name: "squad-answer",
        description: "Ответить на вопрос squad: /squad-answer <question-id> <ответ>",
        execute: async ({ sessionID, prompt }) => {
          try {
            const { questionId, text } = parseAnswerArgs(prompt?.text || "")
            const ok = await answerQuestion(agentContext, questionId, text, "user")
            await ctx.session.synthetic({
              sessionID,
              text: ok ? `Squad: ответ на ${questionId} записан.` : `Squad: вопрос ${questionId} не найден.`,
              description: "squad",
            })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ${errorMessage(error)}\n${ANSWER_USAGE}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })
    })
  },
})
