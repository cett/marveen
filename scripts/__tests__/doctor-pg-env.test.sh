#!/bin/bash
# Contract tests for the PostgreSQL .env check of the doctor (the ".env keys" section).
#
# A .env that holds MARVEEN_PG_URL or MARVEEN_PG_MIGRATE_URL must be readable by its owner only (mode 0600):
# a wider mode is a failure. The owner key in .env is a warning: the owner credentials belong to one migration
# run, not to the serving process. No PostgreSQL key: the check prints nothing. The check prints key names and the
# file mode, never a value.
#
# The doctor is run as a copy in a temp root with a fake .env; the other checks fail there on purpose (no
# dashboard, no tokens), so the cells look only at the PostgreSQL lines.
# Run: bash scripts/__tests__/doctor-pg-env.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${DOCTOR_BIN:-$INSTALL_DIR/scripts/doctor.sh}"

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/scripts/lib"
cp "$SRC" "$ROOT/scripts/doctor.sh"
cp "$INSTALL_DIR/scripts/lib/portable.sh" "$ROOT/scripts/lib/portable.sh" 2>/dev/null || true

# Placeholder secret: the cells assert it never reaches the output.
SECRET='postgresql://app-user:placeholder-secret@db.invalid:5432/marveen'

# run_doctor <env-file-content> <mode> -> PG_LINES (the PostgreSQL lines of the output), OUT_ALL (the whole output)
run_doctor() {
  # the owner bit is restored before the write: a previous cell may have left the file at 0400
  chmod u+rw "$ROOT/.env" 2>/dev/null || true
  printf '%s\n' "$1" > "$ROOT/.env"
  chmod "$2" "$ROOT/.env"
  OUT_ALL="$(cd "$ROOT" && WEB_PORT=9 timeout 120 bash scripts/doctor.sh 2>&1 || true)"
  PG_LINES="$(printf '%s\n' "$OUT_ALL" | grep -E 'holds MARVEEN_PG|MARVEEN_PG_MIGRATE_URL is in' || true)"
}

# 1. 0600 with the serving URL: an owner-only line, no failure
run_doctor "MARVEEN_PG_URL=$SECRET" 600
if printf '%s' "$PG_LINES" | grep -q 'owner-only' && ! printf '%s' "$PG_LINES" | grep -q 'must be 0600'; then
  pass "mode 0600 with the serving URL passes"
else
  fail "mode 0600 with the serving URL passes" "an owner-only line, no 0600 failure" "$PG_LINES"
fi

# 2. 0644 with the serving URL: a failure that names the mode
run_doctor "MARVEEN_PG_URL=$SECRET" 644
if printf '%s' "$PG_LINES" | grep -q 'must be 0600' && printf '%s' "$PG_LINES" | grep -q 'mode 644'; then
  pass "mode 0644 with the serving URL fails and names the mode"
else
  fail "mode 0644 with the serving URL fails" "a 'must be 0600' line naming mode 644" "$PG_LINES"
fi

# 2b. 0640: a group read bit is wider than 0600: a failure (the mask must catch group bits, not only other bits)
run_doctor "MARVEEN_PG_URL=$SECRET" 640
if printf '%s' "$PG_LINES" | grep -q 'must be 0600' && printf '%s' "$PG_LINES" | grep -q 'mode 640'; then
  pass "mode 0640 with the serving URL fails (group bits count)"
else
  fail "mode 0640 with the serving URL fails" "a 'must be 0600' line naming mode 640" "$PG_LINES"
fi

# 2c. 0400: owner read-only is narrower than 0600: owner-only passes
run_doctor "MARVEEN_PG_URL=$SECRET" 400
if printf '%s' "$PG_LINES" | grep -q 'owner-only' && ! printf '%s' "$PG_LINES" | grep -q 'must be 0600'; then
  pass "mode 0400 with the serving URL passes"
else
  fail "mode 0400 with the serving URL passes" "an owner-only line, no 0600 failure" "$PG_LINES"
fi

# 3. the owner key in .env, mode 0600: a warning that names the key
run_doctor "$(printf 'MARVEEN_PG_URL=%s\nMARVEEN_PG_MIGRATE_URL=%s' "$SECRET" "$SECRET")" 600
if printf '%s' "$PG_LINES" | grep -q 'MARVEEN_PG_MIGRATE_URL is in .env'; then
  pass "the owner key in .env warns"
else
  fail "the owner key in .env warns" "a MARVEEN_PG_MIGRATE_URL warning" "$PG_LINES"
fi

# 4. no PostgreSQL key: silent (a SQLite install prints nothing new)
run_doctor "TELEGRAM_BOT_TOKEN=placeholder-token" 600
if [ -z "$PG_LINES" ]; then
  pass "no PostgreSQL key: the check is silent"
else
  fail "no PostgreSQL key: silent" "no PostgreSQL line" "$PG_LINES"
fi

# 5. across the cells, the secret value never reaches the output (the wide-mode, both-keys case here)
run_doctor "$(printf 'MARVEEN_PG_URL=%s\nMARVEEN_PG_MIGRATE_URL=%s' "$SECRET" "$SECRET")" 644
if ! printf '%s' "$OUT_ALL" | grep -q 'placeholder-secret'; then
  pass "the URL value is never printed"
else
  fail "the URL value is never printed" "no placeholder-secret in the output" "value found in output"
fi

# 6. a symlinked .env is judged by the mode of its target (stat -L): the 0600 target passes. Last cell: it replaces .env.
REAL="$ROOT/real-env"
printf '%s\n' "MARVEEN_PG_URL=$SECRET" > "$REAL"
chmod 600 "$REAL"
ln -sfn "$REAL" "$ROOT/.env"
OUT_ALL="$(cd "$ROOT" && WEB_PORT=9 timeout 120 bash scripts/doctor.sh 2>&1 || true)"
PG_LINES="$(printf '%s\n' "$OUT_ALL" | grep -E 'holds MARVEEN_PG|MARVEEN_PG_MIGRATE_URL is in' || true)"
if printf '%s' "$PG_LINES" | grep -q 'owner-only' && ! printf '%s' "$PG_LINES" | grep -q 'must be 0600'; then
  pass "a symlinked .env is judged by its target's mode (0600 passes)"
else
  fail "a symlinked .env is judged by its target's mode" "an owner-only line, no 0600 failure" "$PG_LINES"
fi

# 7. a symlinked .env whose target is 0644 fails: the link is judged by its target, not the link itself
REAL2="$ROOT/real-env-wide"
printf '%s\n' "MARVEEN_PG_URL=$SECRET" > "$REAL2"
chmod 644 "$REAL2"
ln -sfn "$REAL2" "$ROOT/.env"
OUT_ALL="$(cd "$ROOT" && WEB_PORT=9 timeout 120 bash scripts/doctor.sh 2>&1 || true)"
PG_LINES="$(printf '%s\n' "$OUT_ALL" | grep -E 'holds MARVEEN_PG|MARVEEN_PG_MIGRATE_URL is in' || true)"
if printf '%s' "$PG_LINES" | grep -q 'must be 0600' && printf '%s' "$PG_LINES" | grep -q 'mode 644'; then
  pass "a symlinked .env whose target is 0644 fails"
else
  fail "a symlinked .env whose target is 0644 fails" "a 'must be 0600' line naming mode 644" "$PG_LINES"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
