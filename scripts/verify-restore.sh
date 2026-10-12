#!/usr/bin/env bash
# verify-restore.sh -- verify a Marveen backup archive before restoring.
#
# Usage: scripts/verify-restore.sh <archive.tar.gz>
#
# Checks performed:
#   1. Archive file exists and is readable.
#   2. SHA-256 checksum matches the .sha256 sidecar (if present).
#   3. gzip stream is not corrupt (gzip -t).
#   4. tar listing succeeds (no broken entries).
#   5. Required sentinel files are present inside the archive.
#      Also: the vault master key must NOT be inside the archive (it lives in a
#      separate <archive>.vault-key file); a vault.json without that sidecar next
#      to the archive is reported as a warning (the operator may have moved it).
#   6. Embedded DB is extracted to a temp dir and PRAGMA integrity_check runs.
#   7. No agent/operator token file may be inside the archive (FAIL), and an archive whose
#      shared token row is older than the live one is flagged (WARN): restoring it brings
#      the replaced shared token back. The output ends with the token steps to run after a
#      restore; restore_log gets "token-step pending".
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed.
# Result is also written to restore_log in the live DB (if sqlite3 is present).

set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "${ARCHIVE}" ]]; then
  echo "Usage: $0 <archive.tar.gz>" >&2
  exit 1
fi

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "verify-restore: ERROR -- file not found: ${ARCHIVE}" >&2
  exit 1
fi

ARCHIVE="$(cd "$(dirname "${ARCHIVE}")" && pwd)/$(basename "${ARCHIVE}")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
NOTE=""

check_pass() { echo "  [OK] $1"; }
check_fail() { echo "  [FAIL] $1" >&2; FAIL=$((FAIL+1)); NOTE="${NOTE}FAIL:$1; "; }

echo "verify-restore: checking ${ARCHIVE}"
echo ""

# 1. Checksum
SIDECAR="${ARCHIVE%.tar.gz}.sha256"
if [[ -f "${SIDECAR}" ]]; then
  echo "[1] Checksum verification..."
  if command -v sha256sum >/dev/null 2>&1; then
    if (cd "$(dirname "${ARCHIVE}")" && sha256sum -c "$(basename "${SIDECAR}")" >/dev/null 2>&1); then
      check_pass "sha256 matches sidecar"
    else
      check_fail "sha256 MISMATCH -- archive may be corrupt or tampered"
    fi
  elif command -v shasum >/dev/null 2>&1; then
    if (cd "$(dirname "${ARCHIVE}")" && shasum -a 256 -c "$(basename "${SIDECAR}")" >/dev/null 2>&1); then
      check_pass "sha256 matches sidecar"
    else
      check_fail "sha256 MISMATCH -- archive may be corrupt or tampered"
    fi
  else
    echo "  [SKIP] sha256sum/shasum not found -- skipping checksum check"
  fi
else
  echo "  [SKIP] No .sha256 sidecar found (older backup) -- skipping checksum"
fi

# 2. gzip integrity
echo "[2] gzip stream integrity..."
if gzip -t "${ARCHIVE}" 2>/dev/null; then
  check_pass "gzip stream OK"
else
  check_fail "gzip stream corrupt"
fi

# 3. tar listing
echo "[3] tar listing..."
if tar -tzf "${ARCHIVE}" >/dev/null 2>&1; then
  check_pass "tar listing OK"
else
  check_fail "tar listing failed"
fi

# One listing for steps 4 and 4b. Match with here-strings, NOT `printf | grep -q`:
# grep -q exits on the first hit, the writer gets SIGPIPE, and under pipefail the
# pipeline reads as "no match" once the listing outgrows the pipe buffer (~64 KB).
ARCHIVE_LISTING="$(tar -tzf "${ARCHIVE}" 2>/dev/null || true)"

# 4. Sentinel files
echo "[4] Required files present..."
REQUIRED=(
  "MANIFEST.txt"
  "repo/store/claudeclaw.db"
)
for sentinel in "${REQUIRED[@]}"; do
  if grep -qF "${sentinel}" <<<"${ARCHIVE_LISTING}"; then
    check_pass "${sentinel} present"
  else
    check_fail "${sentinel} MISSING"
  fi
done

# 4b. Vault key separation
echo "[4b] Vault key separation..."
if grep -qE '(^|/)\.vault-key(\.migrated)?$' <<<"${ARCHIVE_LISTING}"; then
  check_fail "vault master key found INSIDE the archive (must be a separate file)"
else
  check_pass "no vault master key inside the archive"
fi
if grep -qF "repo/store/vault.json" <<<"${ARCHIVE_LISTING}"; then
  KEY_SIDECAR="${ARCHIVE%.tar.gz}.vault-key"
  if [[ -f "${KEY_SIDECAR}" ]]; then
    check_pass "vault key sidecar present ($(basename "${KEY_SIDECAR}"))"
  else
    echo "  [WARN] vault.json is archived but $(basename "${KEY_SIDECAR}") is not next to it -- keep the key file safe elsewhere, the vault cannot be decrypted without it"
  fi
fi

# 4c. Token files stay out of the archive. The per-agent and operator token files are re-issued after a
# restore (npm run agent-tokens); one inside the archive means the backup scope changed.
echo "[4c] Token files outside the archive..."
if grep -qE '(^|/)\.(agent|operator)-token$' <<<"${ARCHIVE_LISTING}"; then
  check_fail "an agent or operator token file is INSIDE the archive (the backup scope changed; they are re-issued, never archived)"
else
  check_pass "no agent or operator token file inside the archive"
fi

# 5. DB integrity_check
echo "[5] DB integrity check..."
TMPDIR_EXTRACT="$(mktemp -d -t verify-restore.XXXXXX)"
trap 'rm -rf "${TMPDIR_EXTRACT}"' EXIT

if tar -xzf "${ARCHIVE}" -C "${TMPDIR_EXTRACT}" repo/store/claudeclaw.db 2>/dev/null; then
  EXTRACTED_DB="${TMPDIR_EXTRACT}/repo/store/claudeclaw.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    IC="$(sqlite3 "${EXTRACTED_DB}" 'PRAGMA integrity_check(1);' 2>/dev/null || echo 'error')"
    if [[ "${IC}" == "ok" ]]; then
      check_pass "PRAGMA integrity_check: ok"
      INTEGRITY_OK=1
    else
      check_fail "PRAGMA integrity_check: ${IC}"
      INTEGRITY_OK=0
    fi
  else
    echo "  [SKIP] sqlite3 not found -- skipping DB integrity check"
    INTEGRITY_OK=1
  fi
else
  check_fail "Could not extract DB from archive"
  INTEGRITY_OK=0
fi

# 5b. Shared token resurrection. The archive carries the `dashboard` token row (and the token file). When
# the shared token was rotated after this archive was taken, restoring it makes the old, replaced shared
# token valid again. A warning, not a failure: the archive is healthy, the operator must rotate again.
echo "[5b] Shared token age..."
# The comparison runs in the agent-tokens CLI (it opens the extracted copy and the live database), never
# on the live database from here. Skipped when there is no live database yet (a fresh machine: running
# the CLI would create one in front of the restore) or no node_modules.
DB_PATH="${REPO_ROOT}/store/claudeclaw.db"
SHARED_AGE="unknown"
if [[ -n "${EXTRACTED_DB:-}" && -f "${EXTRACTED_DB}" && -f "${DB_PATH}" && -d "${REPO_ROOT}/node_modules" ]]; then
  SHARED_AGE="$(cd "${REPO_ROOT}" && npm run --silent agent-tokens -- archive-shared-age "${EXTRACTED_DB}" 2>/dev/null | tail -1 || true)"
fi
case "${SHARED_AGE}" in
  predates)
    echo "  [WARN] the archive predates the last rotation of the shared token (its dashboard token row is older than the live one): restoring it brings the old shared token back to life -- rotate the shared token again after the restore"
    NOTE="${NOTE}WARN:archive predates shared token rotation; "
    ;;
  current)
    check_pass "the archive's shared token is not older than the live one"
    ;;
  *)
    echo "  [SKIP] no live database, no api_tokens table, or the agent-tokens CLI is not available -- skipping the shared token age check"
    ;;
esac

# --- Summary ---
echo ""
if [[ ${FAIL} -eq 0 ]]; then
  echo "verify-restore: ALL CHECKS PASSED -- archive appears healthy"
  EXIT_CODE=0
else
  echo "verify-restore: ${FAIL} CHECK(S) FAILED -- do NOT restore without investigation" >&2
  EXIT_CODE=1
fi
echo ""
echo "After the restore, BEFORE the dashboard and the agents start (the token files are not in the archive):"
echo "  1. npm run agent-tokens -- issue"
echo "  2. npm run agent-tokens -- issue-operator"
echo "  3. if the archive predates a rotation of the shared token (warning above): with the dashboard stopped,"
echo "     delete store/.dashboard-token; the next dashboard start draws a fresh one and revokes the old row"
echo "  4. npm run agent-tokens -- check   (and scripts/doctor.sh)"

# Write to restore_log (best-effort; never abort on failure; DB_PATH is set at step 5b)
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "${DB_PATH}" ]]; then
  # Compute checksum for the log
  CHECKSUM=""
  if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    CHECKSUM="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
  fi
  LOG_NOTE="verify-restore: ${FAIL} failed check(s). ${NOTE}token-step pending"
  sqlite3 "${DB_PATH}" \
    "INSERT INTO restore_log (archive_path, checksum, integrity_ok, note) VALUES ('${ARCHIVE}', '${CHECKSUM}', ${INTEGRITY_OK:-0}, '${LOG_NOTE}');" \
    2>/dev/null || true
fi

exit ${EXIT_CODE}
