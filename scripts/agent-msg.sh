#!/usr/bin/env bash
# agent-msg.sh -- reliable inter-agent message send for the Marveen fleet.
#
# WHY: the common `curl -s ... >/dev/null && echo sent` pattern is DANGEROUS -- curl exits 0 even when
# the server REJECTED the request (401/400/5xx), producing a SILENT send failure: the recipient never
# gets the message and two agents can wait on each other forever. The /api/messages router itself is
# fine (HTTP 200 + a message id); the bug is that the SENDER never checks the result. This helper checks
# the HTTP status AND the returned message id, and RETRIES on failure. A message counts as sent only
# when an id came back.
#
# Usage:  bash scripts/agent-msg.sh <from> <to> "<content>"
#   content: plain text (quotes / newlines OK) -- the body is built with json.dumps (no quoting pitfalls).
#   large / multi-line content may come from STDIN when the 3rd arg is "-":
#     echo "<long text>" | bash scripts/agent-msg.sh <from> <to> -
# Output: success -> "OK id=<n>"; failure -> "FAIL <reason>" + a line in store/agent-msg-failures.log, exit 1.
# Env: MARVEEN_WEB_PORT (default 3420).
#      MARVEEN_HOMOGLYPH_BIN  the checker (default <repo>/scripts/lib/homoglyph.py)
set -uo pipefail

# base dir = the parent of this script's dir (scripts/..), so it works from any CWD / any install
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The call goes through scripts/agent-api.sh: the sender's OWN token (the dashboard takes the sender
# identity from it), the shared token only when that file is missing; never on a command line.
API="$BASE/scripts/agent-api.sh"
LOG="$BASE/store/agent-msg-failures.log"

FROM="${1:?from required}"; TO="${2:?to required}"; C="${3:?content required (or - for STDIN)}"
[ "$C" = "-" ] && C="$(cat)"
[ -r "$API" ] || { echo "FAIL: the API wrapper is missing: $API"; exit 1; }

# --- Homoglyph gate, BEFORE the payload is built -----------------------------
# On the RAW text, not on the JSON: json.dumps escapes a Cyrillic letter into
# \uXXXX, and a checker reading the encoded body would be looking at a string
# where the problem is no longer visible as a letter. The gate has to see what
# the sender typed.
#
# WHY IT IS HERE AND NOT IN EACH AGENT'S TOOLBOX. Measured 2026-09-24 across
# three agents: two had built this guard for themselves, independently, because
# both had been bitten by it; the third had no guard at all. And no CLAUDE.md
# prescribes those private wrappers -- they all name THIS helper. The result was
# predictable in hindsight: the agent who WROTE such a wrapper spent a whole day
# calling this script directly, with the check run beside it in a separate
# command instead of in front of it. One message went out contaminated while the
# checker printed "NEM KULDOM EL" next to it. The rule that needs remembering is
# not a rule; it has to sit in the path of the action.
#
# FAIL-OPEN ON A MISSING CHECKER, AND LOUDLY -- one of exactly TWO deliberate
# exceptions to the fork's fail-closed stance for hooks and gates (the other is
# the inter-agent branch of scripts/hooks/outgoing-copy-gate.py when a message
# body cannot be interpreted). This helper is the fleet's mandated message
# route: blocking every inter-agent message on an install whose lib file is
# absent would be a far worse failure than the one being prevented, and it
# would be a NEW failure, not today's. A missing checker is exactly today's
# state, so the honest behaviour is to send and say so on stderr. Everything
# else is closed: contaminated text with the checker PRESENT is refused (rc 3),
# and a checker that is present but fails is NOT a pass (rc 4).
# Overridable so the suite can measure the missing-checker branch too.
HG="${MARVEEN_HOMOGLYPH_BIN:-$BASE/scripts/lib/homoglyph.py}"
if [ -r "$HG" ] && command -v python3 >/dev/null 2>&1; then
  # THE CHECKER IS A VERDICT, NOT A FILTER: what goes out is the text the
  # sender typed, never the checker's stdout. A checker that exits 0 with EMPTY
  # stdout would otherwise make this helper send an empty message and report
  # OK -- a broken tool silently replacing the message instead of failing. The
  # exit code is the only thing read here.
  printf '%s' "$C" | python3 "$HG" >/dev/null
  HG_RC=$?
  case "$HG_RC" in
    0) : ;;
    # 3 is the checker's one documented refusal code; anything else is the
    # CHECKER failing, not the text. They must not share a message: "refused"
    # sends the sender to rewrite a word that may be perfectly fine, while a
    # crashed checker is an unmeasured send and the operator's problem.
    3) echo "FAIL: homoglyph gate refused the message; nothing was sent." >&2
       exit 3 ;;
    *) echo "FAIL: homoglyph checker CRASHED (rc=$HG_RC) at $HG; nothing was sent." >&2
       echo "  This is not a verdict on the text -- fix or unset MARVEEN_HOMOGLYPH_BIN." >&2
       exit 4 ;;
  esac
else
  echo "WARN: homoglyph checker not found at $HG -- sending UNCHECKED." >&2
fi

BODY="$(FROM="$FROM" TO="$TO" C="$C" python3 -c 'import json,os; print(json.dumps({"from":os.environ["FROM"],"to":os.environ["TO"],"content":os.environ["C"]}))')"

ERRF="$(mktemp "${TMPDIR:-/tmp}/agent-msg.XXXXXX")"; trap 'rm -f "$ERRF"' EXIT
attempt=0; max=3; CODE=""; ID=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  JSON="$(printf '%s' "$BODY" | bash "$API" --agent "$FROM" POST /api/messages - 2>"$ERRF")"; RC=$?
  if [ "$RC" -eq 0 ]; then CODE=200
  else CODE="$(sed -n 's/^agent-api: HTTP \([0-9]*\).*/\1/p' "$ERRF" | head -n1)"; fi
  ID="$(printf '%s' "$JSON" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("id","") if isinstance(d,dict) else "")
except Exception:
  print("")' 2>/dev/null)"
  if { [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; } && [ -n "$ID" ]; then
    echo "OK id=$ID"; exit 0
  fi
  sleep 1
done
echo "FAIL from=$FROM to=$TO http=${CODE:-?} id='$ID' (after $max tries)"
printf '%s\tFAIL\tfrom=%s\tto=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$FROM" "$TO" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
