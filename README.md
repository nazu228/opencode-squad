# OpenCode Squad

Мультиагентный отряд для [OpenCode](https://opencode.ai) V2. Одна команда `/squad` запускает несколько агентов над общей задачей, изолирует пишущих агентов в git worktrees и собирает итоговый отчёт `SQUAD_REPORT.md`.

```text
/squad 4 Добавь авторизацию через JWT и тесты
/squad --agents 8 Отрефактори модуль оплаты
/squad 5 --roles analyst,executor,visual-executor,critic Сделай страницу товара
```

## Что внутри

| Компонент | Назначение |
| --- | --- |
| `/squad` | Команда и инструмент оркестратора |
| `team-lid` | Тимлид: декомпозиция, раздача задач, финальный синтез |
| `analyst` | Аналитик: изучает код и задачу, только чтение |
| `executor` | Core-исполнитель: код, тесты, исправления |
| `visual-executor` | Визуальный исполнитель: UI/UX, стили, компоненты |
| `critic` | Критик: проверяет результат, файлы не правит |

Фазы запуска:

```text
analyst*  →  executor*  →  visual-executor*  →  critic*  →  Lid
                |                 |
                +--- core patches -+
```

## Требования

- OpenCode V2 (проверено на `2.2.7`)
- Git 2.40+
- Windows 10/11, macOS или Linux
- Node.js не нужен: плагин загружается самим OpenCode

## Установка

### Windows

```powershell
git clone https://github.com/nazu228/opencode-squad.git
cd opencode-squad
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/nazu228/opencode-squad.git
cd opencode-squad
chmod +x install.sh
./install.sh
```

Установщик копирует агентов и плагин в `~/.config/opencode`, а существующие файлы предварительно сохраняет в `squad-backup-<дата>`.

После установки перезапустите OpenCode или выполните `opencode reload`. Подробности, ручная установка и решение проблем — в [INSTALL.md](INSTALL.md).

## Быстрый старт

Запускайте из корня проекта:

```text
/squad 4 Добавь авторизацию через JWT и тесты
```

Поддерживаются оба синтаксиса: `4 задача` и `--agents 4 задача`.

| Флаг | Что делает |
| --- | --- |
| `--agents N` / `N` | Число агентов, 2–100. По умолчанию 4 |
| `--roles a,b,c` | Порядок ролей. По умолчанию `analyst,executor,visual-executor,critic` |
| `--concurrency N` | Сколько агентов работают одновременно. По умолчанию 8 |
| `--timeout N` | Таймаут на одного агента в минутах. По умолчанию 15 |
| `--worktrees` | Принудительно включить worktrees |
| `--no-worktrees` | Отключить worktrees |
| `--keep-worktrees` | Не удалять worktrees после запуска |

## Артефакты

```text
<project>/
├── SQUAD_REPORT.md              # итоговый отчёт
└── .squad/
    └── runs/<run-id>/
        ├── summary.md           # полная сводка запуска
        ├── results/<agent>.md   # отчёт каждого агента
        ├── patches/<agent>.patch
        └── logs/<agent>.json
```

`.squad/` автоматически добавляется в `.git/info/exclude` и не засоряет `git status`.

## Worktrees

- Включаются автоматически при `N > 4`.
- Каждый пишущий агент получает отдельный worktree в `~/.local/share/opencode/squad/worktrees/`.
- Патчи применяются в основной проект через `git apply --check --3way`.
- Если патч не применился, он остаётся в `.squad/runs/<run>/patches/`, а worktree сохраняется для разбора.
- Для не-git проекта создаётся `git init` и baseline-коммит.

## Безопасность

- `.env` и секреты запрещены к чтению на уровне прав агентов.
- Аналитик и критик работают только в режиме чтения.
- Агенты не выходят за пределы проекта (`external_directory: deny`).
- Shell-команды агентам разрешены, поэтому запускайте squad в проекте под git и просматривайте `SQUAD_REPORT.md` и `git diff`.
- `/squad` отказывается работать в системных папках (`C:\Windows`, `C:\Program Files`, `C:\ProgramData`, корень диска, домашняя папка без проекта).

## Лицензия

MIT. См. [LICENSE](LICENSE).

## Документация

- [INSTALL.md](INSTALL.md) — установка, обновление, удаление, диагностика.
- [docs/SQUAD.md](docs/SQUAD.md) — полное описание работы squad.
- [plugins/squad/README.md](plugins/squad/README.md) — внутреннее устройство плагина.

## Структура репозитория

```text
.
├── agents/
│   ├── team-lid.md
│   ├── analyst.md
│   ├── executor.md
│   ├── visual-executor.md
│   └── critic.md
├── plugins/squad/
│   ├── index.ts
│   └── README.md
├── docs/SQUAD.md
├── install.ps1
├── install.sh
└── install.cmd
```
