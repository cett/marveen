#!/bin/bash
# Clock-jump protection for file ages: scripts/lib/portable.sh (portable_age, portable_age_since),
# scripts/channel-watchdog.sh and scripts/doctor.sh.
# Run: bash scripts/__tests__/clock-jump.test.sh
#
# `now - mtime` is negative when the clock was set back or a stamp was written by a clock that ran ahead, and a
# comparison with a limit then reads the file as fresh until the clock catches up: a keepalive stamp in the future
# never looked stale, a respawn stamp in the future held the respawn grace for good. The age helper reports a
# future mtime as "unknown" (status 2), and each caller takes its own safe side. Fixtures only: stub tmux/claude,
# a throw-away install tree, mtimes set with python (portable between BSD and GNU).

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PY="$(command -v python3)"
[ -z "$PY" ] && { echo "FATAL: python3 is needed to set mtimes"; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# set_mtime FILE OFFSET_SECONDS: mtime = now + offset (negative = past)
set_mtime() { "$PY" -c 'import os,sys,time;t=time.time()+float(sys.argv[2]);os.utime(sys.argv[1],(t,t))' "$1" "$2"; }
mtime_of() { "$PY" -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' "$1"; }

# --- the helper -----------------------------------------------------------------------------------------------
. "$SRC_DIR/lib/portable.sh"

echo "portable_age_since"
assert_eq "an old mtime: the age" "100" "$(portable_age_since 900 1000)"
assert_eq "the same second: 0" "0" "$(portable_age_since 1000 1000)"
assert_eq "a few seconds ahead (clock jitter): 0, not negative" "0" "$(portable_age_since 1030 1000)"
assert_eq "exactly the tolerance ahead: 0" "0" "$(portable_age_since 1060 1000)"
portable_age_since 1061 1000 >/dev/null; assert_eq "one second beyond the tolerance: status 2 (unknown)" "2" "$?"
out="$(portable_age_since 1061 1000)"; assert_eq "unknown prints nothing" "" "$out"
portable_age_since 99999999999 1000 >/dev/null; assert_eq "far future: status 2" "2" "$?"
portable_age_since abc 1000 >/dev/null; assert_eq "not a number: status 1" "1" "$?"
portable_age_since "" 1000 >/dev/null; assert_eq "empty: status 1" "1" "$?"
assert_eq "the tolerance is configurable" "0" "$(PORTABLE_CLOCK_SKEW_SECONDS=500 portable_age_since 1400 1000)"
PORTABLE_CLOCK_SKEW_SECONDS=5 portable_age_since 1010 1000 >/dev/null; assert_eq "a tighter tolerance: status 2" "2" "$?"
assert_eq "a garbage tolerance falls back to 60" "0" "$(PORTABLE_CLOCK_SKEW_SECONDS=x portable_age_since 1030 1000)"

echo "portable_age FILE"
F="$TMP/f"; : > "$F"
set_mtime "$F" -300
age="$(portable_age "$F")"; case "$age" in 29[89]|30[0-3]) pass "a file 300 s old: ~300 ($age)" ;; *) fail "a file 300 s old: ~300 ($age)" ;; esac
set_mtime "$F" 86400
portable_age "$F" >/dev/null; assert_eq "a file a day in the future: status 2" "2" "$?"
portable_age "$TMP/missing" >/dev/null; assert_eq "a missing file: status 1" "1" "$?"

# --- the watchdog ---------------------------------------------------------------------------------------------
make_install() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/store" "$root/bin"
  cp "$SRC_DIR/channel-watchdog.sh" "$root/scripts/channel-watchdog.sh"
  cp "$SRC_DIR/lib/portable.sh" "$root/scripts/lib/portable.sh"
  chmod +x "$root/scripts/channel-watchdog.sh"
  printf 'MAIN_AGENT_ID=testbot\n' > "$root/.env"
  cat > "$root/bin/tmux" <<'EOF'
#!/bin/sh
echo "$*" >> "$TMUX_LOG"
exit 0
EOF
  printf '#!/bin/sh\nexit 0\n' > "$root/bin/claude"
  chmod +x "$root/bin/tmux" "$root/bin/claude"
}

# run_case NAME KEEPALIVE_OFFSET PROBE_OFFSET RESPAWN_OFFSET   (an offset in seconds from now; "none" = no file)
# leaves $OUT, $RC, $RESPAWNS and $ROOT
run_case() {
  local name="$1" ka="$2" probe="$3" stamp="$4"
  ROOT="$TMP/$name"
  make_install "$ROOT"
  [ "$ka" = none ] || { : > "$ROOT/store/.channel-keepalive"; set_mtime "$ROOT/store/.channel-keepalive" "$ka"; }
  [ "$probe" = none ] || { : > "$ROOT/store/.channel-keepalive-probe"; set_mtime "$ROOT/store/.channel-keepalive-probe" "$probe"; }
  [ "$stamp" = none ] || { : > "$ROOT/store/.channel-last-respawn"; set_mtime "$ROOT/store/.channel-last-respawn" "$stamp"; }
  : > "$ROOT/tmux.log"
  OUT="$(cd "$ROOT" && env -i HOME="$ROOT" PATH="$ROOT/bin:/usr/bin:/bin" TMUX_LOG="$ROOT/tmux.log" \
    /bin/bash "$ROOT/scripts/channel-watchdog.sh" 2>&1)"
  RC=$?
  RESPAWNS="$(grep -c '^respawn-pane' "$ROOT/tmux.log")"
}

echo "watchdog: keepalive file"
run_case ka-old -86400 -10 none
assert_eq "control: an old keepalive with a fresh probe respawns" "1" "$RESPAWNS"

run_case ka-future 172800 -10 none
assert_eq "a keepalive a day or two in the future is not stale: no respawn" "0" "$RESPAWNS"
assert_eq "...and the watchdog exits 0" "0" "$RC"
case "$OUT" in *"is in the future"*"STALE=false"*) pass "...and the log names the clock skew" ;; *) fail "...and the log names the clock skew ($OUT)" ;; esac

run_case ka-jitter 20 -10 none
assert_eq "a keepalive 20 s ahead (jitter) counts as fresh: no respawn" "0" "$RESPAWNS"
case "$OUT" in *"in the future"*) fail "jitter is not logged as a clock skew" ;; *) pass "jitter is not logged as a clock skew" ;; esac

echo "watchdog: probe stamp"
run_case probe-future -86400 172800 none
assert_eq "an old keepalive with a probe stamp in the future: the probe is not proven running, no respawn" "0" "$RESPAWNS"
case "$OUT" in *"probe stamp mtime is in the future"*) pass "the log says the probe stamp is unusable" ;; *) fail "the log says the probe stamp is unusable ($OUT)" ;; esac

echo "watchdog: respawn stamp (the grace)"
run_case stamp-old -86400 -10 -86400
assert_eq "control: an old respawn stamp lets the respawn through" "1" "$RESPAWNS"

run_case stamp-recent -86400 -10 -30
assert_eq "control: a recent respawn stamp holds the grace" "0" "$RESPAWNS"
case "$OUT" in *"within respawn grace"*) pass "control: the log says the grace holds" ;; *) fail "control: the log says the grace holds ($OUT)" ;; esac

run_case stamp-future -86400 -10 172800
assert_eq "a respawn stamp in the future defers this tick" "0" "$RESPAWNS"
case "$OUT" in *"in the future"*"re-based to now"*) pass "the log says the stamp was re-based" ;; *) fail "the log says the stamp was re-based ($OUT)" ;; esac
now="$(date +%s)"; m="$(mtime_of "$ROOT/store/.channel-last-respawn")"
if [ "$m" -le $(( now + 5 )) ] && [ "$m" -ge $(( now - 120 )) ]; then pass "the stamp's mtime is now (re-based), not a day or two ahead"; else fail "the stamp's mtime is now (re-based) (mtime=$m now=$now)"; fi

# the next tick after the re-base: the grace runs from the re-base and then ends, so the stuck state does not last
set_mtime "$ROOT/store/.channel-last-respawn" -86400
OUT2="$(cd "$ROOT" && env -i HOME="$ROOT" PATH="$ROOT/bin:/usr/bin:/bin" TMUX_LOG="$ROOT/tmux.log" /bin/bash "$ROOT/scripts/channel-watchdog.sh" 2>&1)"
assert_eq "once the re-based stamp has aged past the grace the respawn goes out" "1" "$(grep -c '^respawn-pane' "$ROOT/tmux.log")"

# --- the doctor -----------------------------------------------------------------------------------------------
echo "doctor: keepalive checks"
run_doctor() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/store"
  cp "$SRC_DIR/doctor.sh" "$root/scripts/doctor.sh"
  cp "$SRC_DIR/lib/portable.sh" "$root/scripts/lib/portable.sh"
  DOC_OUT="$(cd "$root" && env -i HOME="$root" PATH="/usr/bin:/bin:/usr/sbin" /bin/bash "$root/scripts/doctor.sh" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
}
D="$TMP/doc-future"; mkdir -p "$D/store"
: > "$D/store/.channel-keepalive"; set_mtime "$D/store/.channel-keepalive" 172800
: > "$D/store/.channel-keepalive-probe"; set_mtime "$D/store/.channel-keepalive-probe" 172800
run_doctor "$D"
case "$DOC_OUT" in *"channel-keepalive: the file's mtime is in the future"*) pass "a future keepalive mtime is reported, not shown as 'refreshed -172800s ago'" ;; *) fail "a future keepalive mtime is reported ($DOC_OUT)" ;; esac
case "$DOC_OUT" in *"refreshed -"*) fail "no negative age is printed" ;; *) pass "no negative age is printed" ;; esac
case "$DOC_OUT" in *"channel-keepalive-probe: the stamp's mtime is in the future"*) pass "a future probe stamp is reported" ;; *) fail "a future probe stamp is reported ($DOC_OUT)" ;; esac

D="$TMP/doc-fresh"; mkdir -p "$D/store"
: > "$D/store/.channel-keepalive"; : > "$D/store/.channel-keepalive-probe"
run_doctor "$D"
case "$DOC_OUT" in *"channel-keepalive: refreshed"*) pass "control: a fresh keepalive is 'refreshed N s ago'" ;; *) fail "control: a fresh keepalive is reported fresh ($DOC_OUT)" ;; esac
case "$DOC_OUT" in *"channel-keepalive-probe: ran"*) pass "control: a fresh probe stamp is 'ran N s ago'" ;; *) fail "control: a fresh probe stamp is reported ($DOC_OUT)" ;; esac

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
