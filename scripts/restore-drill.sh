#!/usr/bin/env bash
# restore-drill.sh -- the weekly restore drill, run by the seeded `weekly-restore-drill` command task.
#
# Usage: bash scripts/restore-drill.sh
#
# Takes the newest backups/claudeclaw-*.tar.gz, extracts it into a throwaway directory (verify-restore.sh does
# that itself and cleans up) and runs `scripts/verify-restore.sh --drill` on it: checksum, gzip, tar, sentinels,
# token and vault separation, PRAGMA integrity_check, and the table/row counts against MANIFEST.txt. The last
# output line is one summary line with the counts ("N of M tables, X of Y rows"), which is what lands in the
# command-task health. Nothing is restored over the live installation.
#
# Fails (exit 1) when there is no archive, when the newest one is older than 36 hours (the nightly backup has
# stopped: the drill would otherwise happily verify an old archive and call it good), or when the verification
# fails. A drill that cannot run its checks (no sqlite3) fails too, see verify-restore.sh --drill.
#
# BACKUP_DIR overrides the archive directory (tests); DRILL_MAX_AGE_MIN the 36 hour limit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
MAX_AGE_MIN="${DRILL_MAX_AGE_MIN:-2160}"

NEWEST="$(ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | head -1 || true)"
if [[ -z "${NEWEST}" ]]; then
  echo "restore-drill: FAIL -- no backup archive in ${BACKUP_DIR}" >&2
  exit 1
fi

if [[ -n "$(find "${NEWEST}" -mmin "+${MAX_AGE_MIN}" 2>/dev/null)" ]]; then
  echo "restore-drill: FAIL -- the newest archive ($(basename "${NEWEST}")) is older than $((MAX_AGE_MIN / 60)) hours: the nightly backup has stopped" >&2
  exit 1
fi

OUT="$(bash "${REPO_ROOT}/scripts/verify-restore.sh" --drill "${NEWEST}" 2>&1)" && RC=0 || RC=$?
printf '%s\n' "${OUT}"

COUNTS="$(printf '%s\n' "${OUT}" | grep -E '^[[:space:]]*\[(OK|FAIL)\] .*tables?[ ,].*rows?' | head -1 | sed -E 's/^[[:space:]]*\[(OK|FAIL)\][[:space:]]+//' || true)"
if [[ ${RC} -eq 0 ]]; then
  echo "restore-drill: OK $(basename "${NEWEST}") -- ${COUNTS:-no row count line}"
else
  echo "restore-drill: FAIL $(basename "${NEWEST}") (verify-restore exit ${RC}) -- ${COUNTS:-no row count line}" >&2
fi
exit "${RC}"
