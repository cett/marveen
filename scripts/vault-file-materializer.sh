#!/bin/bash
# Resolve vault-file: references in env vars into materialized temp files,
# then run the real command. Companion to vault-env-wrapper.sh, for MCP
# servers that expect a credential FILE PATH (e.g. GOOGLE_APPLICATION_CREDENTIALS,
# GARMINTOKENS), not an env var holding the secret value itself.
#
# Reference format: vault-file:<vaultId>:<mode>:<filename>[:syncback]
#   mode=file  -> the env var becomes the materialized file's full path
#   mode=dir   -> the env var becomes the containing (private) temp directory
#   syncback   -> after the wrapped process exits, write the file's current
#                 content back into the vault entry (for servers that refresh
#                 their own credential file, e.g. garmin-mcp's token refresh)
#
# Unlike vault-env-wrapper.sh this cannot `exec` the wrapped command directly:
# cleanup (delete the temp dir, optional sync-back) must run AFTER the child
# exits, which requires staying alive as the parent instead of replacing this
# process image. Written for /bin/bash 3.2 (macOS default) -- no bash4+ only
# constructs.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-file-materializer: node not found" >&2
  exit 1
fi

TMPDIRS_FILE="$(mktemp "${TMPDIR:-/tmp}/vault-file-materializer-dirs.XXXXXX")"
SYNCBACK_FILE="$(mktemp "${TMPDIR:-/tmp}/vault-file-materializer-sync.XXXXXX")"
child_pid=""

cleanup() {
  # Best-effort sync-back BEFORE removing any temp file.
  if [ -s "$SYNCBACK_FILE" ]; then
    while IFS='|' read -r vid path; do
      [ -z "$vid" ] && continue
      if [ -f "$path" ]; then
        "$NODE" "$SCRIPT_DIR/vault-materialize.mjs" set "$vid" "$vid" < "$path" 2>/dev/null || \
          echo "vault-file-materializer: sync-back failed for $vid" >&2
      fi
    done < "$SYNCBACK_FILE"
  fi
  if [ -s "$TMPDIRS_FILE" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] && rm -rf "$d"
    done < "$TMPDIRS_FILE"
  fi
  rm -f "$TMPDIRS_FILE" "$SYNCBACK_FILE"
}
trap cleanup EXIT

forward_signal() {
  sig="$1"
  if [ -n "$child_pid" ]; then
    kill -s "$sig" "$child_pid" 2>/dev/null || true
  fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

for var in $(env | grep '=vault-file:' | cut -d= -f1); do
  val="${!var}"
  ref="${val#vault-file:}"
  vaultId="$(printf '%s' "$ref" | cut -d: -f1)"
  fmode="$(printf '%s' "$ref" | cut -d: -f2)"
  filename="$(printf '%s' "$ref" | cut -d: -f3)"
  flag="$(printf '%s' "$ref" | cut -d: -f4)"

  if [ -z "$vaultId" ] || [ -z "$fmode" ] || [ -z "$filename" ]; then
    echo "vault-file-materializer: malformed vault-file reference for $var: $ref" >&2
    exit 1
  fi

  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/vault-file.XXXXXX")"
  chmod 700 "$tmpdir"
  target="$tmpdir/$filename"

  if ! "$NODE" "$SCRIPT_DIR/vault-materialize.mjs" get "$vaultId" > "$target"; then
    echo "vault-file-materializer: failed to materialize $vaultId for $var" >&2
    rm -rf "$tmpdir"
    exit 1
  fi
  chmod 600 "$target"
  printf '%s\n' "$tmpdir" >> "$TMPDIRS_FILE"

  if [ "$flag" = "syncback" ]; then
    printf '%s|%s\n' "$vaultId" "$target" >> "$SYNCBACK_FILE"
  fi

  if [ "$fmode" = "dir" ]; then
    export "$var"="$tmpdir"
  else
    export "$var"="$target"
  fi
done

"$@" &
child_pid=$!
# `wait` returns early (128+signum) the moment a trapped signal arrives,
# without reaping the child -- it does NOT mean the child has exited. Forward
# the signal (see the traps above) and keep waiting until the child is
# actually gone, so cleanup (sync-back, temp-dir removal) never runs while
# the wrapped server is still mid-shutdown and still touching its file.
while true; do
  wait "$child_pid"
  rc=$?
  if kill -0 "$child_pid" 2>/dev/null; then
    continue
  fi
  break
done
exit "$rc"
