# Squad v2 — архитектура и эксплуатация

## Принципы

1. **Основное дерево неприкосновенно.** Все пишущие агенты работают в отдельных git worktree. В проект попадают только cherry-pick успешных коммитов в integration-ветку.
2. **Нет зелёного gate — нет успеха.** Run не может быть `delivered`, если verification не прошла.
3. **Упавший агент не интегрируется.** Патч таймаутного/упавшего builder остаётся в worktree для разбора, но не попадает в ветку.
4. **Lid планирует и отвечает.** Lid строит JSON-план, решает вопросы, чинит интеграционные ошибки. Он не пишет основную массу кода.
5. **Один run — один branch + artifacts.** Run закрывается после выдачи; правки — новый run поверх предыдущей ветки.

## Поток

```text
/squad
  -> assertSafeProject + git repo check
  -> resolveBase: origin/dev -> origin HEAD -> HEAD
  -> RunStore: .squad/runs/<run-id>/{state.json,events.jsonl}
  -> Lid plan (team-lid session)
  -> analysts (read-only, repo)
  -> builders (DAG, per-task worktree+branch)
  -> integration branch + cherry-pick successful commits
  -> verification gate
  -> Lid fix rounds (2 / 8 ideal)
  -> critics (read-only, integration worktree)
  -> SQUAD_REPORT.md + branch
  -> cleanup worktrees, keep branch + artifacts
```

## Роли

| Роль | Где работает | Права |
| --- | --- | --- |
| `team-lid` | проект / integration worktree | план, вопросы, фиксы интеграции |
| `analyst` | проект | read-only |
| `executor` | свой worktree | код, тесты |
| `visual-executor` | свой worktree | UI/UX, стили, доступность |
| `critic` | integration worktree | read-only ревью |

## План Lid

```json
{
  "summary": "кратко",
  "base": "origin/dev или null",
  "ideal": false,
  "verification": ["npm test"],
  "tasks": [
    {
      "id": "api",
      "title": "Auth API",
      "role": "executor",
      "files": ["src/auth/**", "test/auth/**"],
      "dependsOn": [],
      "instructions": "что сделать",
      "acceptance": ["что должно быть верно"]
    }
  ]
}
```

Валидация:

- 1–12 задач;
- роли только из разрешённых;
- `dependsOn` без циклов и неизвестных id;
- у builder-задач есть `files`;
- владения builder-задач не пересекаются;
- `verification` может быть пустым — тогда команды определяются по project rules/CI/package.json.

## DAG

`runDag` запускает готовые задачи параллельно до `concurrency`. Задача с упавшей зависимостью получает `skipped`. Analyst-задачи выполняются до builders; critic — после gate.

## Git-модель

- База: `--base`, иначе `origin/dev`, иначе `origin HEAD`, иначе `HEAD`.
- Integration branch: `squad-<slug>-<short>`.
- Agent branch: `squad-<short>-<task>`.
- В worktree создаётся baseline-коммит с untracked-файлами; патч считается от baseline, поэтому untracked-файлы не попадают в патч.
- Успешный builder коммитит `squad(<task>): <title>`; Lid cherry-pick'ает коммит в integration branch.
- При конфликте cherry-pick отменяется, run помечается `failed`, integration worktree остаётся для разбора.

## Verification

Команды берутся в порядке:

1. `--verify`;
2. `plan.verification`;
3. project rules;
4. `package.json` scripts (`test`, `lint`, `typecheck`, `build`);
5. известные стеки (`cargo test`, `go test ./...`, `pytest`, `mvn test`, `gradlew test`).

Gate выполняется в integration worktree. При красном gate Lid получает вывод, чинит интеграцию, коммитит и gate перезапускается. Раундов: 2 по умолчанию, 8 при `--ideal`/«идеально»/решении Lid.

## Доска и вопросы

`squad_board` — инструмент агентов:

- `read` — статус, план, доска, вопросы;
- `post` — заметка;
- `ask` — вопрос с `destructive` флагом;
- `answer` — ответ;
- `status` — статус run.

Вопрос уходит в родительскую сессию. Если ответа нет 60 секунд, вопрос эскалируется Lid. Если Lid не ответил за 2 минуты: обратимый случай — assumption, destructive — stop.

## Event store

`state.json` — снимок для `/squad-status`; `events.jsonl` — append-only журнал. Запись state атомарная (temp + rename). `RunStore.read` валидирует run-id, чтобы не было path traversal.

## Ограничения

- TUI live panel не реализован; есть `/squad-status` и tool `squad_status`.
- Per-role model routing не реализован: все агенты наследуют модель сессии.
- Локальные guards — best-effort permission rules, не sandbox.
- Вопросы не блокируют tool call: агент продолжает с assumption, ответ появляется на доске.
- Плагин не делает push/deploy/merge.

## Диагностика

```bash
opencode plugin list
opencode debug agents
opencode api get "/api/plugin?location[directory]=<project>"
opencode api get "/api/command?location[directory]=<project>"
```

Артефакты: `.squad/runs/<run-id>/`. Логи OpenCode: `~/.local/share/opencode/log/opencode.log`.
