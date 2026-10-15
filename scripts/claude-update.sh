#!/usr/bin/env bash
# claude-update.sh [--check]
#
# The ONE place Claude Code gets updated on this host. The built-in auto-updater
# is off in every session (DISABLE_AUTOUPDATER=1 at each launch site): sessions
# respawned together used to start it in the same second against the one shared
# install (npm-global: ENOTEMPTY on the package-dir rename), and the binary
# changed under a running session at a moment nobody chose. This script runs as
# the seeded `claude-update` command task (Monday 06:00, Europe/Budapest), takes
# a lock, updates once, verifies the result and records it in
# <store>/claude-update.json. The idle-only staggered restart of the running
# sessions is the dashboard's job (src/web/claude-update.ts): a session that
# started before the `updatedAt` this script records still runs the old binary.
#
#   --check   print installed/latest and what would happen; change nothing
#
# Exit 0: updated, already current, pinned, or another run holds the lock.
# Exit 1: the update failed (the command-task health path alerts on it); nothing
#         is restarted after a failure.
#
# Pins (the update is skipped, status "pinned"):
#   - <store>/claude-pin holds a version string (operator rollback / hold-back)
#   - CLAUDE_UPDATE_PIN env, same meaning
#   - an AVX-less x86 host: the pinned Node-based claude (install-linux.sh
#     CLAUDE_PIN) must not be swapped for the latest Bun binary, which SIGILLs
#     without AVX and would kill every session.
#
# Test hooks (env, used by src/__tests__/claude-update-script.test.ts):
#   MARVEEN_STORE_DIR        state/lock dir (default <install>/store)
#   CLAUDE_UPDATE_CLAUDE_BIN claude binary to use (default: first on PATH)
#   CLAUDE_UPDATE_NPM        npm binary to use (default: first on PATH)
#   CLAUDE_UPDATE_AVXLESS    1/0 forces the AVX-less verdict (default: /proc/cpuinfo)

set -uo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$HERE/.." && pwd)"
STORE_DIR="${MARVEEN_STORE_DIR:-$INSTALL_DIR/store}"
STATE_FILE="$STORE_DIR/claude-update.json"
LOCK_DIR="$STORE_DIR/claude-update.lock"
PIN_FILE="$STORE_DIR/claude-pin"
STATE_PY="$HERE/lib/claude-update-state.py"
PKG="@anthropic-ai/claude-code"
LOCK_STALE_MIN=30

CLAUDE_BIN="${CLAUDE_UPDATE_CLAUDE_BIN:-$(command -v claude || true)}"
NPM_BIN="${CLAUDE_UPDATE_NPM:-$(command -v npm || true)}"

log() { echo "claude-update: $*"; }

# state_set key=value ... : merge into the state file (no-op in --check mode)
state_set() {
  [ "$CHECK_ONLY" = "1" ] && return 0
  python3 -I "$STATE_PY" "$STATE_FILE" "$@" || log "warning: could not write $STATE_FILE"
}

# version_of <bin> : "2.1.300" from "2.1.300 (Claude Code)", empty if it does not run
version_of() {
  local out v
  out="$("$1" --version 2>/dev/null)" || return 1
  v="${out%% *}"
  case "$v" in
    [0-9]*.[0-9]*.[0-9]*) echo "$v" ;;
    *) return 1 ;;
  esac
}

# at_least <a> <b> : true when version a >= version b
at_least() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

fail() {
  log "FAILED: $1"
  state_set status=failed "message=$1" "checkedAt=$(date +%s)" "installed=${INSTALLED:-}" "latest=${LATEST:-}" "method=${METHOD:-unknown}"
  exit 1
}

mkdir -p "$STORE_DIR" 2>/dev/null || true

if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  fail "claude binary not found on PATH"
fi

# --- pin / AVX-less: hold the version, do nothing else ---------------------
PIN="${CLAUDE_UPDATE_PIN:-}"
if [ -z "$PIN" ] && [ -f "$PIN_FILE" ]; then PIN="$(tr -d ' \t\r\n' < "$PIN_FILE")"; fi
AVXLESS="${CLAUDE_UPDATE_AVXLESS:-}"
if [ -z "$AVXLESS" ]; then
  if grep -qE '^flags[[:space:]]*:' /proc/cpuinfo 2>/dev/null && ! grep -qiw avx /proc/cpuinfo 2>/dev/null; then AVXLESS=1; else AVXLESS=0; fi
fi

INSTALLED="$(version_of "$CLAUDE_BIN" || true)"
RESOLVED="$(python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CLAUDE_BIN" 2>/dev/null || echo "$CLAUDE_BIN")"
case "$RESOLVED" in
  *node_modules/@anthropic-ai/claude-code*) METHOD=npm ;;
  *) METHOD=native ;;
esac

if [ -n "$PIN" ] || [ "$AVXLESS" = "1" ]; then
  if [ -n "$PIN" ]; then WHY="pinned to $PIN"; else WHY="AVX-less host (pinned Node build)"; fi
  log "skipped, $WHY (installed ${INSTALLED:-unknown})"
  state_set status=pinned "message=$WHY" "checkedAt=$(date +%s)" "installed=${INSTALLED:-}" "method=$METHOD"
  exit 0
fi

[ -n "$INSTALLED" ] || fail "installed claude does not report a version"

# --- latest published version (the npm registry carries both install methods) ---
LATEST=""
if [ -n "$NPM_BIN" ] && [ -x "$NPM_BIN" ]; then
  LATEST="$("$NPM_BIN" view "$PKG" version 2>/dev/null | tail -n 1 | tr -d ' \r\n' || true)"
  case "$LATEST" in [0-9]*.[0-9]*.[0-9]*) ;; *) LATEST="" ;; esac
fi

if [ "$CHECK_ONLY" = "1" ]; then
  log "check: installed=$INSTALLED latest=${LATEST:-unknown} method=$METHOD"
  exit 0
fi

if [ "$METHOD" = "npm" ] && [ -z "$LATEST" ]; then
  fail "cannot determine the latest version (npm view failed)"
fi

if [ -n "$LATEST" ] && at_least "$INSTALLED" "$LATEST"; then
  log "already current ($INSTALLED)"
  state_set status=up-to-date "message=already current" "checkedAt=$(date +%s)" "installed=$INSTALLED" "latest=$LATEST" "method=$METHOD"
  exit 0
fi

# --- lock: one updater at a time (macOS has no flock; mkdir is atomic) ----
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" > "$LOCK_DIR/pid"; return 0; fi
  local holder
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +"$LOCK_STALE_MIN" 2>/dev/null)" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null
    if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" > "$LOCK_DIR/pid"; return 0; fi
  fi
  return 1
}
if ! acquire_lock; then
  log "another run holds the lock, skipping"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

# --- the update --------------------------------------------------------------
# DISABLE_AUTOUPDATER guards the in-session updater; the explicit update below
# must not be blocked by it, so it is unset for this child only.
if [ "$METHOD" = "npm" ]; then
  log "npm install -g $PKG@$LATEST (was $INSTALLED)"
  env -u DISABLE_AUTOUPDATER "$NPM_BIN" install -g "$PKG@$LATEST" >&2 || fail "npm install failed for $LATEST"
else
  log "claude update (was $INSTALLED, latest ${LATEST:-unknown})"
  env -u DISABLE_AUTOUPDATER "$CLAUDE_BIN" update >&2 || fail "claude update failed"
fi

# --- verify: the binary must run and report a version -------------------------
NEW="$(version_of "$CLAUDE_BIN" || true)"
[ -n "$NEW" ] || fail "claude does not run after the update (was $INSTALLED); not restarting anything"

NOW="$(date +%s)"
if [ "$NEW" != "$INSTALLED" ]; then
  log "updated $INSTALLED -> $NEW"
  state_set status=updated "message=updated $INSTALLED to $NEW" "checkedAt=$NOW" "updatedAt=$NOW" "installed=$NEW" "previous=$INSTALLED" "latest=${LATEST:-$NEW}" "method=$METHOD"
  exit 0
fi
if [ -n "$LATEST" ] && ! at_least "$NEW" "$LATEST"; then
  fail "update ran but the version is still $NEW (latest $LATEST)"
fi
log "already current ($NEW)"
state_set status=up-to-date "message=already current" "checkedAt=$NOW" "installed=$NEW" "latest=${LATEST:-$NEW}" "method=$METHOD"
exit 0
