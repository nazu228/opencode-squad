#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
DRY_RUN=0

usage() {
    cat <<'EOF'
Usage: ./install.sh [--config-dir PATH] [--dry-run]

  --config-dir PATH  Папка конфигурации OpenCode (по умолчанию ~/.config/opencode)
  --dry-run          Показать действия, ничего не менять
  -h, --help         Эта справка
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --config-dir)
            if [[ $# -lt 2 ]]; then
                echo "Ошибка: --config-dir требует путь." >&2
                exit 2
            fi
            CONFIG_DIR="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Неизвестный параметр: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

AGENTS_SRC="$SCRIPT_DIR/agents"
PLUGIN_SRC="$SCRIPT_DIR/plugins/squad"

if [[ ! -f "$AGENTS_SRC/team-lid.md" ]]; then
    echo "Ошибка: не найден agents/team-lid.md. Запускайте скрипт из папки репозитория." >&2
    exit 1
fi
if [[ ! -f "$PLUGIN_SRC/index.ts" ]]; then
    echo "Ошибка: не найден plugins/squad/index.ts. Запускайте скрипт из папки репозитория." >&2
    exit 1
fi

CONFIG_DIR="${CONFIG_DIR%/}"
if [[ -z "$CONFIG_DIR" || "$CONFIG_DIR" == "/" ]]; then
    echo "Ошибка: небезопасный путь конфигурации: '$CONFIG_DIR'." >&2
    exit 1
fi

AGENTS_DST="$CONFIG_DIR/agents"
PLUGIN_DST="$CONFIG_DIR/plugins/squad"
PLUGINS_DST="$CONFIG_DIR/plugins"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$CONFIG_DIR/squad-backup-$STAMP"
NEED_BACKUP=0

for file in "$AGENTS_SRC"/*.md; do
    if [[ -e "$AGENTS_DST/$(basename "$file")" ]]; then
        NEED_BACKUP=1
    fi
done
if [[ -e "$PLUGIN_DST" ]]; then
    NEED_BACKUP=1
fi

echo
echo "OpenCode Squad installer"
echo "  repo:   $SCRIPT_DIR"
echo "  config: $CONFIG_DIR"
if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  mode:   dry run (файлы не изменяются)"
fi
echo

if [[ "$NEED_BACKUP" -eq 1 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "Backup: будет создан $BACKUP"
    else
        mkdir -p "$BACKUP/agents" "$BACKUP/plugins"
        for file in "$AGENTS_SRC"/*.md; do
            name="$(basename "$file")"
            if [[ -e "$AGENTS_DST/$name" ]]; then
                cp -p "$AGENTS_DST/$name" "$BACKUP/agents/$name"
            fi
        done
        if [[ -e "$PLUGIN_DST" ]]; then
            cp -R "$PLUGIN_DST" "$BACKUP/plugins/"
        fi
        echo "Backup: $BACKUP"
    fi
else
    echo "Backup: не требуется, существующих файлов squad нет"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo
    echo "Будет установлено:"
    echo "  agents: $AGENTS_DST"
    echo "  plugin: $PLUGIN_DST"
    echo
    echo "Dry run завершён."
    exit 0
fi

mkdir -p "$AGENTS_DST" "$PLUGINS_DST"

for file in "$AGENTS_SRC"/*.md; do
    cp -p "$file" "$AGENTS_DST/"
done

rm -rf "$PLUGIN_DST"
cp -R "$PLUGIN_SRC" "$PLUGINS_DST/"

echo
echo "Готово. Установлено:"
echo "  agents: $AGENTS_DST"
echo "  plugin: $PLUGIN_DST"
if [[ "$NEED_BACKUP" -eq 1 ]]; then
    echo "  backup: $BACKUP"
fi
echo
echo "Дальше:"
echo "  1. Перезапустите OpenCode или выполните: opencode reload"
echo "  2. Проверьте: opencode plugin list; opencode debug agents"
echo "  3. В корне проекта: /squad 4 <задача>"
echo

if ! command -v opencode >/dev/null 2>&1; then
    echo "Предупреждение: opencode не найден в PATH." >&2
fi
