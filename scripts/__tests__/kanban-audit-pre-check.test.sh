#!/bin/bash
# Contract tests for seed-scheduled-tasks/kanban-audit/pre-check.sh.
# Run: bash scripts/__tests__/kanban-audit-pre-check.test.sh
#
# The pre-check reads the board and the last-audit time through the dashboard
# API, by way of scripts/agent-api.sh (the real wrapper, copied into the case
# dir). A stub `curl` on PATH answers the two endpoints in the shape of
# `curl -w '\n%{http_code}'`, which the wrapper reads, so the real script runs
# unmodified (after the same placeholder substitution the seeder does) without
# a dashboard. Fail-open is the contract: every failure must exit non-zero so
# the runner starts the LLM instead of silently skipping the audit.

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'find "$TMPDIR_BASE" -delete' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SEED="$INSTALL_DIR/seed-scheduled-tasks/kanban-audit/pre-check.sh"

NOW=$(date +%s)
OLD=$((NOW - 8 * 86400))
LAST_AUDIT=$((NOW - 4 * 3600))
BEFORE_AUDIT=$((NOW - 6 * 3600))
AFTER_AUDIT=$((NOW - 1 * 3600))

# Case dir layout: store/ (the shared token), scripts/agent-api.sh (the real wrapper),
# bin/curl (stub), pre-check.sh (rendered).
# The stub serves $CASE/kanban.json for /api/kanban and, for the agent-state
# URL, the status in $CASE/state.code with the body in $CASE/state.json.
make_case() { # name -> echoes the case dir
  local d="$TMPDIR_BASE/$1"
  mkdir -p "$d/store" "$d/bin" "$d/scripts"
  echo "test-token" > "$d/store/.dashboard-token"
  cp "$INSTALL_DIR/scripts/agent-api.sh" "$d/scripts/agent-api.sh"
  sed -e "s|{{INSTALL_DIR}}|$d|g" -e "s/{{WEB_PORT}}/3420/g" -e "s/{{MAIN_AGENT_ID}}/testbot/g" "$SEED" > "$d/pre-check.sh"
  cat > "$d/bin/curl" <<'STUB'
#!/bin/bash
CASE="$(cd "$(dirname "$0")/.." && pwd)"
for a in "$@"; do url="$a"; done
# Like the dashboard: no Bearer header on the request (the wrapper hands it over on stdin) = 401.
if ! grep -q 'Bearer ' 2>/dev/null; then printf '{"error":"unauthorized"}\n401'; exit 0; fi
case "$url" in
  */api/kanban)
    [ -f "$CASE/kanban.fail" ] && exit 22
    cat "$CASE/kanban.json"; printf '\n200' ;;
  */api/agent-state/testbot/kanban_audit_last_audit_at)
    [ -f "$CASE/state.fail" ] && exit 7
    printf '%s\n%s' "$(cat "$CASE/state.json" 2>/dev/null)" "$(cat "$CASE/state.code")" ;;
  *) exit 22 ;;
esac
STUB
  chmod +x "$d/bin/curl"
  echo "$d"
}

run_check() { # case dir -> stdout; exit code in $RC
  OUT=$(PATH="$1/bin:$PATH" /bin/bash "$1/pre-check.sh" 2>/dev/null); RC=$?
}

card() { # status updated_at
  echo "{\"id\":\"c$2\",\"title\":\"t\",\"status\":\"$1\",\"updated_at\":$2,\"archived_at\":null}"
}

echo "kanban-audit pre-check tests"
echo "============================"

echo ""
echo "(a) Nothing to do -> SKIP"
D=$(make_case nothing)
echo "[$(card done "$NOW"),$(card in_progress "$AFTER_AUDIT")]" > "$D/kanban.json"
echo 200 > "$D/state.code"; echo "{\"value\":$LAST_AUDIT}" > "$D/state.json"
run_check "$D"
assert_eq "exit 0" 0 "$RC"
assert_eq "prints SKIP" "SKIP" "$OUT"

echo ""
echo "(b) A done card older than 7 days"
D=$(make_case olddone)
echo "[$(card done "$OLD")]" > "$D/kanban.json"
echo 200 > "$D/state.code"; echo "{\"value\":$LAST_AUDIT}" > "$D/state.json"
run_check "$D"
assert_eq "exit 0" 0 "$RC"
case "$OUT" in *"1 archivalandó done"*) pass "reports the archivable card" ;; *) fail "reports the archivable card (got '$OUT')" ;; esac

echo ""
echo "(c) An in_progress card untouched since before the last audit"
D=$(make_case stuck)
echo "[$(card in_progress "$BEFORE_AUDIT")]" > "$D/kanban.json"
echo 200 > "$D/state.code"; echo "{\"value\":$LAST_AUDIT}" > "$D/state.json"
run_check "$D"
case "$OUT" in *"1 beakadt in_progress"*) pass "reports the stuck card" ;; *) fail "reports the stuck card (got '$OUT')" ;; esac

echo ""
echo "(d) First run: no stored audit time (404) never counts a card as stuck"
D=$(make_case firstrun)
echo "[$(card in_progress "$BEFORE_AUDIT")]" > "$D/kanban.json"
echo 404 > "$D/state.code"; echo '{"error":"not_found"}' > "$D/state.json"
run_check "$D"
assert_eq "exit 0" 0 "$RC"
assert_eq "prints SKIP" "SKIP" "$OUT"

echo ""
echo "(e) The stored time is the bare number a PUT of a number leaves behind"
D=$(make_case numeric)
echo "[$(card in_progress "$BEFORE_AUDIT")]" > "$D/kanban.json"
echo 200 > "$D/state.code"; echo "{\"agent_id\":\"testbot\",\"value\":\"$LAST_AUDIT\"}" > "$D/state.json"
run_check "$D"
case "$OUT" in *"1 beakadt in_progress"*) pass "a numeric string value is read too" ;; *) fail "numeric string value (got '$OUT')" ;; esac

echo ""
echo "(f) Failures are fail-open (non-zero exit, no SKIP)"
D=$(make_case kanbandown)
echo "[]" > "$D/kanban.json"; touch "$D/kanban.fail"
echo 200 > "$D/state.code"; echo "{\"value\":$LAST_AUDIT}" > "$D/state.json"
run_check "$D"
[ "$RC" -ne 0 ] && pass "board unreachable -> non-zero" || fail "board unreachable -> non-zero"
D=$(make_case statedown)
echo "[]" > "$D/kanban.json"
echo 500 > "$D/state.code"; echo '{"error":"internal_error"}' > "$D/state.json"
run_check "$D"
[ "$RC" -ne 0 ] && pass "state endpoint 500 -> non-zero" || fail "state endpoint 500 -> non-zero"
D=$(make_case statecurlfail)
echo "[]" > "$D/kanban.json"; touch "$D/state.fail"; echo 200 > "$D/state.code"
run_check "$D"
[ "$RC" -ne 0 ] && pass "state request fails -> non-zero" || fail "state request fails -> non-zero"
D=$(make_case notoken)
echo "[]" > "$D/kanban.json"; echo 200 > "$D/state.code"; echo '{"value":1}' > "$D/state.json"
find "$D/store" -name .dashboard-token -delete
run_check "$D"
[ "$RC" -ne 0 ] && pass "missing token -> non-zero" || fail "missing token -> non-zero"

echo ""
echo "(g) The script no longer touches the database file"
if grep -qE 'sqlite3|claudeclaw\.db' "$SEED"; then fail "no sqlite3 / claudeclaw.db in the pre-check"; else pass "no sqlite3 / claudeclaw.db in the pre-check"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
