#!/bin/bash
# Contract tests for the fan-out quota guard in scripts/fleet-heartbeat-sweep.sh.
# Run: bash scripts/__tests__/fleet-heartbeat-sweep.test.sh
#
# The guard may only act on a FRESH usage snapshot (same rule as src/quota-gate.ts):
# a high-but-stale number must not skip the sweep, a high-and-fresh one must.
# The script runs against an isolated ROOT with a stubbed curl (no dashboard, no agents).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SWEEP="$INSTALL_DIR/scripts/fleet-heartbeat-sweep.sh"

# Isolated ROOT: script copy + store/ + a curl stub that reports NO running agents,
# so a sweep that is not skipped ends at "no running sub-agents" without sending anything.
make_root() { # $1 = case name; prints the ROOT
  local r="$TMPDIR_BASE/$1"
  mkdir -p "$r/scripts" "$r/store" "$r/bin"
  cp "$SWEEP" "$r/scripts/fleet-heartbeat-sweep.sh"
  echo "test-token" > "$r/store/.dashboard-token"
  printf '#!/bin/sh\necho "[]"\n' > "$r/bin/curl"; chmod +x "$r/bin/curl"
  echo "$r"
}

now_ms() { echo "$(( $(date +%s) * 1000 ))"; }

# run_sweep ROOT -> runs with stagger 0 and prints the sweep log
run_sweep() {
  PATH="$1/bin:$PATH" MAIN_AGENT_ID=main bash "$1/scripts/fleet-heartbeat-sweep.sh" 0 >/dev/null 2>&1
  cat "$1/store/fleet-heartbeat-sweep.log" 2>/dev/null
}

echo "fleet-heartbeat-sweep fan-out guard tests"
echo "========================================="

echo ""
echo "(a) fresh snapshot above the threshold -> sweep skipped"
R="$(make_root a)"
echo "{\"sessionPct\":90,\"weeklyPct\":10,\"fetchedAt\":$(now_ms)}" > "$R/store/claude-usage.json"
OUT="$(run_sweep "$R")"
case "$OUT" in *"fan-out guard) -- skipping"*) pass "fresh 90% >= 75%: skipped";; *) fail "fresh 90% did not skip: $OUT";; esac
case "$OUT" in *"sweep start"*) fail "fresh 90%: sweep started anyway";; *) pass "fresh 90%: no sweep start logged";; esac

echo ""
echo "(b) STALE snapshot above the threshold -> guard fails open, sweep runs"
R="$(make_root b)"
echo "{\"sessionPct\":83,\"weeklyPct\":54,\"fetchedAt\":$(( $(now_ms) - 3 * 3600 * 1000 ))}" > "$R/store/claude-usage.json"
OUT="$(run_sweep "$R")"
case "$OUT" in *"snapshot stale"*"fails open"*) pass "stale 83%: logged as stale, fail-open";; *) fail "stale 83% not reported as stale: $OUT";; esac
case "$OUT" in *"skipping"*) fail "stale 83% still skipped the sweep: $OUT";; *) pass "stale 83%: not skipped";; esac
case "$OUT" in *"sweep start"*) pass "stale 83%: sweep started";; *) fail "stale 83%: sweep did not start: $OUT";; esac

echo ""
echo "(c) snapshot without fetchedAt -> fail open"
R="$(make_root c)"
echo '{"sessionPct":99,"weeklyPct":99}' > "$R/store/claude-usage.json"
OUT="$(run_sweep "$R")"
case "$OUT" in *"no fetchedAt"*) pass "no fetchedAt: logged";; *) fail "no fetchedAt not logged: $OUT";; esac
case "$OUT" in *"skipping"*) fail "no fetchedAt: skipped";; *) pass "no fetchedAt: not skipped";; esac

echo ""
echo "(c2) corrupt snapshot JSON -> guard fails open, sweep runs"
for BAD in '{not valid json' '' '[]' 'null'; do
  R="$(make_root "c2-$(printf '%s' "$BAD" | wc -c | tr -d ' ')-${#BAD}")"
  printf '%s' "$BAD" > "$R/store/claude-usage.json"
  OUT="$(run_sweep "$R")"
  case "$OUT" in *"skipping"*) fail "corrupt snapshot '$BAD': skipped the sweep: $OUT";; *) pass "corrupt snapshot '$BAD': not skipped";; esac
  case "$OUT" in *"sweep start"*) pass "corrupt snapshot '$BAD': sweep started";; *) fail "corrupt snapshot '$BAD': sweep did not start: $OUT";; esac
  case "$OUT" in *"no fetchedAt"*"fails open"*) pass "corrupt snapshot '$BAD': logged as fail-open";; *) fail "corrupt snapshot '$BAD': fail-open not logged: $OUT";; esac
done

echo ""
echo "(d) fresh snapshot below the threshold -> sweep runs"
R="$(make_root d)"
echo "{\"sessionPct\":20,\"weeklyPct\":30,\"fetchedAt\":$(now_ms)}" > "$R/store/claude-usage.json"
OUT="$(run_sweep "$R")"
case "$OUT" in *"skipping"*) fail "fresh 30%: skipped: $OUT";; *) pass "fresh 30%: not skipped";; esac
case "$OUT" in *"sweep start"*) pass "fresh 30%: sweep started";; *) fail "fresh 30%: sweep did not start: $OUT";; esac

echo ""
echo "(e) QUOTA_STALE_MINUTES override is honoured"
R="$(make_root e)"
echo "{\"sessionPct\":90,\"weeklyPct\":10,\"fetchedAt\":$(( $(now_ms) - 10 * 60 * 1000 ))}" > "$R/store/claude-usage.json"
OUT="$(QUOTA_STALE_MINUTES=5 run_sweep "$R")"
case "$OUT" in *"skipping"*) fail "10m old with 5m limit: still skipped";; *) pass "10m old snapshot is stale under QUOTA_STALE_MINUTES=5";; esac

echo ""
echo "(f) tenant-only agents are left out of the sweep"
# make_agents_root CASE AGENTS_JSON: a curl stub that serves the agent list and records every POSTed message.
make_agents_root() {
  local r; r="$(make_root "$1")"
  printf '%s' "$2" > "$r/agents.json"
  cat > "$r/bin/curl" <<STUB
#!/bin/sh
post=0; payload=""
while [ \$# -gt 0 ]; do
  case "\$1" in -X) [ "\$2" = POST ] && post=1;; -d) payload="\$2";; esac
  shift
done
if [ "\$post" = 1 ]; then printf '%s\n' "\$payload" >> "$r/posts.log"; printf 200; else cat "$r/agents.json"; fi
STUB
  chmod +x "$r/bin/curl"
  echo "$r"
}
targets() { [ -f "$1/posts.log" ] && jq -r '.to' "$1/posts.log" | sort | tr '\n' ' ' || true; }

AGENTS_JSON='[
 {"name":"plain","running":true,"tenantIds":[],"primaryTenantId":null},
 {"name":"shared","running":true,"tenantIds":["default","acme"],"primaryTenantId":null},
 {"name":"explicit-default","running":true,"tenantIds":["default"],"primaryTenantId":null},
 {"name":"only-acme","running":true,"tenantIds":["acme"],"primaryTenantId":null},
 {"name":"main-of-acme","running":true,"tenantIds":["acme"],"primaryTenantId":"acme"},
 {"name":"main-only","running":true,"tenantIds":[],"primaryTenantId":"acme"},
 {"name":"legacy","running":true},
 {"name":"stopped","running":false,"tenantIds":[],"primaryTenantId":null},
 {"name":"main","running":true,"tenantIds":[],"primaryTenantId":null}
]'
R="$(make_agents_root f "$AGENTS_JSON")"
OUT="$(run_sweep "$R")"
GOT="$(targets "$R")"
[ "$GOT" = "explicit-default legacy plain shared " ] && pass "only default-reachable running agents get the directive ($GOT)" || fail "wrong recipients: '$GOT'"
for A in only-acme main-of-acme main-only; do
  case "$GOT" in *"$A "*) fail "$A (tenant-only) received the directive";; *) pass "$A (tenant-only) did not receive it";; esac
  case "$OUT" in *"$A : skipped (serves only non-default tenants)"*) pass "$A: skip logged";; *) fail "$A: skip not logged: $OUT";; esac
done
case "$OUT" in *"(4 agents triggered)"*) pass "trigger count matches the recipients";; *) fail "unexpected trigger count: $OUT";; esac

echo ""
echo "(g) only tenant-only agents running -> nothing is sent, the sweep ends cleanly"
R="$(make_agents_root g '[{"name":"only-acme","running":true,"tenantIds":["acme"],"primaryTenantId":null}]')"
OUT="$(run_sweep "$R")"
[ -z "$(targets "$R")" ] && pass "no message sent" || fail "a message was sent"
case "$OUT" in *"no running sub-agents found"*) pass "ends with the nothing-to-do line";; *) fail "no nothing-to-do line: $OUT";; esac

echo ""
echo "======================================="
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
