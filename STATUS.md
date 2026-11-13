# Squad v2 — статус сборки

Дата: 2026-11-13. Сборка выполнена автономно по инструкции пользователя.

## Что сделано

- Полностью переписан orchestration core:
  - Lid-планировщик с JSON-планом и валидацией;
  - DAG-планировщик с concurrency;
  - отдельный git worktree и ветка на каждую builder-задачу;
  - baseline-коммит с untracked-файлами, чтобы патч содержал только изменения агента;
  - cherry-pick только успешных коммитов в integration-ветку;
  - жёсткий verification gate с командами из плана/AGENTS.md/CI/package.json;
  - доработка интеграционных ошибок Lid-ом (2 раунда, 8 при `--ideal`);
  - critics после интеграции;
  - `state.json` + `events.jsonl` + `SQUAD_REPORT.md`;
  - `/squad-status` и инструмент `squad_status`;
  - `squad_board` с read/post/ask/answer/status и 60s -> Lid escalation;
  - локальные guards: запрет recursive squad, push, reset --hard, clean -fdx, rm -rf, shutdown; read-only правила для analyst/critic;
  - AGENTS.md/DECISIONS.md читаются и попадают в план; проектные правила важнее глобальных.

- Обновлены агенты:
  - `executor` — Ponytail `full`, подчинённый AGENTS.md;
  - `visual-executor` — без Ponytail, как просил пользователь;
  - graphify-секции сохранены;
  - добавлены shell deny-правила для destructive-команд.

## Проверки

- `npm test` — **30/30 pass**.
- `npx tsc --noEmit` — **pass**.
- Реальный end-to-end run #1:
  - run `20261113-131613-7c41a824`;
  - статус `delivered`, 4m 43s;
  - ветка `squad-create-7c41a824`;
  - `hello.txt` = `hello`;
  - gate `node -e 0` — OK.
- Реальный end-to-end run #2 (после фикса base commit):
  - run `20261113-132550-28274862`;
  - статус `delivered`, 5m 57s;
  - ветка `squad-create-28274862`;
  - `second.txt` = `second`;
  - diff stat `second.txt | 1 +`;
  - `Integration worktree: -` (worktree удалён после успеха);
  - gate `node -e 0` — OK;
  - основное рабочее дерево не изменено.
- Плагин активен в OpenCode:
  - `/api/plugin` показывает `squad` в статусе `active`;
  - команды `/squad`, `/squad-status`, `/squad-answer` зарегистрированы.

## Установка

- Установлено в `~/.config/opencode` через `install.ps1`.
- Глобальная модель переключена на `opencode-go/deepseek-v4.1-flash`.
- Бэкапы предыдущей версии: `~/.config/opencode/squad-backup-*`.

## GitHub

- `nazu228/opencode-squad`
  - `main` — рабочая v2;
  - `v2` — ветка разработки;
  - `v2-stable` — финальный снимок;
  - тег `v2.0.0` (и финальный тег после этого статуса).
- `nazu228/opencode-setup`
  - `main` и `squad-v2` — portable bundle с v2;
  - тег `setup-squad-v2`.

## Известные ограничения

- Нет live TUI-панели: есть `/squad-status`, tool `squad_status` и `state.json`.
- Нет per-role model routing: все агенты наследуют модель сессии; Pro переключается вручную.
- Вопросы не блокируют tool call: агент продолжает с assumption, ответ приходит на доску/через synthetic message.
- Локальные guards — best-effort permission rules, не sandbox. На Windows без контейнеров это осознанный компромисс.
- Плагин не делает push/deploy/merge.
- Untracked-файлы, изменённые агентом, могут не примениться в integration-ветке, если они не были в baseline; это край, run покажет ошибку.
- Для очень больших diff пока нет автоматического stacked-branches split; это следующий слой.

## Следующие шаги

1. Live TUI-панель на OpenTUI route/panel.
2. Per-role model routing (Flash по умолчанию, Pro для сложных ролей).
3. Replay/просмотр доски из `events.jsonl`.
4. Stacked branches при diff > 2 000 строк / 20 файлов.
5. Более строгий sandbox для shell (WSL/AppContainer) как отдельный слой.

## Выключение

Сборка завершена, ветки и теги запушены. Компьютер выключается по инструкции пользователя.
