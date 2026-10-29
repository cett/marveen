#!/bin/bash
# Records where tmux lives into an env file as TMUX_BIN, so the dashboard's runtime resolver (src/platform.ts,
# tmuxBin) starts from the installed location instead of guessing. Idempotent: a TMUX_BIN that already points at
# an executable is kept; a missing or stale one is replaced (the file is rewritten in place, so its mode stays).
# No tmux on PATH: nothing is written and the exit status is 0 (the runtime search and its explicit error remain).
#
#   scripts/record-tmux-bin.sh <env-file>
set -u
ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || { echo "record-tmux-bin: env file not found: ${ENV_FILE:-<none>}" >&2; exit 2; }

TMUX_PATH="$(command -v tmux 2>/dev/null || true)"
case "$TMUX_PATH" in /*) ;; *) exit 0 ;; esac
[ -x "$TMUX_PATH" ] || exit 0

CURRENT="$(sed -n 's/^TMUX_BIN=//p' "$ENV_FILE" | head -1 | tr -d '"')"
if [ -n "$CURRENT" ] && [ -x "$CURRENT" ]; then exit 0; fi

TMP="$(mktemp)"
grep -v '^TMUX_BIN=' "$ENV_FILE" > "$TMP" || true
printf 'TMUX_BIN=%s\n' "$TMUX_PATH" >> "$TMP"
cat "$TMP" > "$ENV_FILE"
rm -f "$TMP"
echo "record-tmux-bin: TMUX_BIN=$TMUX_PATH"
