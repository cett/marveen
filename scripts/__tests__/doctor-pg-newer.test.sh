#!/bin/bash
# Contract tests for the doctor's "running on a newer database" line (the Database section).
#
# The doctor asks the running dashboard (GET /api/admin/pg-runtime-status) instead of reading the PostgreSQL
# URL or the override itself. A PostgreSQL backend that reports runningOnNewerDatabase=true is a warning that names
# both versions and the override; false, a SQLite backend, or no answer adds no line. The line carries versions only.
#
# The doctor is run as a copy in a temp root with a stub scripts/agent-api.sh that answers from a fixture; the other
# checks fail there on purpose (no services, no dashboard), so the cells look only at the newer-database line.
# Run: bash scripts/__tests__/doctor-pg-newer.test.sh

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

# The stub answers the status route from $ROOT/fixture.json (absent = the route fails), every other path fails.
cat > "$ROOT/scripts/agent-api.sh" <<'STUB'
#!/bin/bash
for a in "$@"; do last="$a"; done
case "$last" in
  /api/admin/pg-runtime-status) [ -f "$(dirname "$0")/../fixture.json" ] || exit 1; cat "$(dirname "$0")/../fixture.json" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$ROOT/scripts/agent-api.sh"

# run_doctor <fixture json, or "none"> -> LINE (the newer-database line), OUT_ALL (the whole output)
run_doctor() {
  rm -f "$ROOT/fixture.json"
  [ "$1" = "none" ] || printf '%s\n' "$1" > "$ROOT/fixture.json"
  OUT_ALL="$(cd "$ROOT" && WEB_PORT=9 timeout 120 bash scripts/doctor.sh 2>&1 || true)"
  LINE="$(printf '%s\n' "$OUT_ALL" | grep -F 'running on a newer database' || true)"
}

echo "doctor: the newer-database line"

run_doctor '{"backend":"pg","runningOnNewerDatabase":true,"overrideEnabled":true,"databaseHighest":"0012","shippedHighest":"0009"}'
case "$LINE" in
  *"running on a newer database (database 0012, this build ships 0009); MARVEEN_PG_ALLOW_NEWER_DATABASE is on"*) pass "newer on PostgreSQL: a line naming both versions and the override" ;;
  *) fail "newer on PostgreSQL" "the line with 0012 and 0009" "${LINE:-<none>}" ;;
esac
case "$LINE" in
  *"⚠"*) pass "the newer line is a warning, not a failure" ;;
  *) fail "the newer line is a warning" "a ⚠ line" "${LINE:-<none>}" ;;
esac

run_doctor '{"backend":"pg","runningOnNewerDatabase":false,"overrideEnabled":true,"databaseHighest":"0009","shippedHighest":"0009"}'
[ -z "$LINE" ] && pass "current on PostgreSQL (override on): no line" || fail "current on PostgreSQL" "no line" "$LINE"

run_doctor '{"backend":"sqlite","runningOnNewerDatabase":false,"overrideEnabled":false,"databaseHighest":null,"shippedHighest":"0009"}'
[ -z "$LINE" ] && pass "SQLite backend: no line" || fail "SQLite backend" "no line" "$LINE"

run_doctor '{"backend":"sqlite","runningOnNewerDatabase":true,"databaseHighest":"0012","shippedHighest":"0009"}'
[ -z "$LINE" ] && pass "a SQLite answer claiming newer: no line (only a PostgreSQL backend can be newer)" || fail "SQLite claiming newer" "no line" "$LINE"

run_doctor '{"backend":"pg","runningOnNewerDatabase":"true","databaseHighest":"0012","shippedHighest":"0009"}'
[ -z "$LINE" ] && pass "a string \"true\" is not true: no line" || fail "string true" "no line" "$LINE"

run_doctor none
[ -z "$LINE" ] && pass "no answer from the dashboard: no line" || fail "no answer" "no line" "$LINE"

run_doctor 'not json'
[ -z "$LINE" ] && pass "an answer that is not JSON: no line" || fail "not json" "no line" "$LINE"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
