#!/bin/bash
# Inject/restore vault: references in an MCP config file's HTTP-transport
# server headers (e.g. mcpServers.uptimerobot.headers.Authorization).
#
# vault-env-wrapper.sh resolves vault: references for spawned STDIO MCP
# servers via their env vars. An HTTP-transport server has no spawned process
# to intercept -- its headers sit directly in the config file -- so this
# script instead resolves them in place right before Claude Code launches,
# and restores the vault:-reference template right after it exits. The
# actual JSON read/resolve/write logic lives in the companion
# vault-inject-http-mcp.mjs; this wrapper only finds node and forwards.
#
# Usage:
#   vault-inject-http-mcp.sh inject   [target-file]   (default: ~/.claude.json)
#   vault-inject-http-mcp.sh restore  [target-file]
#
# Best-effort by design: the caller (channels.sh) must never fail to launch
# the channel bot because of a vault/config problem here. Failures are
# printed to stderr for the caller to log; this script's own exit code
# mirrors the underlying node run so a caller that DOES want to check can.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE="${1:-}"
TARGET="${2:-$HOME/.claude.json}"

case "$MODE" in
  inject|restore) ;;
  *)
    echo "usage: $(basename "$0") {inject|restore} [target-file]" >&2
    exit 1
    ;;
esac

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-inject-http-mcp: node not found, skipping $MODE" >&2
  exit 0
fi

exec "$NODE" "$SCRIPT_DIR/vault-inject-http-mcp.mjs" "$MODE" "$TARGET"
