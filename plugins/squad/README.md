# squad plugin v2

Server-плагин OpenCode V2. Регистрирует:

- команду `/squad` — запуск автономного отряда;
- команду `/squad-status` — компактный статус run;
- команду `/squad-answer` — ответ на вопрос агента;
- инструмент `squad` — то же, что `/squad`, для вызова из агента;
- инструмент `squad_status` — статус run;
- инструмент `squad_board` — общая доска агентов.

Точка входа — `index.ts`. Модули в `src/`:

- `args.ts` — парсинг флагов и tool input;
- `plan.ts` — JSON-план Lid, валидация, ownership/DAG;
- `scheduler.ts` — DAG с concurrency;
- `event-store.ts` — `state.json` + `events.jsonl`;
- `git.ts` — worktrees, baseline, patch, cherry-pick, cleanup;
- `gate.ts` — verification-команды;
- `prompts.ts` — prompt-шаблоны;
- `session.ts` — дочерние сессии и таймауты;
- `questions.ts` — 60s -> Lid escalation;
- `registry.ts` — активные run и session map;
- `orchestrator.ts` — полный цикл;
- `report.ts` — summary/report/status.

Плагин не делает push/deploy/merge и не меняет основное рабочее дерево. Результат — integration-ветка, `SQUAD_REPORT.md` и артефакты в `.squad/runs/<run-id>/`.

Полная документация: `../../README.md` и `../../docs/SQUAD.md`.
