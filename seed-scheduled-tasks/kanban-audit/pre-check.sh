#!/usr/bin/env bash
# Pre-check for kanban-audit:
# Skip the LLM if there are no 7+ day done cards to archive AND no stuck
# in_progress cards since the last audit.
# Reads through the dashboard API (the kanban board and the agent_state store),
# not the database file. Fail open (non-zero exit -> the runner starts the LLM)
# instead of a silent SKIP when the dashboard, curl or python3 is unavailable.
# The calls go through the API wrapper, which resolves the agent's own token
# (the token never appears on a command line).
API="{{INSTALL_DIR}}/scripts/agent-api.sh"
AGENT_ID="{{MAIN_AGENT_ID}}"
command -v curl >/dev/null 2>&1 || exit 1
command -v python3 >/dev/null 2>&1 || exit 1
[ -r "$API" ] || exit 1

# The board listing already leaves archived cards out. It also archives done
# cards past the dashboard's own window (KANBAN_ARCHIVE_DONE_DAYS), which can be
# longer than the 7 days counted here, so those are still left for the audit.
CARDS=$(bash "$API" --agent "$AGENT_ID" --max-time 10 GET /api/kanban 2>/dev/null) || exit 1

# Last audit timestamp lives in agent_state (migrated from kanban-audit-state.json).
# 404 = no audit has run yet; any other non-200 answer is a failure, not "never".
# The wrapper exits 22 on a non-2xx answer (the 404 case) but still prints the body.
STATE=$(bash "$API" --agent "$AGENT_ID" --max-time 10 --with-status \
  GET "/api/agent-state/$AGENT_ID/kanban_audit_last_audit_at" 2>/dev/null)
STATE_RC=$?
[ "$STATE_RC" -eq 0 ] || [ "$STATE_RC" -eq 22 ] || exit 1
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
