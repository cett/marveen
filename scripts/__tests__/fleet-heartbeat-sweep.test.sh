#!/bin/bash
# Contract tests for the fan-out quota guard in scripts/fleet-heartbeat-sweep.sh.
# Run: bash scripts/__tests__/fleet-heartbeat-sweep.test.sh
#
# The guard reads store/.claude-rate-limits.json (written by the statusLine, read by the dashboard
# quota strip): written_at in unix SECONDS, rate_limits.five_hour / seven_day with used_percentage and
# resets_at. It may only act on a FRESH snapshot and only on windows that have not rolled over yet
# (same rules as src/web/quota.ts): a high-but-stale or high-but-expired number must not skip the
# sweep, a high-and-fresh live one must. With no usable reading it fails open and logs why.
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
  # A date stub: with FIXED_NOW set, `date +%s` answers it, so a boundary (resets_at == now) is exact and
  # not a race against the wall clock. Every other date call (the log timestamps) passes through.
  printf '#!/bin/sh\nif [ -n "${FIXED_NOW:-}" ] && [ "$*" = "+%%s" ]; then echo "$FIXED_NOW"; else exec /bin/date "$@"; fi\n' > "$r/bin/date"; chmod +x "$r/bin/date"
  echo "$r"
}

now_s() { date +%s; }

# write_limits ROOT WRITTEN_AT FIVE_PCT FIVE_RESETS SEVEN_PCT SEVEN_RESETS -> the statusLine's file shape
write_limits() {
  printf '{"written_at": %s, "session_id": "s", "rate_limits": {"five_hour": {"used_percentage": %s, "resets_at": %s}, "seven_day": {"used_percentage": %s, "resets_at": %s}}}\n' \
    "$2" "$3" "$4" "$5" "$6" > "$1/store/.claude-rate-limits.json"
}

# run_sweep ROOT -> runs with stagger 0 and prints the sweep log
run_sweep() {
  PATH="$1/bin:$PATH" MAIN_AGENT_ID=main bash "$1/scripts/fleet-heartbeat-sweep.sh" 0 >/dev/null 2>&1
  cat "$1/store/fleet-heartbeat-sweep.log" 2>/dev/null
}

skipped() { case "$1" in *"fan-out guard) -- skipping"*) return 0;; *) return 1;; esac; }
started() { case "$1" in *"sweep start"*) return 0;; *) return 1;; esac; }
# expect_open CASE LOG REASON: the sweep ran, was not skipped, and the log says why the guard failed open
expect_open() {
  if skipped "$2"; then fail "$1: skipped the sweep: $2"; else pass "$1: not skipped"; fi
  if started "$2"; then pass "$1: sweep started"; else fail "$1: sweep did not start: $2"; fi
  case "$2" in *"$3"*"fails open"*) pass "$1: logged as '$3', fail-open";; *) fail "$1: expected '$3' ... 'fails open' in log: $2";; esac
}

echo "fleet-heartbeat-sweep fan-out guard tests"
echo "========================================="

NOW="$(now_s)"
FUTURE=$(( NOW + 3600 ))
PAST=$(( NOW - 60 ))

echo ""
echo "(a) fresh snapshot above the threshold -> sweep skipped"
R="$(make_root a)"; write_limits "$R" "$NOW" 90 "$FUTURE" 10 "$FUTURE"
OUT="$(run_sweep "$R")"
if skipped "$OUT"; then pass "fresh 90% >= 75%: skipped"; else fail "fresh 90% did not skip: $OUT"; fi
if started "$OUT"; then fail "fresh 90%: sweep started anyway"; else pass "fresh 90%: no sweep start logged"; fi
case "$OUT" in *"quota 90%"*) pass "log names the percentage";; *) fail "log does not name 90%: $OUT";; esac

echo ""
echo "(a2) the larger of the two windows decides (weekly over the threshold, five-hour low)"
R="$(make_root a2)"; write_limits "$R" "$NOW" 10 "$FUTURE" 80 "$FUTURE"
OUT="$(run_sweep "$R")"
if skipped "$OUT"; then pass "weekly 80% skips although five-hour is 10%"; else fail "weekly 80% did not skip: $OUT"; fi

echo ""
echo "(a3) the threshold is inclusive: exactly 75 skips, 74.9 does not"
R="$(make_root a3-75)"; write_limits "$R" "$NOW" 75 "$FUTURE" 0 "$FUTURE"
if skipped "$(run_sweep "$R")"; then pass "75% skips"; else fail "75% did not skip"; fi
R="$(make_root a3-74)"; write_limits "$R" "$NOW" 74.9 "$FUTURE" 0 "$FUTURE"
if skipped "$(run_sweep "$R")"; then fail "74.9% skipped"; else pass "74.9% does not skip"; fi

echo ""
echo "(a4) QUOTA_THRESHOLD override is honoured"
R="$(make_root a4)"; write_limits "$R" "$NOW" 60 "$FUTURE" 0 "$FUTURE"
if skipped "$(QUOTA_THRESHOLD=50 run_sweep "$R")"; then pass "60% skips under QUOTA_THRESHOLD=50"; else fail "60% did not skip under threshold 50"; fi

echo ""
echo "(b) STALE snapshot above the threshold -> guard fails open, sweep runs"
R="$(make_root b)"; write_limits "$R" "$(( NOW - 3 * 3600 ))" 83 "$FUTURE" 54 "$FUTURE"
expect_open "stale 83%" "$(run_sweep "$R")" "snapshot stale"

echo ""
echo "(b2) written_at in MILLISECONDS (the old claude-usage.json unit) is not read as seconds"
R="$(make_root b2)"; write_limits "$R" "$(( NOW * 1000 ))" 99 "$FUTURE" 99 "$FUTURE"
OUT="$(run_sweep "$R")"
# A millisecond value is ~1000x in the future: age is negative, so it reads as fresh. Pin the behaviour
# (it is the writer's contract, not the guard's, to write seconds) so a unit change is a visible decision.
if skipped "$OUT"; then pass "a future written_at counts as fresh (age clamps to 0 like readQuotaSnapshot)"; else fail "future written_at was not treated as fresh: $OUT"; fi

echo ""
echo "(c) snapshot without written_at -> fail open"
R="$(make_root c)"
printf '{"rate_limits": {"five_hour": {"used_percentage": 99, "resets_at": %s}}}\n' "$FUTURE" > "$R/store/.claude-rate-limits.json"
expect_open "no written_at" "$(run_sweep "$R")" "no written_at"
R="$(make_root c-str)"
printf '{"written_at": "%s", "rate_limits": {"five_hour": {"used_percentage": 99, "resets_at": %s}}}\n' "$NOW" "$FUTURE" > "$R/store/.claude-rate-limits.json"
expect_open "string written_at" "$(run_sweep "$R")" "no written_at"

echo ""
echo "(c2) corrupt or non-object snapshot JSON -> guard fails open, sweep runs"
n=0
for BAD in '{not valid json' '' '[]' 'null' '"text"' '42'; do
  n=$((n+1)); R="$(make_root "c2-$n")"
  printf '%s' "$BAD" > "$R/store/.claude-rate-limits.json"
  expect_open "corrupt snapshot '$BAD'" "$(run_sweep "$R")" "snapshot unreadable"
done

echo ""
echo "(c3) no snapshot file at all -> fail open"
R="$(make_root c3)"
expect_open "missing file" "$(run_sweep "$R")" "snapshot missing"

echo ""
echo "(c4) no rate_limits block / no usable window -> fail open"
n=0
for BODY in '"rate_limits": {}' '"rate_limits": null' '"rate_limits": "x"' '"other": 1' \
            '"rate_limits": {"five_hour": {"used_percentage": "99", "resets_at": 1}}' \
            '"rate_limits": {"five_hour": {"resets_at": 4000000000}}' '"rate_limits": {"five_hour": 99}'; do
  n=$((n+1)); R="$(make_root "c4-$n")"
  printf '{"written_at": %s, %s}\n' "$NOW" "$BODY" > "$R/store/.claude-rate-limits.json"
  expect_open "no usable window ($BODY)" "$(run_sweep "$R")" "no live rate_limits window"
done

echo ""
echo "(c5) an EXPIRED window does not count (its reset time has passed)"
R="$(make_root c5)"; write_limits "$R" "$NOW" 95 "$PAST" 10 "$FUTURE"
OUT="$(run_sweep "$R")"
if skipped "$OUT"; then fail "expired 95% still skipped the sweep: $OUT"; else pass "expired five-hour 95% is ignored"; fi
if started "$OUT"; then pass "sweep started on the live 10% window"; else fail "sweep did not start: $OUT"; fi
R="$(make_root c5b)"; write_limits "$R" "$NOW" 95 "$PAST" 95 "$PAST"
expect_open "both windows expired" "$(run_sweep "$R")" "no live rate_limits window"
R="$(make_root c5c)"; write_limits "$R" "$NOW" 10 "$FUTURE" 95 "$NOW"
OUT="$(FIXED_NOW="$NOW" run_sweep "$R")"
if skipped "$OUT"; then fail "a window resetting exactly now still counted: $OUT"; else pass "resets_at == now is expired (<= now)"; fi
R="$(make_root c5e)"; write_limits "$R" "$NOW" 10 "$FUTURE" 95 "$(( NOW + 1 ))"
if skipped "$(FIXED_NOW="$NOW" run_sweep "$R")"; then pass "resets_at == now + 1 still counts"; else fail "a window resetting in one second was ignored"; fi
R="$(make_root c5d)"
printf '{"written_at": %s, "rate_limits": {"five_hour": {"used_percentage": 90}}}\n' "$NOW" > "$R/store/.claude-rate-limits.json"
if skipped "$(run_sweep "$R")"; then pass "a window without resets_at still counts (like readWindow)"; else fail "window without resets_at was ignored"; fi

echo ""
echo "(d) fresh snapshot below the threshold -> sweep runs"
R="$(make_root d)"; write_limits "$R" "$NOW" 20 "$FUTURE" 30 "$FUTURE"
OUT="$(run_sweep "$R")"
if skipped "$OUT"; then fail "fresh 30%: skipped: $OUT"; else pass "fresh 30%: not skipped"; fi
if started "$OUT"; then pass "fresh 30%: sweep started"; else fail "fresh 30%: sweep did not start: $OUT"; fi

echo ""
echo "(e) QUOTA_STALE_MINUTES override is honoured"
R="$(make_root e)"; write_limits "$R" "$(( NOW - 10 * 60 ))" 90 "$FUTURE" 10 "$FUTURE"
OUT="$(QUOTA_STALE_MINUTES=5 run_sweep "$R")"
if skipped "$OUT"; then fail "10m old with 5m limit: still skipped"; else pass "10m old snapshot is stale under QUOTA_STALE_MINUTES=5"; fi
if skipped "$(run_sweep "$R")"; then pass "the same 10m old snapshot is fresh under the 20m default"; else fail "10m old snapshot was treated as stale under the default"; fi

echo ""
echo "(e2) the retired claude-usage.json is not read any more"
R="$(make_root e2)"
echo "{\"sessionPct\":99,\"weeklyPct\":99,\"fetchedAt\":$(( NOW * 1000 ))}" > "$R/store/claude-usage.json"
OUT="$(run_sweep "$R")"
if skipped "$OUT"; then fail "the old claude-usage.json still skips the sweep: $OUT"; else pass "claude-usage.json is ignored"; fi
case "$OUT" in *"snapshot missing"*) pass "no rate-limit file: logged as missing";; *) fail "missing not logged: $OUT";; esac
if grep -q "claude-usage" "$SWEEP"; then fail "the script still mentions claude-usage"; else pass "no claude-usage reference left in the script"; fi

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
