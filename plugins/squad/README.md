# squad plugin

V2-плагин для OpenCode: детерминированный мультиагентный оркестратор `/squad`.

## Что делает

- Регистрирует команду `/squad` и инструмент `squad`.
- Создаёт дочерние сессии через `ctx.session.create` с нужным агентом и location.
- Запускает агентов пулом с ограничением concurrency.
- Сохраняет результаты в `.squad/runs/<run-id>/`.
- Для `N > 4` создаёт git worktrees для пишущих агентов, собирает патчи и применяет их в основной проект.
- Пишет `summary.md` и черновик `SQUAD_REPORT.md`.
- В режиме команды переключает сессию на `team-lid` и просит его обновить отчёт.

## Фазы

```text
analyst*  →  executor*  →  visual-executor*  →  critic*  →  Lid
                |                 |
                +--- core patches -+
```

- `analyst` — read-only.
- `executor` — core-код, тесты, исправления.
- `visual-executor` — визуал; получает core-патчи.
- `critic` — read-only, замечания `Lid`.

## Интеграция патчей

1. `capturePatch` делает `git add` с исключением секретов и `git diff --cached --binary`.
2. В visual-worktree core-патчи применяются и коммитятся как `squad: core baseline`. Это важно: иначе visual-патч содержит core-изменения и при интеграции они применяются дважды.
3. Перед применением в основной проект выполняется `git apply --check --3way`.
4. Если проверка не прошла — патч не применяется, worktree сохраняется, `Lid` видит ошибку.

## Ограничения

- `ctx.session.wait` и `ctx.worktree` — экспериментальные API V2; при обновлении OpenCode проверить совместимость.
- Агенты не могут задавать вопросы (`question` deny) — иначе дочерняя сессия зависнет без клиента.
- `external_directory` deny: агенты работают только в своей location (проект или worktree).
- `node_modules` и другие зависимости симлинкуются, а не устанавливаются заново.
