# Установка OpenCode Squad

Подробная инструкция для Windows, macOS и Linux. Если нужен только быстрый путь — см. [README.md](README.md).

## 1. Требования

| Компонент | Версия | Проверка |
| --- | --- | --- |
| OpenCode | V2, проверено на `2.2.7` | `opencode --version` |
| Git | 2.40+ | `git --version` |
| ОС | Windows 10/11, macOS, Linux | — |

Node.js и `npm install` не нужны: плагин написан на TypeScript и загружается самим OpenCode.

Плагин использует экспериментальные API OpenCode V2 (`ctx.session.wait`, `ctx.worktree`, `ctx.command.transform`). После крупного обновления OpenCode проверьте, что `/squad` по-прежнему запускается.

## 2. Куда устанавливается

OpenCode читает глобальную конфигурацию из папки:

| ОС | Путь по умолчанию |
| --- | --- |
| Windows | `%USERPROFILE%\.config\opencode` |
| macOS / Linux | `~/.config/opencode` |

Если задан `OPENCODE_CONFIG_DIR`, используется он. Если задан `XDG_CONFIG_HOME`, то `$XDG_CONFIG_HOME/opencode`.

После установки структура должна выглядеть так:

```text
~/.config/opencode/
├── agents/
│   ├── team-lid.md
│   ├── analyst.md
│   ├── executor.md
│   ├── visual-executor.md
│   └── critic.md
└── plugins/
    └── squad/
        ├── index.ts
        └── README.md
```

Отдельная запись в `opencode.json` не нужна: OpenCode V2 автоматически подхватывает плагины из папки `plugins`.

## 3. Автоматическая установка

### Windows (PowerShell)

```powershell
git clone https://github.com/nazu228/opencode-squad.git
cd opencode-squad
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Если политика выполнения PowerShell блокирует запуск, используйте именно вариант с `-ExecutionPolicy Bypass`, как показано выше.

Можно также дважды щёлкнуть `install.cmd` — он вызывает `install.ps1` с нужными параметрами.

Своя папка конфигурации:

```powershell
.\install.ps1 -ConfigDir "D:\opencode-config"
```

Предпросмотр без изменений:

```powershell
.\install.ps1 -DryRun
```

### macOS / Linux

```bash
git clone https://github.com/nazu228/opencode-squad.git
cd opencode-squad
chmod +x install.sh
./install.sh
```

Своя папка конфигурации:

```bash
./install.sh --config-dir "$HOME/.config/opencode-custom"
```

Предпросмотр без изменений:

```bash
./install.sh --dry-run
```

Установщик:

1. Определяет папку конфигурации OpenCode.
2. Сохраняет существующие файлы squad в `squad-backup-<дата>-<время>`.
3. Копирует пять агентов в `agents/`.
4. Заменяет `plugins/squad/` целиком.
5. Печатает дальнейшие шаги.

Другие плагины и агенты не затрагиваются.

## 4. Ручная установка

Если не хотите запускать скрипт, скопируйте файлы вручную.

### Windows

```powershell
$src = "C:\path\to\opencode-squad"
$dst = Join-Path $HOME ".config\opencode"

New-Item -ItemType Directory -Force "$dst\agents", "$dst\plugins" | Out-Null
Copy-Item "$src\agents\*.md" "$dst\agents\" -Force
Copy-Item "$src\plugins\squad" "$dst\plugins\" -Recurse -Force
```

### macOS / Linux

```bash
mkdir -p ~/.config/opencode/agents ~/.config/opencode/plugins
cp agents/*.md ~/.config/opencode/agents/
cp -R plugins/squad ~/.config/opencode/plugins/
```

## 5. Проверка установки

1. Перезапустите OpenCode. В TUI также можно выполнить:

   ```text
   /reload
   ```

   или из терминала:

   ```bash
   opencode reload
   ```

2. Проверьте, что плагин и агенты видны:

   ```bash
   opencode plugin list
   opencode debug agents
   ```

   В списке агентов должны быть `team-lid`, `analyst`, `executor`, `visual-executor`, `critic`.

3. Откройте проект и запустите:

   ```text
   /squad 4 Проверь проект и предложи улучшения
   ```

   Если команда `/squad` не появилась, см. раздел 8.

## 6. Обновление

```bash
cd opencode-squad
git pull
```

Затем снова запустите установщик: `.\install.ps1` или `./install.sh`. Старые версии файлов будут сохранены в новой backup-папке.

## 7. Удаление

Удалите только файлы squad:

```text
~/.config/opencode/agents/team-lid.md
~/.config/opencode/agents/analyst.md
~/.config/opencode/agents/executor.md
~/.config/opencode/agents/visual-executor.md
~/.config/opencode/agents/critic.md
~/.config/opencode/plugins/squad/
```

PowerShell:

```powershell
$dst = Join-Path $HOME ".config\opencode"
Remove-Item "$dst\agents\team-lid.md","$dst\agents\analyst.md","$dst\agents\executor.md","$dst\agents\visual-executor.md","$dst\agents\critic.md" -ErrorAction SilentlyContinue
Remove-Item "$dst\plugins\squad" -Recurse -Force -ErrorAction SilentlyContinue
```

macOS / Linux:

```bash
rm -f ~/.config/opencode/agents/{team-lid,analyst,executor,visual-executor,critic}.md
rm -rf ~/.config/opencode/plugins/squad
```

Не удаляйте всю папку `~/.config/opencode`, если в ней есть другие агенты, плагины или настройки.

## 8. Диагностика

### `/squad` не появился

1. Проверьте, что файл существует: `~/.config/opencode/plugins/squad/index.ts`.
2. Выполните `opencode plugin list`.
3. Перезапустите OpenCode полностью, а не только сессию.
4. Убедитесь, что установлен OpenCode V2: `opencode --version`.

### Агенты не видны

```bash
opencode debug agents
```

Если агентов нет, проверьте, что пять `.md`-файлов лежат именно в `~/.config/opencode/agents/`, а не во вложенной папке.

### Ошибка при запуске: `ctx.session.wait is not a function`

Это значит, что версия OpenCode несовместима с текущим плагином. Обновите OpenCode или откройте issue в репозитории с выводом `opencode --version`.

### `/squad` отказывается запускаться

Команда не работает в системных папках и в домашней папке без проекта. Перейдите в корень проекта:

```bash
cd C:\work\my-project
opencode
```

### Worktree не создаётся

Нужен git-репозиторий. Для не-git проекта squad сам выполнит `git init` и создаст baseline-коммит, но для существующего проекта лучше инициализировать git заранее.

### Политика PowerShell

```text
File ... cannot be loaded because running scripts is disabled on this system
```

Запускайте так:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

### Где лежат worktrees и логи

```text
~/.local/share/opencode/squad/worktrees/
<project>/.squad/runs/<run-id>/
<project>/SQUAD_REPORT.md
```

## 9. Настройка

- **Модель.** Агенты наследуют глобальную модель из `opencode.json`. Можно задать `model` в frontmatter конкретного агента.
- **Поведение роли.** Отредактируйте `agents/<role>.md`. Изменения подхватываются без перезапуска.
- **Своя роль.** Создайте `agents/<my-role>.md` с `mode: all`, добавьте роль в `--roles` и в логику фаз плагина.
- **Лимиты.** Ограничьте число агентов и concurrency: `/squad --agents 4 --concurrency 2 ...`.

## 10. Безопасность

- `.env` и секреты запрещены к чтению на уровне прав агентов.
- `analyst` и `critic` не могут редактировать файлы.
- Агенты не выходят за пределы проекта (`external_directory: deny`).
- Shell-команды разрешены, поэтому технически агент может выполнить опасную команду. Запускайте squad в проекте под git, проверяйте `git diff` и `SQUAD_REPORT.md` перед принятием изменений.
- Не запускайте squad в системных папках и в проектах, которым не доверяете.
