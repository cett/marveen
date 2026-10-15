#!/usr/bin/env bash
# memory-maintenance.sh -- the nightly memory maintenance, run by the seeded `memory-maintenance` command task.
#
# Usage: bash scripts/memory-maintenance.sh <agent-id>
#
# Two dashboard calls in order, the second only after the first succeeded:
#   1. POST /api/memories/resort          tier reassignment and version pruning
#   2. POST /api/memories/links/maintain  link-graph upkeep
# Exit codes (what the command task makes of them):
#   0   both calls succeeded and every memory was linked
#   1   a call failed (HTTP error, no answer, no "ok":true): a failed run, the task alerts
#   42  both calls succeeded but `linksFailed` says some memories could not be linked: a FINDING (the command-task
#       findings code, src/web/command-task.ts): one alert when it starts, not an error span. A dashboard that
#       predates that code counts 42 as a failed run, which is loud as well, never silent.
#   2   usage error
# The dashboard itself answers 500 (so exit 1 here) when most memories failed: that is an environment fault.
#
# Env: MEMORY_MAINTENANCE_API  the API wrapper to call (default: agent-api.sh next to this script), for tests.
# Portable to macOS /bin/bash 3.2.
set -uo pipefail

EXIT_FINDINGS=42
AGENT="${1:-}"
if [ -z "$AGENT" ]; then
  echo "usage: memory-maintenance.sh <agent-id>" >&2
  exit 2
fi
API="${MEMORY_MAINTENANCE_API:-$(cd "$(dirname "$0")" && pwd)/agent-api.sh}"

# call <path> <max-seconds>: sets OUT to the response body; returns 0 only on a 2xx that says "ok":true.
call() {
  OUT=$(bash "$API" --agent "$AGENT" --max-time "$2" POST "$1" '{}' 2>/dev/null)
  local rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$OUT" | grep -q '"ok":true'; then
    echo "memory-maintenance: $1 failed (exit $rc): $(printf '%s' "$OUT" | head -c 200)" >&2
    return 1
  fi
  return 0
}

call /api/memories/resort 120 || exit 1
call /api/memories/links/maintain 300 || exit 1

FAILED=$(printf '%s' "$OUT" | grep -o '"linksFailed":[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "${FAILED:-0}" -gt 0 ]; then
  echo "memory-maintenance: link maintenance could not link ${FAILED} memories (see the dashboard log)" >&2
  exit "$EXIT_FINDINGS"
fi
exit 0
