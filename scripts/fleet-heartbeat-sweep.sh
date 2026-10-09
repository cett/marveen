#!/usr/bin/env bash
# Fleet memory-heartbeat sweep.
# Triggered 4-hourly by the main agent scheduled task `memoria-heartbeat-fleet`.
# Sequentially (staggered) instructs every RUNNING fleet sub-agent to run its own
# memory-heartbeat (memory save + skill reflection). Fleet membership is discovered
# live from /api/agents -- NOT hardcoded; agents that serve only non-default tenants are
# skipped (see TENANT_ONLY below). Runs in the background so the main agent's turn returns
# immediately.
#
# Usage: fleet-heartbeat-sweep.sh [stagger_seconds]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="http://localhost:3420"
# The sweep runs on the coordinator's behalf: its own admin token (the shared one only if that file
# is missing), through the wrapper -- the token never goes on a command line.
api() { DASHBOARD_BASE_URL="$API" bash "$ROOT/scripts/agent-api.sh" --token main "$@" 2>/dev/null; }

_read_main_agent_id() {
  local env_file="$ROOT/.env"
  if [[ -f "$env_file" ]]; then
    local val
    val="$(grep '^MAIN_AGENT_ID=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"
    val="${val//\"/}"; val="${val//\'/}"
    [[ -n "$val" ]] && { echo "$val"; return; }
  fi
  echo "marveen"
}
MAIN_AGENT="${MAIN_AGENT_ID:-$(_read_main_agent_id)}"  # coordinator; excluded from the sweep (has its own heartbeat)
STAGGER="${1:-60}"           # seconds between agents, avoids a fleet-wide token spike
LOG="$ROOT/store/fleet-heartbeat-sweep.log"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# The directive each sub-agent receives. Self-contained: every agent knows its own
# agent_id + domain from its CLAUDE.md/persona. Silent unless something is important.
read -r -d '' DIRECTIVE <<'EOF' || true
[memoria-heartbeat] Ideje a periodikus memoria-heartbeatednek. Vegezd el a sajat agent_id-ddel:
1) Nezd at az elmult idoszak munkadat. Ha volt fontos dontes, preferencia, tanulsag vagy szakmai minta, mentsd el a /api/memories-be (category: hot/warm/cold/shared). Elotte keress ra, ne duplikalj.
2) Skill-reflexio: ha volt 5+ tool-hivasos komplex feladat, hiba->recovery, vagy Jonas-korrekcio, generalj vagy patch-elj skillt (a sajat mappadban), majd index-regen.
3) Ha nincs erdemi uj info, maradj csendben -- ez hatter-karbantartas, NE irj Jonasnak, csak ha tenyleg surgos.
EOF

# Fan-out quota guard. The per-task quota gate sees ONE gate decision, but this sweep
# multiplies it into N sub-agent heartbeat turns (1 decision -> N model calls) that the
# gate cannot account for. Above a fan-out-adjusted threshold, skip the whole sweep so a
# high-quota window is never blown by background heartbeats.
# Reads the rate-limit block the statusLine writes on every render
# (scripts/statusline-ratelimit.sh -> store/.claude-rate-limits.json, the file the dashboard
# quota strip reads too, src/web/quota.ts): {"written_at": <unix SEC>, "rate_limits":
# {"five_hour": {"used_percentage", "resets_at"}, "seven_day": {...}}}. Same rules as
# readQuotaSnapshot: a window counts only when used_percentage is a number and its resets_at
# (unix sec) is still in the future, since a rolled-over window describes a period that is gone;
# PCT is the larger of the counting windows.
# Like the per-task gate (src/quota-gate.ts, staleAfterMs) it only trusts a FRESH snapshot:
# a number older than QUOTA_STALE_MINUTES says nothing about now. Whenever there is no usable
# reading (no file, unreadable JSON, no written_at, stale, no counting window) the guard fails
# open and says exactly why in the log.
QUOTA_THRESHOLD="${QUOTA_THRESHOLD:-75}"
QUOTA_STALE_MINUTES="${QUOTA_STALE_MINUTES:-20}"
RATE_FILE="$ROOT/store/.claude-rate-limits.json"
if [ ! -f "$RATE_FILE" ]; then
  echo "[$(ts)] rate-limit snapshot missing ($RATE_FILE) -- fan-out guard fails open" >> "$LOG"
elif ! jq -e 'type == "object"' "$RATE_FILE" >/dev/null 2>&1; then
  echo "[$(ts)] rate-limit snapshot unreadable (not a JSON object) -- fan-out guard fails open" >> "$LOG"
else
  NOW_S="$(date +%s)"
  WRITTEN_S="$(jq -r 'if (.written_at | type) == "number" then (.written_at | floor) else empty end' "$RATE_FILE" 2>/dev/null || true)"
  if ! [[ "$WRITTEN_S" =~ ^[0-9]+$ ]]; then
    echo "[$(ts)] rate-limit snapshot has no written_at -- fan-out guard fails open" >> "$LOG"
  elif [ $(( NOW_S - WRITTEN_S )) -gt $(( QUOTA_STALE_MINUTES * 60 )) ]; then
    echo "[$(ts)] rate-limit snapshot stale ($(( (NOW_S - WRITTEN_S) / 60 ))m > ${QUOTA_STALE_MINUTES}m) -- fan-out guard fails open" >> "$LOG"
  else
    PCT="$(jq -r --argjson now "$NOW_S" '
      (.rate_limits | if type == "object" then . else {} end) as $rl
      | [$rl.five_hour, $rl.seven_day]
      | map(select(type == "object"
                   and (.used_percentage | type) == "number"
                   and ((.resets_at | type) != "number" or .resets_at > $now))
            | .used_percentage)
      | if length == 0 then empty else (max | floor) end' "$RATE_FILE" 2>/dev/null || true)"
    if ! [[ "$PCT" =~ ^[0-9]+$ ]]; then
      echo "[$(ts)] rate-limit snapshot has no live rate_limits window (missing, malformed or already reset) -- fan-out guard fails open" >> "$LOG"
    elif [ "$PCT" -ge "$QUOTA_THRESHOLD" ]; then
      echo "[$(ts)] quota ${PCT}% >= ${QUOTA_THRESHOLD}% (fan-out guard) -- skipping fleet heartbeat sweep" >> "$LOG"
      exit 0
    fi
  fi
fi

echo "[$(ts)] fleet-heartbeat sweep start (stagger=${STAGGER}s)" >> "$LOG"

# An agent that serves ONLY non-default tenants is left out: the directive reaches it stamped
# with the default tenant (an admin-sent message always is), so the memories it saves would land
# in the default tenant, visible to the fleet and surviving the tenant's deletion. An agent counts
# as tenant-only when it is enabled for tenants and `default` is not among them, or when it is the
# main agent of a tenant other than `default`. A shared agent (enabled for `default` too) stays in.
# Missing tenant fields (an older /api/agents) read as "not tenant-only": nothing is skipped.
TENANT_ONLY='((.tenantIds // []) as $t | (($t | length) > 0 and ($t | index("default")) == null)) or ((.primaryTenantId // "default") != "default")'
AGENTS_JSON="$(api GET /api/agents || true)"
AGENTS="$(printf '%s' "$AGENTS_JSON" \
  | jq -r ".[] | select(.running==true) | select(($TENANT_ONLY) | not) | .name" 2>/dev/null | grep -vx "$MAIN_AGENT" || true)"
TENANT_SKIPPED="$(printf '%s' "$AGENTS_JSON" \
  | jq -r ".[] | select(.running==true) | select($TENANT_ONLY) | .name" 2>/dev/null | grep -vx "$MAIN_AGENT" || true)"
for SKIPPED in $TENANT_SKIPPED; do
  echo "[$(ts)]   -- $SKIPPED : skipped (serves only non-default tenants)" >> "$LOG"
done

if [ -z "$AGENTS" ]; then
  echo "[$(ts)] no running sub-agents found, nothing to do" >> "$LOG"
  exit 0
fi

COUNT=0
for AGENT in $AGENTS; do
  PAYLOAD="$(jq -nc --arg from "$MAIN_AGENT" --arg to "$AGENT" --arg content "$DIRECTIVE" \
    '{from:$from, to:$to, content:$content}')"
  RESP="$(printf '%s' "$PAYLOAD" | api --with-status POST /api/messages - | tail -n1 || true)"
  RESP="${RESP:-000}"
  echo "[$(ts)]   -> $AGENT : HTTP $RESP" >> "$LOG"
  COUNT=$((COUNT+1))
  sleep "$STAGGER"
done

echo "[$(ts)] fleet-heartbeat sweep done ($COUNT agents triggered)" >> "$LOG"
