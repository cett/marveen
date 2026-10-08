#!/usr/bin/env bash
# Pre-check for kanban-audit:
# Skip the LLM if there are no 7+ day done cards to archive AND no stuck
# in_progress cards since the last audit.
# Reads through the dashboard API (the kanban board and the agent_state store),
# not the database file. Fail open (non-zero exit -> the runner starts the LLM)
# instead of a silent SKIP when the dashboard, the token, curl or python3 is
# unavailable.
TOKEN_FILE="{{INSTALL_DIR}}/store/.dashboard-token"
BASE="http://localhost:{{WEB_PORT}}"
AGENT_ID="{{MAIN_AGENT_ID}}"
command -v curl >/dev/null 2>&1 || exit 1
command -v python3 >/dev/null 2>&1 || exit 1
[ -r "$TOKEN_FILE" ] || exit 1
TOKEN=$(cat "$TOKEN_FILE") || exit 1

# The board listing already leaves archived cards out. It also archives done
# cards past the dashboard's own window (KANBAN_ARCHIVE_DONE_DAYS), which can be
# longer than the 7 days counted here, so those are still left for the audit.
CARDS=$(curl -sf --max-time 10 -H "Authorization: Bearer $TOKEN" "$BASE/api/kanban") || exit 1

# Last audit timestamp lives in agent_state (migrated from kanban-audit-state.json).
# 404 = no audit has run yet; any other non-200 answer is a failure, not "never".
STATE=$(curl -s --max-time 10 -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/agent-state/$AGENT_ID/kanban_audit_last_audit_at") || exit 1
STATE_CODE=${STATE##*$'\n'}
STATE_BODY=${STATE%$'\n'*}
case "$STATE_CODE" in
  200) ;;
  404) STATE_BODY="" ;;
  *) exit 1 ;;
esac

# Prints "<done_count> <stuck_count>". A missing or unreadable last-audit value
# is 0, which makes the stuck count 0 (nothing is older than the epoch).
COUNTS=$(CARDS="$CARDS" STATE_BODY="$STATE_BODY" python3 -I -c '
import json, os, time
cards = json.loads(os.environ["CARDS"])
last = 0
body = os.environ["STATE_BODY"]
if body:
    try:
        last = int(float(json.loads(body)["value"]))
    except (ValueError, TypeError, KeyError):
        last = 0
week_ago = int(time.time()) - 7 * 86400
done = sum(1 for c in cards if c.get("status") == "done" and not c.get("archived_at") and c["updated_at"] < week_ago)
stuck = sum(1 for c in cards if c.get("status") == "in_progress" and not c.get("archived_at") and c["updated_at"] < last)
print(done, stuck)
') || exit 1
read -r DONE_COUNT STUCK_COUNT <<<"$COUNTS"

DONE_COUNT=${DONE_COUNT:-0}
STUCK_COUNT=${STUCK_COUNT:-0}

if [ "$DONE_COUNT" -eq 0 ] && [ "$STUCK_COUNT" -eq 0 ]; then
  echo "SKIP"
else
  PARTS=()
  [ "$DONE_COUNT" -gt 0 ] && PARTS+=("${DONE_COUNT} archivalandó done kartya (7+ nap)")
  [ "$STUCK_COUNT" -gt 0 ] && PARTS+=("${STUCK_COUNT} beakadt in_progress (előző audit óta nem mozdult)")
  echo "Audit szükseges: $(IFS=', '; echo "${PARTS[*]}")."
fi
