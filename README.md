# OpenCode Squad v2

Автономный мультиагентный оркестратор для [OpenCode](https://opencode.ai) V2.

Один `/squad` запускает Lid-планировщика, аналитиков, исполнителей, визуального исполнителя и критиков. Каждый пишущий агент работает в отдельном git worktree. Lid собирает коммиты в одну integration-ветку, запускает жёсткий verification gate и пишет `SQUAD_REPORT.md`.

Главное отличие от v1: **основное рабочее дерево не меняется**, патчи упавших агентов не интегрируются, а результат всегда проходит проверки или run помечается `failed`.

## Требования

- OpenCode V2
- Git 2.40+
- Windows 10/11, macOS или Linux
- Node.js 24+ для тестов самого плагина (runtime OpenCode использует свой Bun)

## Установка

```powershell
git clone https://github.com/nazu228/opencode-squad.git
cd opencode-squad
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Установщик копирует `agents/*.md` и `plugins/squad` в `~/.config/opencode`, делая backup предыдущей версии.

После установки:

```text
/reload
```

Проверка:

```bash
opencode plugin list
opencode debug agents
```

## Быстрый старт

```text
/squad Добавь JWT-авторизацию и тесты
/squad 4 Отрефактори модуль оплаты
/squad --agents 6 --ideal --verify "npm test" Сделай страницу товара
```

`/squad 4 ...` и `/squad --agents 4 ...` эквивалентны. Число — это **максимум задач**, а не жёсткое число агентов: Lid сам решает, сколько задач нужно.

### Флаги

| Флаг | Значение |
| --- | --- |
| `--agents N` / `N` | Максимум задач и агентов, 1–12. По умолчанию 8. |
| `--roles a,b` | Разрешённые роли: `analyst`, `executor`, `visual-executor`, `critic`. |
| `--concurrency N` | Параллельных задач, 1–12. По умолчанию 8. |
| `--timeout N` | Таймаут одного агента в минутах, 1–120. По умолчанию 15. |
| `--ideal` | До 8 раундов доработки вместо 2. Также включается словом «идеально». |
| `--base ref` | База. По умолчанию `origin/dev`, затем `origin HEAD`, затем `HEAD`. |
| `--verify "cmd"` | Команда проверки; можно повторять. Иначе берутся команды из плана/AGENTS.md/CI/package.json. |
| `--keep-worktrees` | Оставить worktrees после run для разбора. |

Worktree используются всегда: v2 не пишет в текущее рабочее дерево и не делает checkout.

## Как проходит run

```text
Lid plan
  ├─ analysts (read-only, проект)
  ├─ builders (DAG, отдельный worktree и ветка на задачу)
  ├─ cherry-pick коммитов в integration-ветку
  ├─ verification gate (тесты/линт/сборка)
  ├─ critics (read-only, integration worktree)
  └─ SQUAD_REPORT.md + ветка
```

- **Lid** получает задачу, правила проекта, срез репозитория и возвращает JSON-план: задачи, роли, файлы, зависимости, acceptance, verification.
- **Планировщик** исполняет DAG с ограничением concurrency. Задачи с упавшими зависимостями пропускаются.
- **Каждый builder** получает свой worktree и ветку `squad-<short>-<task>`. Перед работой в worktree фиксируется baseline с untracked-файлами, чтобы патч содержал только изменения агента.
- **Интеграция** делает cherry-pick только успешных коммитов в `squad-<task>-<short>`.
- **Gate** запускает команды проверки в integration worktree. Красный gate останавливает run; Lid может исправить интеграционные проблемы (2 раунда, 8 с `--ideal`).
- **Критики** читают diff и результаты gate, но не меняют файлы.
- **Отчёт** содержит ветку, коммиты, diff stat, вывод gate, критику, вопросы и риски.

## Artifacts

```text
<project>/
├── SQUAD_REPORT.md              # итоговый отчёт (git-ignored)
└── .squad/runs/<run-id>/
    ├── state.json               # снимок состояния
    ├── events.jsonl             # append-only журнал
    ├── plan.json / plan.md      # план Lid
    ├── summary.md
    ├── results/<task>.md
    ├── patches/<task>.patch
    └── logs/<task>.json
```

Ветка остаётся в репозитории. Agent-worktree удаляются после успешного run; при ошибке остаются для разбора.

## Модели

Плагин наследует модель текущей сессии. Рекомендуемая настройка:

```jsonc
{
  "model": "opencode-go/deepseek-v4.1-flash"
}
```

Для сложных run переключи модель сессии на `opencode-go/deepseek-v4-pro` перед запуском. Per-role model routing пока не реализован: все агенты получают модель родительской сессии.

## AGENTS.md и правила проекта

Lid читает:

1. `AGENTS.md` проекта
2. `.opencode/AGENTS.md`
3. `DECISIONS.md`
4. глобальный `~/.config/opencode/AGENTS.md` как fallback

Проектные правила важнее глобальных. Если правила противоречат или verification-команда не найдена, run падает fail-fast, а не гадает.

## Доска и вопросы

У агентов есть инструмент `squad_board`:

- `read` — план, статус, доска, открытые вопросы;
- `post` — заметка/решение;
- `ask` — вопрос; он уходит пользователю, через 60 секунд его видит Lid;
- `answer` — ответ на вопрос;
- `status` — статус run.

Ответить на вопрос:

```text
/squad-answer <question-id> <ответ>
```

Вопросы не блокируют агента: для обратимых решений он продолжает с явным assumption, для destructive — останавливается с блокером.

## Статус

```text
/squad-status [run-id]
```

Показывает компактную таблицу задач, gate и открытые вопросы. Отдельная live TUI-панель пока не реализована — это следующий слой после стабильного core.

## Безопасность и ограничения

- Работа только внутри git-репозитория; v2 не делает `git init` в произвольной папке.
- Основное рабочее дерево не меняется.
- `.env`, `*.pem`, `*.key`, `id_rsa*` исключаются из патчей.
- Агентам запрещены `git push`, `git reset --hard`, `git clean -fdx`, `rm -rf`, `shutdown` и аналогичные destructive-команды (best-effort permission rules).
- Analyst и critic получают read-only правила и запрет на типовые write-команды.
- Рекурсивный `/squad` запрещён на уровне плагина.
- Это **не sandbox**: shell на Windows без контейнеров нельзя надёжно ограничить только permission-правилами. Глобальная защита окружения остаётся отдельным слоем.
- Плагин не делает push, deploy и merge. Ветку ревьюишь и мержишь ты.

## Разработка

```bash
npm install
npm test
npx tsc --noEmit
```

Тесты покрывают:

- парсинг аргументов;
- валидацию плана, DAG, пересечения владения файлами;
- event store и path traversal;
- git worktree, baseline, patch, cherry-pick, cleanup;
- verification gate и detect команд;
- отчёт и статус;
- полный orchestration flow на fake-агенте: plan → worktree → gate → ветка → отчёт;
- отказ от интеграции упавшего builder;
- красный gate и сохранение integration worktree.

## Структура

```text
agents/                  # team-lid, analyst, executor, visual-executor, critic
plugins/squad/
  index.ts               # tool/command registration
  src/
    args.ts              # CLI/tool parsing
    plan.ts              # Lid plan schema + validation
    scheduler.ts         # DAG
    event-store.ts       # state.json + events.jsonl
    git.ts               # worktrees, patches, cherry-pick, cleanup
    gate.ts              # verification commands
    prompts.ts           # agent/Lid prompts
    session.ts           # child sessions + timeout
    questions.ts         # 60s -> Lid escalation
    registry.ts          # active runs/session map
    orchestrator.ts      # full run
    report.ts            # summary/report/status
```

## Лицензия

MIT. См. [LICENSE](LICENSE).
