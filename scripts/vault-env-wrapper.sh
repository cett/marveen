#!/bin/bash
# Resolve vault: references in env vars, then exec the real command.
# Claude Code launches this as the MCP server "command". The actual
# server command + args are passed as arguments to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find node binary
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-env-wrapper: node not found" >&2
  exit 1
fi

# Collect vault: references from env.
# The names come from the exported variable names (compgen -e), never from the lines of a value: a value with a
# newline in it must not be able to put a second "NAME=id" line into REFS. Only a value that starts with "vault:"
# and whose rest is a canonical secret id (same character set and length as the fleet import) is resolved; any
# other value is left as it is, with a warning that carries the variable NAME only, never the value.
# bash 3.2 compatible (macOS /bin/bash): no mapfile, no associative arrays.
NAME_RE='^[A-Za-z_][A-Za-z0-9_]*$'
ID_RE='^[A-Za-z0-9._-]{1,128}$'
REFS=""
for var in $(compgen -e); do
  [[ "$var" =~ $NAME_RE ]] || continue
  val="${!var-}"
  case "$val" in vault:*) ;; *) continue ;; esac
  secret_id="${val#vault:}"
  if [[ "$secret_id" =~ $ID_RE ]]; then
    REFS="${REFS}${var}=${secret_id}"$'\n'
  else
    echo "vault-env-wrapper: $var skipped, its vault: reference is not a canonical secret id (left unresolved)" >&2
  fi
done

if [ -n "$REFS" ]; then
  RESOLVED=$(printf '%s' "$REFS" | "$NODE" "$PROJECT_ROOT/scripts/vault-resolve.mjs")
  while IFS='=' read -r key value; do
    [ -n "$key" ] && export "$key"="$value"
  done <<< "$RESOLVED"
fi

exec "$@"
