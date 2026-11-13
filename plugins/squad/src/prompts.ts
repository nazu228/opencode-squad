import type { AgentRunResult, PlanTask, RepoRules, RunState, SquadPlan } from "./types.ts"
import { planDigest } from "./plan.ts"

export interface TaskPromptInput {
  task: PlanTask
  plan: SquadPlan
  rules: RepoRules
  analystDigest: string
  boardDigest: string
  project: string
  worktree: string
  branch: string
  isWorktree: boolean
  runId: string
  runDir: string
}

function readOnly(role: PlanTask["role"]): boolean {
  return role === "analyst" || role === "critic"
}

const BOARD_HELP = `## Общая доска squad

У тебя есть инструмент \`squad_board\`. Используй его для координации:
- \`{"action":"read"}\` — прочитать доску, план и статус run.
- \`{"action":"post","text":"..."}\` — оставить заметку/решение для Lid и других агентов.
- \`{"action":"ask","text":"...","destructive":false}\` — задать вопрос. Вопрос уходит пользователю; если ответа нет, через 60 секунд его увидит Lid. Не блокируй работу: для обратимых решений продолжай с явным assumption; для destructive — остановись и опиши блокер.
- \`{"action":"status"}\` — статус своей задачи и run.

Не превращай доску в чат: только решения, зависимости, вопросы и короткие статусы.`

export function taskPrompt(input: TaskPromptInput): string {
  const { task, plan, rules, analystDigest, boardDigest, project, worktree, branch, isWorktree, runId, runDir } = input
  const roleText = task.role === "analyst"
    ? "Ты — аналитик squad. Только чтение, поиск, git-инспекция и безопасные команды. Не редактируй файлы."
    : task.role === "critic"
      ? "Ты — критик squad. Только чтение и проверка. Не редактируй файлы, не применяй патчи."
      : task.role === "visual-executor"
        ? "Ты — визуальный исполнитель squad. Работай с UI/UX, стилями, компонентами, ассетами и доступностью. Не ломай контракты executor."
        : "Ты — основной исполнитель squad. Пиши код, тесты и исправления в своей зоне."
  const locationText = readOnly(task.role)
    ? `Ты работаешь только на чтение в: ${isWorktree ? worktree : project}\nНе меняй файлы, не коммить, не переключай ветки.`
    : isWorktree
      ? `Ты работаешь в изолированном git worktree: ${worktree}\nВетка: ${branch}\nОсновное рабочее дерево не трогай. Все изменения оставляй в worktree.`
      : `Ты работаешь в общей рабочей копии проекта: ${project}\nНичего не коммить и не переключай ветки.`
  return `${roleText}

## Задача
${task.title}

${task.instructions}

## Твоя зона
Роль: ${task.role}
Файлы/паттерны: ${task.files.length ? task.files.join(", ") : "не заданы"}
Зависимости: ${task.dependsOn.join(", ") || "нет"}
Критерии приёмки:
${task.acceptance.length ? task.acceptance.map((item) => `- ${item}`).join("\n") : "- Сделать задачу корректно и проверяемо"}

## План Lid
${planDigest(plan)}

## Правила проекта
${rules.text || "Правила проекта не найдены."}

## Отчёты аналитиков
${analystDigest || "Аналитики не запускались или отчётов нет."}

## Доска squad
${boardDigest || "Доска пуста."}

${BOARD_HELP}

## Рабочая копия
${locationText}

## Что сделать
1. Прочитай код и правила проекта. Не выдумывай API и команды.
2. Выполни свою часть задачи. Держись своей зоны файлов; если нужен файл вне зоны — опиши зависимость в отчёте/на доске.
3. Запусти релевантные проверки. Если проверка падает — почини или честно зафиксируй.
4. Верни отчёт на русском: что сделано, изменённые файлы, проверки и результат, риски, что осталось.
${readOnly(task.role) ? "5. Ничего не меняй в файлах: твой результат — только отчёт." : "5. Не делай git push, не переписывай историю, не удаляй чужие изменения."}

## Жёсткие правила
- Не читай .env и секреты.
- Не выходи за пределы проекта/worktree.
- Не запускай /squad рекурсивно.
- Не выдумывай результаты проверок.
- Если задача невыполнима — опиши блокер, не имитируй успех.

Артефакты run: ${runDir}
Run: ${runId}
`
}

export function lidFixPrompt(input: {
  state: RunState
  gateOutput: string
  diffStat: string
  changedFiles: string
  rules: RepoRules
  worktree: string
}): string {
  return `Ты — Lid, тимлид squad. Integration gate упал. Твоя работа — починить только интеграционные/проверочные проблемы, не расширять scope.

## Задача run
${input.state.task}

## Ветка
${input.state.branch}
База: ${input.state.base}

## Worktree
${input.worktree}

## Что упало
${input.gateOutput}

## Diff stat
${input.diffStat || "нет diff"}

## Изменённые файлы
${input.changedFiles || "нет"}

## Правила проекта
${input.rules.text || "Правила проекта не найдены."}

## Твои действия
1. Прочитай ошибку и затронутые файлы.
2. Исправь минимально и по делу. Не переписывай чужие изменения без необходимости.
3. Запусти упавшие команды и добейся зелёного результата.
4. Закоммить исправление в текущем worktree. Не делай push.
5. Верни короткий отчёт: что исправлено, какие команды прошли, что осталось рискованным.
`
}

export function lidQuestionPrompt(input: {
  state: RunState
  from: string
  taskId?: string
  question: string
  destructive: boolean
}): string {
  return `Ты — Lid, тимлид squad. Агент задал вопрос по run ${input.state.runId}.

## Задача run
${input.state.task}

## Кто спрашивает
${input.from}${input.taskId ? `, задача ${input.taskId}` : ""}

## Вопрос
${input.question}

## Правила
- Ответь кратко и по делу, максимум 3 предложения.
- Если вопрос destructive (удаление данных, push, deploy, необратимое действие) и ты не уверен — ответь ровно: STOP.
- Если можно продолжить обратимым assumption — сформулируй его явно.
- Не меняй файлы и не запускай инструменты. Только ответ.
`
}

export function renderAgentResult(result: AgentRunResult, task: PlanTask): string {
  return `# ${task.id} — ${task.title}

- Role: ${task.role}
- Status: ${result.status}${result.error ? ` (${result.error})` : ""}
- Session: ${result.sessionID || "-"}
- Duration: ${Math.round((result.durationMs || 0) / 1000)}s

## Result

${result.text || "_Нет текста_"}
`
}
