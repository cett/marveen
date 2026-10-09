#!/usr/bin/env bash
# agent-api.sh -- the one supported way for a shell recipe to call the dashboard API.
#
# Usage:  bash scripts/agent-api.sh [options] METHOD PATH [BODY]
#   METHOD   GET | POST | PUT | PATCH | DELETE
#   PATH     /api/..., query string included, e.g. "/api/memories?agent=zack&q=term"
#   BODY     a JSON string, "-" to read it from STDIN, or "@file" to send that file as is
# Options (before METHOD):
#   --agent ID          act as this agent (default: MARVEEN_AGENT_ID, else derived from the cwd)
#   --token KIND        agent (default) | operator | shared
#                         agent     the agent's own token (agents/<id>/.agent-token, the main
#                                   agent's in the install root); a MISSING file falls back to the
#                                   shared token, loudly (see below)
#                         operator  store/.operator-token, same fallback
#                         shared    the shared dashboard token on purpose: for the endpoints that
#                                   are still admin:all and that a fleet_agent token is refused on
#                                   (agent start/stop/restart, vault, global skill writes) until T4
# Output: the response body on stdout. Exit 0 on a 2xx; 22 on any other HTTP status (the status
# line goes to stderr, the body is still printed); curl's own code when the request never got an
# answer; 2 on a usage error.
#
# The token never appears on a command line: it is handed to curl as a config on STDIN
# (`curl -K -`), the body goes through a 0600 temp file. A token that is present but REFUSED
# (401, a revoked or stale file) is NOT retried on the shared token: that would hide the fault.
# Only a missing or empty file falls back, and then the request carries X-Agent-Id so the
# dashboard's token-shadow meter shows who fell back. T4 removes the fallback.
#
# Env: MARVEEN_AGENT_ID, MARVEEN_AGENT_TOKEN_FILE (explicit own-token file), MAIN_AGENT_ID,
#      DASHBOARD_BASE_URL (default http://localhost:<MARVEEN_WEB_PORT|WEB_PORT|.env|3420>).
# Portable to macOS /bin/bash 3.2.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${MARVEEN_STORE_DIR:-$BASE/store}"

usage() { sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

AGENT="${MARVEEN_AGENT_ID:-}"; KIND="agent"
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) [ $# -ge 2 ] || usage; AGENT="$2"; shift 2 ;;
    --token) [ $# -ge 2 ] || usage; KIND="$2"; shift 2 ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) echo "agent-api: unknown option $1" >&2; usage ;;
    *) break ;;
  esac
done
case "$KIND" in agent|operator|shared) : ;; *) echo "agent-api: --token must be agent, operator or shared" >&2; exit 2 ;; esac
[ $# -ge 2 ] || usage
METHOD="$1"; APIPATH="$2"; BODY="${3-}"
case "$METHOD" in GET|POST|PUT|PATCH|DELETE) : ;; *) echo "agent-api: bad METHOD '$METHOD'" >&2; exit 2 ;; esac
case "$APIPATH" in /api/*) : ;; *) echo "agent-api: PATH must start with /api/" >&2; exit 2 ;; esac

env_file_value() { # env_file_value KEY -> value from <install>/.env, empty when absent
  [ -r "$BASE/.env" ] || return 0
  sed -n "s/^$1=//p" "$BASE/.env" | head -n1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

read_token() { # read_token FILE -> trimmed content, empty on any problem (never fails)
  [ -f "$1" ] && [ -r "$1" ] || return 0
  tr -d ' \t\r\n' < "$1" 2>/dev/null || true
}

MAIN="${MAIN_AGENT_ID:-$(env_file_value MAIN_AGENT_ID)}"
if [ -z "$AGENT" ]; then
  case "$PWD" in
    "$BASE"/agents/*) AGENT="${PWD#"$BASE"/agents/}"; AGENT="${AGENT%%/*}" ;;
    "$BASE") AGENT="$MAIN" ;;
  esac
fi
case "$AGENT" in */*|.*) AGENT="" ;; esac

SOURCE="none"; TOKEN=""
read_shared() { TOKEN="$(read_token "$STORE/.dashboard-token")"; }
case "$KIND" in
  shared)
    read_shared; [ -n "$TOKEN" ] && SOURCE="shared" ;;
  *)
    if [ "$KIND" = "operator" ]; then
      TOKEN="$(read_token "$STORE/.operator-token")"; OWN_SOURCE="operator"
    else
      OWN_SOURCE="agent"
      if [ -n "${MARVEEN_AGENT_TOKEN_FILE:-}" ]; then
        TOKEN="$(read_token "$MARVEEN_AGENT_TOKEN_FILE")"
      elif [ -n "$AGENT" ]; then
        if [ "$AGENT" = "$MAIN" ]; then TOKEN="$(read_token "$BASE/.agent-token")"
        else TOKEN="$(read_token "$BASE/agents/$AGENT/.agent-token")"; fi
      fi
    fi
    if [ -n "$TOKEN" ]; then SOURCE="$OWN_SOURCE"
    else
      read_shared; [ -n "$TOKEN" ] && SOURCE="shared-fallback"
    fi ;;
esac
[ "${AGENT_API_VERBOSE:-}" = "1" ] && echo "agent-api: token source=$SOURCE agent=${AGENT:-?}" >&2

PORT="${MARVEEN_WEB_PORT:-${WEB_PORT:-$(env_file_value WEB_PORT)}}"
URL="${DASHBOARD_BASE_URL:-http://localhost:${PORT:-3420}}${APIPATH}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-api.XXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

ARGS=(-sS -X "$METHOD" -w $'\n%{http_code}' -H "Content-Type: application/json")
[ -n "$AGENT" ] && ARGS+=(-H "X-Agent-Id: $AGENT")
if [ -n "$BODY" ]; then
  if [ "$BODY" = "-" ]; then cat > "$TMP/body"; ARGS+=(--data-binary "@$TMP/body")
  elif [ "${BODY#@}" != "$BODY" ]; then ARGS+=(--data-binary "$BODY")
  else printf '%s' "$BODY" > "$TMP/body"; ARGS+=(--data-binary "@$TMP/body"); fi
fi

# printf is a shell builtin: the token reaches curl through a pipe, never through argv.
if [ -n "$TOKEN" ]; then
  RESP="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -K - "${ARGS[@]}" "$URL")"; RC=$?
else
  RESP="$(curl "${ARGS[@]}" "$URL" </dev/null)"; RC=$?
fi
[ "$RC" -eq 0 ] || exit "$RC"
CODE="${RESP##*$'\n'}"
printf '%s\n' "${RESP%$'\n'*}"
case "$CODE" in 2??) exit 0 ;; *) echo "agent-api: HTTP $CODE ($METHOD $APIPATH)" >&2; exit 22 ;; esac
