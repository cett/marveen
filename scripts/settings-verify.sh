#!/usr/bin/env bash
# settings-verify.sh -- rollout verification for #953 (settings screen
# refactor). Dumps every registry setting's live value, sorted by key, so a
# before/after diff proves the UI-grouping refactor caused zero value drift.
#
# Usage:
#   scripts/settings-verify.sh before   # run before deploy
#   scripts/settings-verify.sh after    # run after deploy
#   diff settings-before.txt settings-after.txt   # expected: empty output
#
# Exit codes: 0 = dump saved (>= 60 keys); 1 = fetch failed or truncated.

set -euo pipefail

MODE="${1:-before}"
OUTPUT="settings-${MODE}.txt"
PORT="${WEB_PORT:-3420}"
TOKEN_FILE="${TOKEN_FILE:-store/.dashboard-token}"

if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "Nincs dashboard token: ${TOKEN_FILE}" >&2
  exit 1
fi

curl -sf \
  -H "Authorization: Bearer $(cat "${TOKEN_FILE}")" \
  "http://localhost:${PORT}/api/settings" \
| jq -r '.settings | sort_by(.key) | .[] | "\(.key)=\(.value // "")"' \
> "${OUTPUT}"

COUNT=$(wc -l < "${OUTPUT}" | tr -d ' ')
echo "Mentve: ${OUTPUT} (${COUNT} kulcs)"

# The registry currently has 69 entries; anything under 60 means the fetch
# truncated (e.g. auth failure returning an error body jq still parsed as
# empty) rather than genuinely shrinking the registry.
if [[ "${COUNT}" -lt 60 ]]; then
  echo "FIGYELEM: vártnál kevesebb kulcs (${COUNT} < 60) -- ellenőrizd a fetch-et" >&2
  exit 1
fi
