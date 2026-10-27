#!/usr/bin/env bash
# agent-api.sh -- the one supported way for a shell recipe to call the dashboard API.
#
# Usage:  bash scripts/agent-api.sh [options] METHOD PATH [BODY]
#   METHOD   GET | POST | PUT | PATCH | DELETE
#   PATH     /api/..., query string included, e.g. "/api/memories?agent=alpha&q=term"
#   BODY     a JSON string, "-" to read it from STDIN, or "@file" to send that file as is
# Options (before METHOD):
#   --agent ID          act as this agent (default: MARVEEN_AGENT_ID, else derived from the cwd, else
#                       from CLAUDE_CONFIG_DIR: a worktree or scratch cwd names nobody, the launch does)
#   --max-time SECS     give up on the request after SECS seconds (default: no limit)
#   --with-status       print the HTTP status as a last extra line after the body (what
#                       `curl -w '\n%{http_code}'` gave), for scripts that branch on 201 vs 200
#   --token KIND        agent (default) | operator | admin | main
#                         agent     the agent's own token (agents/<id>/.agent-token, the main
#                                   agent's in the install root)
#                         operator  store/.operator-token
#                         admin     for a call that needs admin:all whoever makes it: the main
#                                   agent uses its own (admin) token; every other agent is refused
#                                   here (exit 3) and told to ask the main agent through
#                                   /api/messages
#                         main      act as the main agent whoever runs it: for system scripts run on
#                                   the coordinator's behalf (its own admin token)
# There is no shared-token kind and no fallback to it: store/.dashboard-token is not read here.
# Output: the response body on stdout. Exit 0 on a 2xx; 22 on any other HTTP status (the status
# line goes to stderr, the body is still printed); curl's own code when the request never got an
# answer; 2 on a usage error; 3 when there is no token to send (no own token file, or an admin
# call by an agent that is not the main one): NO request is made then.
#
# The token never appears on a command line: it is handed to curl as a config on STDIN
# (`curl -K -`), the body goes through a 0600 temp file. A token that is present but REFUSED
# (401, a revoked or stale file) is NOT retried on another token: that would hide the fault.
#
# Env: MARVEEN_AGENT_ID, MARVEEN_AGENT_TOKEN_FILE (explicit own-token file), MAIN_AGENT_ID,
#      DASHBOARD_BASE_URL (default http://localhost:<MARVEEN_WEB_PORT|WEB_PORT|.env|3420>).
# Portable to macOS /bin/bash 3.2.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${MARVEEN_STORE_DIR:-$BASE/store}"

usage() { sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

AGENT="${MARVEEN_AGENT_ID:-}"; KIND="agent"; MAXTIME=""; WITHSTATUS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) [ $# -ge 2 ] || usage; AGENT="$2"; shift 2 ;;
    --token) [ $# -ge 2 ] || usage; KIND="$2"; shift 2 ;;
    --max-time) [ $# -ge 2 ] || usage; MAXTIME="$2"; shift 2 ;;
    --with-status) WITHSTATUS=1; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) echo "agent-api: unknown option $1" >&2; usage ;;
    *) break ;;
  esac
done
[ "$KIND" = "shared" ] && { echo "agent-api: --token shared no longer exists: the shared dashboard token is not used by agents any more (use agent, or admin for the main agent)" >&2; exit 2; }
case "$KIND" in agent|operator|admin|main) : ;; *) echo "agent-api: --token must be agent, operator, admin or main" >&2; exit 2 ;; esac
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
# The agent this session was launched as, read from its config directory: <install>/agents/<id>/.claude-config
# is that agent's, <install>/.channels-config the main agent's. Empty when the directory names nobody (a system
# script, cron). It is sent as X-Caller-Config below: a measurement signal, never a credential.
CFG_AGENT=""
CFG="${CLAUDE_CONFIG_DIR:-}"
case "$CFG" in
  "$BASE"/agents/*)
    CFG_REST="${CFG#"$BASE"/agents/}"; CFG_ID="${CFG_REST%%/*}"
    case "${CFG_REST#"$CFG_ID"/}" in .claude-config|.claude-config/*) CFG_AGENT="$CFG_ID" ;; esac ;;
  "$BASE"/.channels-config|"$BASE"/.channels-config/*) CFG_AGENT="$MAIN" ;;
esac
# The value is derived from an environment variable and ends up in a header line and on stderr: letters, digits,
# '-' and '_' only, at most 64 characters, anything else (CR, LF, TAB, ESC, ':', a path segment) is dropped whole.
case "$CFG_AGENT" in *[!A-Za-z0-9_-]*|"") CFG_AGENT="" ;; esac
[ "${#CFG_AGENT}" -le 64 ] || CFG_AGENT=""

# How the acting agent was named: explicit (--agent or MARVEEN_AGENT_ID: the caller said so), root (the install
# root as cwd), cwd (an agent directory), config (the config directory), token-main (--token main).
AGENT_BY="explicit"
if [ -z "$AGENT" ]; then
  case "$PWD" in
    "$BASE"/agents/*) AGENT="${PWD#"$BASE"/agents/}"; AGENT="${AGENT%%/*}"; AGENT_BY="cwd" ;;
    "$BASE") AGENT="$MAIN"; AGENT_BY="root" ;;
  esac
fi
if [ -z "$AGENT" ] && [ -n "$CFG_AGENT" ]; then
  # A working directory that names nobody (a worktree, a scratch directory): the config directory
  # the session was launched with does.
  AGENT="$CFG_AGENT"; AGENT_BY="config"
fi
# The acting agent goes into a header line (X-Agent-Id) and a token path: the same allowlist as the launched agent
# above (letters, digits, '-' and '_', at most 64 characters), whichever way it was named. Anything else is
# dropped whole, which ends in the "no token for an unknown agent" exit below, with no request made.
case "$AGENT" in *[!A-Za-z0-9_-]*) AGENT="" ;; esac
[ "${#AGENT}" -le 64 ] || AGENT=""

if [ "$KIND" = "main" ]; then
  AGENT="$MAIN"; KIND="agent"; AGENT_BY="token-main"
  case "$AGENT" in *[!A-Za-z0-9_-]*) AGENT="" ;; esac
  [ "${#AGENT}" -le 64 ] || AGENT=""
fi
if [ "$KIND" = "admin" ]; then
  if [ -n "$AGENT" ] && [ "$AGENT" = "$MAIN" ]; then KIND="agent"
  else
    echo "agent-api: this call needs admin rights and only the main agent holds them: ask the main agent to make it (an inter-agent message through /api/messages)" >&2
    exit 3
  fi
fi
SOURCE="none"; TOKEN=""; TOKEN_PATH=""
if [ "$KIND" = "operator" ]; then
  TOKEN_PATH="$STORE/.operator-token"; TOKEN="$(read_token "$TOKEN_PATH")"; OWN_SOURCE="operator"
else
  OWN_SOURCE="agent"
  if [ -n "${MARVEEN_AGENT_TOKEN_FILE:-}" ]; then
    TOKEN_PATH="$MARVEEN_AGENT_TOKEN_FILE"; TOKEN="$(read_token "$TOKEN_PATH")"
  elif [ -n "$AGENT" ]; then
    if [ "$AGENT" = "$MAIN" ]; then TOKEN_PATH="$BASE/.agent-token"; else TOKEN_PATH="$BASE/agents/$AGENT/.agent-token"; fi
    TOKEN="$(read_token "$TOKEN_PATH")"
  fi
fi
if [ -n "$TOKEN" ]; then SOURCE="$OWN_SOURCE"
else
  # No own token: say so and make NO request (a call with no credentials, or on a borrowed one, would
  # only hide the fault). The fix is named so the next step is not a guess.
  if [ "$KIND" = "operator" ]; then FIX="npm run agent-tokens -- issue-operator"
  elif [ -n "$AGENT" ]; then FIX="npm run agent-tokens -- issue $AGENT"
  else FIX="set MARVEEN_AGENT_ID or run it as the agent"; fi
  echo "agent-api: no readable own token${TOKEN_PATH:+ ($TOKEN_PATH)} for ${AGENT:-an unknown agent}; the operator issues it with: $FIX" >&2
  exit 3
fi
[ "${AGENT_API_VERBOSE:-}" = "1" ] && echo "agent-api: token source=$SOURCE agent=${AGENT:-?}" >&2
# The acting agent came from the install-root working directory or from --token main, and it is not the agent
# this session was launched as (a sub-agent that cd'd to the install root, or asked for the main agent's token):
# the call goes out on that token as before. A notice only, nothing about the request changes.
if [ -n "$CFG_AGENT" ] && [ -n "$AGENT" ] && [ "$AGENT" != "$CFG_AGENT" ] && { [ "$AGENT_BY" = "root" ] || [ "$AGENT_BY" = "token-main" ]; }; then
  echo "agent-api: warning: acting as $AGENT (resolved from $AGENT_BY) but this session was launched as $CFG_AGENT; pass --agent $CFG_AGENT to act as yourself" >&2
fi

PORT="${MARVEEN_WEB_PORT:-${WEB_PORT:-$(env_file_value WEB_PORT)}}"
URL="${DASHBOARD_BASE_URL:-http://localhost:${PORT:-3420}}${APIPATH}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-api.XXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

ARGS=(-sS -X "$METHOD" -w $'\n%{http_code}' -H "Content-Type: application/json")
[ -n "$AGENT" ] && ARGS+=(-H "X-Agent-Id: $AGENT")
[ -n "$CFG_AGENT" ] && ARGS+=(-H "X-Caller-Config: $CFG_AGENT")
case "$MAXTIME" in ""|*[!0-9]*) [ -z "$MAXTIME" ] || { echo "agent-api: --max-time takes whole seconds" >&2; exit 2; } ;; *) ARGS+=(--max-time "$MAXTIME") ;; esac
if [ -n "$BODY" ]; then
  if [ "$BODY" = "-" ]; then cat > "$TMP/body"; ARGS+=(--data-binary "@$TMP/body")
  elif [ "${BODY#@}" != "$BODY" ]; then ARGS+=(--data-binary "$BODY")
  else printf '%s' "$BODY" > "$TMP/body"; ARGS+=(--data-binary "@$TMP/body"); fi
fi

# printf is a shell builtin: the token reaches curl through a pipe, never through argv.
RESP="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -K - "${ARGS[@]}" "$URL")"; RC=$?
[ "$RC" -eq 0 ] || exit "$RC"
CODE="${RESP##*$'\n'}"
printf '%s\n' "${RESP%$'\n'*}"
[ "$WITHSTATUS" -eq 1 ] && printf '%s\n' "$CODE"
case "$CODE" in 2??) exit 0 ;; *) echo "agent-api: HTTP $CODE ($METHOD $APIPATH)" >&2; exit 22 ;; esac
