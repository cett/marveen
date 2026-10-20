#!/bin/bash
# Tests for the wake-from-sleep gate of scripts/channel-watchdog.sh.
# Run: bash scripts/__tests__/channel-watchdog-wake.test.sh
#
# A sleeping Mac runs no timer. On wake the overdue ticks of the keepalive probe (3 min) and of this watchdog
# (5 min) fire in no fixed order, and when the watchdog came first the keepalive file was as old as the sleep: a
# healthy session that merely slept was respawned (measured twice, 2026-10-17 and 2026-10-18, 64 s after a
# DarkWake). The gate skips the tick for WAKE_GRACE_SECONDS (600) after a wake and measures the keepalive age
# from the wake at the earliest. The wake time comes from portable_wake_epoch, i.e. `sysctl -n kern.waketime`;
# here PORTABLE_SYSCTL_BIN points at a stub that answers with a chosen wake time, so any host can run every case.
#
# Fixtures only: stub tmux and claude, a throw-away install tree, the host's own stat.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_SRC="${CHANNEL_WATCHDOG_PATH:-$SRC_DIR/channel-watchdog.sh}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# stub tmux (session exists, respawn is logged) and claude
make_bin() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/tmux" <<'EOF'
#!/bin/sh
echo "$*" >> "$TMUX_LOG"
exit 0
EOF
  printf '#!/bin/sh\nexit 0\n' > "$bin/claude"
  chmod +x "$bin/tmux" "$bin/claude"
}

make_install() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/store"
  cp "$SCRIPT_SRC" "$root/scripts/channel-watchdog.sh"
  cp "$SRC_DIR/lib/portable.sh" "$root/scripts/lib/portable.sh"
  chmod +x "$root/scripts/channel-watchdog.sh"
  printf 'MAIN_AGENT_ID=testbot\n' > "$root/.env"
}

# sysctl stub. $2: ago:<seconds> (wake that many seconds ago) | future:<seconds> | garbage | fail | zero
make_sysctl() {
  local file="$1" mode="$2" now
  now="$(date +%s)"
  case "$mode" in
    ago:*)    printf '#!/bin/sh\necho "{ sec = %s, usec = 413529 } Mon Oct 19 08:18:45 2026"\n' "$((now - ${mode#ago:}))" > "$file" ;;
    future:*) printf '#!/bin/sh\necho "{ sec = %s, usec = 413529 } Mon Oct 19 08:18:45 2026"\n' "$((now + ${mode#future:}))" > "$file" ;;
    garbage)  printf '#!/bin/sh\necho "not a waketime"\n' > "$file" ;;
    fail)     printf '#!/bin/sh\nexit 1\n' > "$file" ;;
  esac
  chmod +x "$file"
}

# run_case <name> <keepalive: none|fresh|old> <wake mode | none>
# leaves $OUT, $RESPAWNS, $RC
run_case() {
  local name="$1" ka="$2" wake="$3"
  local root="$TMP/$name"
  make_install "$root"
  make_bin "$root/bin"
  case "$ka" in
    fresh) touch "$root/store/.channel-keepalive" ;;
    old) touch -t 202001010000 "$root/store/.channel-keepalive" ;;
  esac
  # the keepalive probe is running (fresh stamp): the keepalive age counts as evidence, as these cases assume
  touch "$root/store/.channel-keepalive-probe"
  : > "$root/tmux.log"
  if [ "${AUTHDEAD:-}" = "1" ]; then
    # the auth-dead arm: a node that always says "dead token" (exit 1), the dist marker the arm looks for, and two
    # dead ticks already counted, so one more dead tick would respawn
    printf '#!/bin/sh\ncat >/dev/null\nexit 1\n' > "$root/bin/node"; chmod +x "$root/bin/node"
    mkdir -p "$root/dist/web"; : > "$root/dist/web/reauth-detect.js"
    echo 2 > "$root/store/.channel-watchdog-auth-dead-count"
  fi
  local sysctl_env="/nonexistent/sysctl"
  if [ "$wake" != "none" ]; then make_sysctl "$root/sysctl" "$wake"; sysctl_env="$root/sysctl"; fi
  OUT="$(cd "$root" && env -i HOME="$root" PATH="$root/bin:/usr/bin:/bin" TMUX_LOG="$root/tmux.log" PORTABLE_SYSCTL_BIN="$sysctl_env" \
    /bin/bash "$root/scripts/channel-watchdog.sh" 2>&1)"
  RC=$?
  RESPAWNS="$(grep -c '^respawn-pane' "$root/tmux.log")"
}

has() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

echo "just woken: the stale keepalive is the sleep's age, not a wedge"
run_case woke-60s-ago old ago:60
assert_eq "no respawn" "0" "$RESPAWNS"
assert_eq "exit 0" "0" "$RC"
if has "recently woken"; then pass "the log says why the tick was skipped"; else fail "the log says why the tick was skipped ($OUT)"; fi

run_case woke-just-inside old ago:590
assert_eq "590 s after the wake (inside the 600 s grace): no respawn" "0" "$RESPAWNS"
if has "recently woken"; then pass "590 s: still skipped as recently woken"; else fail "590 s: still skipped as recently woken ($OUT)"; fi

echo "after the grace the age counts from the wake, not from the old file"
run_case woke-just-outside old ago:610
assert_eq "610 s after the wake, keepalive older than the wake: age 610 s < 15 min, no respawn" "0" "$RESPAWNS"
if has "recently woken"; then fail "610 s: no longer 'recently woken' ($OUT)"; else pass "610 s: no longer 'recently woken'"; fi

run_case woke-20min old ago:1200
assert_eq "wake 20 min ago and still no fresh keepalive: respawn (a really wedged session is still recovered)" "1" "$RESPAWNS"
if has "keepalive stale 12"; then pass "the reported age is counted from the wake (about 1200 s), not from 2020"; else fail "the reported age is counted from the wake ($OUT)"; fi

echo "the auth-dead arm waits too: the network is not back yet right after a wake"
AUTHDEAD=1 run_case auth-just-woken fresh ago:60
assert_eq "dead-token probe right after a wake: no respawn" "0" "$RESPAWNS"
assert_eq "the dead-token count is left alone (the tick did not run)" "2" "$(cat "$TMP/auth-just-woken/store/.channel-watchdog-auth-dead-count" 2>/dev/null)"
AUTHDEAD=1 run_case auth-woke-long-ago fresh ago:7200
assert_eq "control: the same dead-token probe long after the wake respawns" "1" "$RESPAWNS"
AUTHDEAD=1 run_case auth-no-wake-info fresh none
assert_eq "control: and without wake information" "1" "$RESPAWNS"

echo "no wake information: the behaviour without the gate"
run_case no-sysctl old none
assert_eq "sysctl missing + old keepalive: respawn as before" "1" "$RESPAWNS"
run_case sysctl-fails old fail
assert_eq "sysctl fails + old keepalive: respawn as before" "1" "$RESPAWNS"
run_case sysctl-garbage old garbage
assert_eq "sysctl answers nonsense + old keepalive: respawn as before" "1" "$RESPAWNS"
run_case wake-in-future old future:3600
assert_eq "a wake time in the future (clock set back) is ignored: respawn as before" "1" "$RESPAWNS"
if has "recently woken"; then fail "a future wake time is not a recent wake ($OUT)"; else pass "a future wake time is not a recent wake"; fi

echo "healthy cases stay quiet"
run_case fresh-no-wake fresh none
assert_eq "fresh keepalive, no wake info: no respawn" "0" "$RESPAWNS"
run_case fresh-long-ago fresh ago:7200
assert_eq "fresh keepalive, woke 2 h ago: no respawn" "0" "$RESPAWNS"
run_case old-woke-long-ago old ago:7200
assert_eq "old keepalive, woke 2 h ago: respawn (the mtime is older than 15 min after the wake too)" "1" "$RESPAWNS"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
