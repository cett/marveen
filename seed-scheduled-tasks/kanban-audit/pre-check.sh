#!/usr/bin/env bash
# Pre-check for kanban-audit:
# Skip the LLM if there are no 7+ day done cards to archive AND no stuck
# in_progress cards since the last audit.
DB="$HOME/marveen/store/claudeclaw.db"

DONE_COUNT=$(sqlite3 "$DB" "
SELECT COUNT(*) FROM kanban_cards
WHERE status = 'done'
  AND archived_at IS NULL
  AND updated_at < strftime('%s','now','-7 days');
" 2>/dev/null)

# Last audit timestamp lives in agent_state (migrated from kanban-audit-state.json).
LAST_AUDIT=$(sqlite3 "$DB" "
SELECT CAST(state_value AS INTEGER) FROM agent_state
WHERE agent_id = '{{MAIN_AGENT_ID}}' AND state_key = 'kanban_audit_last_audit_at';
" 2>/dev/null)
LAST_AUDIT=${LAST_AUDIT:-0}

STUCK_COUNT=$(sqlite3 "$DB" "
SELECT COUNT(*) FROM kanban_cards
WHERE status = 'in_progress'
  AND archived_at IS NULL
  AND updated_at < ${LAST_AUDIT};
" 2>/dev/null)

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
