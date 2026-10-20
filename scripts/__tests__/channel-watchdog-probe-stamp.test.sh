#!/bin/bash
# Tests for the keepalive-probe stamp: scripts/channel-keepalive-probe.sh writes store/.channel-keepalive-probe at
# the start of EVERY run, and scripts/channel-watchdog.sh counts the keepalive age as a wedge only while that stamp
# is fresh (PROBE_STALE_SECONDS = 600).
# Run: bash scripts/__tests__/channel-watchdog-probe-stamp.test.sh
#
# Why: on macOS the probe is a launchd agent that does not start without a GUI login. A quiet session then ages the
# keepalive file past 15 minutes although nothing is wrong, and the watchdog respawned it (and threw the
# conversation away) up to three times. Here both scripts run from a throw-away install tree with a stub tmux and a
# stub ps, so no real session, process or stat is touched.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG_SRC="${CHANNEL_WATCHDOG_PATH:-$SRC_DIR/channel-watchdog.sh}"
PROBE_SRC="${CHANNEL_PROBE_PATH:-$SRC_DIR/channel-keepalive-probe.sh}"
PY="$(command -v python3)"
[ -z "$PY" ] && { echo "FATAL: python3 is needed to set file ages"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# set_age <file> <seconds>: the file's mtime becomes "now - seconds"
set_age() { "$PY" -c 'import os,sys,time;t=time.time()-int(sys.argv[2]);os.utime(sys.argv[1],(t,t))' "$1" "$2"; }

# make_bin <dir> <has-session: yes|no>: a tmux that logs its respawns, and a ps that shows no poller
make_bin() {
  local bin="$1" has="$2"
  mkdir -p "$bin"
  cat > "$bin/tmux" <<EOF
#!/bin/sh
echo "\$*" >> "\$TMUX_LOG"
case "\$1" in
  has-session) [ "$has" = "yes" ] && exit 0; exit 1 ;;
  list-panes) echo 1; exit 0 ;;
esac
exit 0
EOF
  printf '#!/bin/sh\nexit 0\n' > "$bin/claude"
  printf '#!/bin/sh\nexit 0\n' > "$bin/ps"
  chmod +x "$bin/tmux" "$bin/claude" "$bin/ps"
}

# make_install <root>: the scripts, the helper and an .env
make_install() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/store"
  cp "$WATCHDOG_SRC" "$root/scripts/channel-watchdog.sh"
  cp "$PROBE_SRC" "$root/scripts/channel-keepalive-probe.sh"
  cp "$SRC_DIR/lib/portable.sh" "$root/scripts/lib/portable.sh"
  printf 'MAIN_AGENT_ID=testbot\n' > "$root/.env"
}

# run_watchdog <name> <keepalive-age|none> <probe-stamp: none|<seconds>|unreadable>
# leaves $OUT and $RESPAWNS; the keepalive is always older than the 15 min threshold when given
run_watchdog() {
  local name="$1" ka="$2" probe="$3"
  local root="$TMP/$name"
  make_install "$root"
  make_bin "$root/bin" yes
  if [ "$ka" != "none" ]; then touch "$root/store/.channel-keepalive"; set_age "$root/store/.channel-keepalive" "$ka"; fi
  case "$probe" in
    none) ;;
    unreadable)
      # a fresh stamp file whose mtime cannot be read: stat fails for that path only
      touch "$root/store/.channel-keepalive-probe"
      printf '#!/bin/sh\ncase "$*" in *.channel-keepalive-probe*) echo "stat: cannot stat" >&2; exit 1 ;; esac\nexec /usr/bin/stat "$@"\n' > "$root/bin/stat"
      chmod +x "$root/bin/stat" ;;
    *) touch "$root/store/.channel-keepalive-probe"; set_age "$root/store/.channel-keepalive-probe" "$probe" ;;
  esac
  : > "$root/tmux.log"
  OUT="$(cd "$root" && env -i HOME="$root" PATH="$root/bin:/usr/bin:/bin" TMUX_LOG="$root/tmux.log" PORTABLE_SYSCTL_BIN=/usr/bin/false \
    /bin/bash "$root/scripts/channel-watchdog.sh" 2>&1)"
  RESPAWNS="$(grep -c '^respawn-pane' "$root/tmux.log")"
  ROOT_LAST="$root"
}
has() { printf '%s' "$OUT" | grep -q -- "$1"; }

echo "watchdog: the keepalive age is evidence only while the probe runs"

run_watchdog a-no-stamp 4000 none
assert_eq "(a) no probe stamp + old keepalive: no respawn" "0" "$RESPAWNS"
if has "keepalive-probe not running: no probe stamp"; then pass "(a) the log says why the STALE signal is off"; else fail "(a) log line missing ($OUT)"; fi

run_watchdog b-fresh-stamp 4000 30
assert_eq "(b) fresh probe stamp + old keepalive: respawn (today's behaviour)" "1" "$RESPAWNS"
if has "keepalive stale"; then pass "(b) the respawn reason is the stale keepalive"; else fail "(b) reason missing ($OUT)"; fi

run_watchdog c-599 4000 599
assert_eq "(c) stamp 599 s old: still counts, respawn" "1" "$RESPAWNS"
run_watchdog c-600 4000 600
assert_eq "(c) stamp exactly 600 s old: the probe is not running, no respawn" "0" "$RESPAWNS"
run_watchdog c-601 4000 601
assert_eq "(c) stamp 601 s old: no respawn" "0" "$RESPAWNS"

run_watchdog d-unreadable 4000 unreadable
assert_eq "(d) a probe stamp that cannot be read: STALE=false, no respawn" "0" "$RESPAWNS"

run_watchdog e-fresh-keepalive 10 none
assert_eq "a fresh keepalive needs no probe stamp: nothing happens" "0" "$RESPAWNS"
if has "keepalive-probe not running"; then fail "no 'probe not running' line when the keepalive is fresh ($OUT)"; else pass "no 'probe not running' line when the keepalive is fresh"; fi

echo "watchdog: the 'probe not running' line is logged once a day"
run_watchdog warn-first 4000 none
if has "keepalive-probe not running"; then pass "first tick logs it"; else fail "first tick did not log ($OUT)"; fi
OUT2="$(cd "$ROOT_LAST" && env -i HOME="$ROOT_LAST" PATH="$ROOT_LAST/bin:/usr/bin:/bin" TMUX_LOG="$ROOT_LAST/tmux.log" PORTABLE_SYSCTL_BIN=/usr/bin/false \
  /bin/bash "$ROOT_LAST/scripts/channel-watchdog.sh" 2>&1)"
if printf '%s' "$OUT2" | grep -q "keepalive-probe not running"; then fail "second tick logged it again ($OUT2)"; else pass "second tick stays quiet"; fi
set_age "$ROOT_LAST/store/.channel-watchdog-probe-warned" 90000
OUT3="$(cd "$ROOT_LAST" && env -i HOME="$ROOT_LAST" PATH="$ROOT_LAST/bin:/usr/bin:/bin" TMUX_LOG="$ROOT_LAST/tmux.log" PORTABLE_SYSCTL_BIN=/usr/bin/false \
  /bin/bash "$ROOT_LAST/scripts/channel-watchdog.sh" 2>&1)"
if printf '%s' "$OUT3" | grep -q "keepalive-probe not running"; then pass "a day later it is logged again"; else fail "not logged after a day ($OUT3)"; fi

echo "probe: the stamp is written first, on every exit path"

# run_probe <name> <tmux: absent|nosession|session-nopoller>
run_probe() {
  local name="$1" mode="$2"
  local root="$TMP/$name"
  make_install "$root"
  case "$mode" in
    absent)            mkdir -p "$root/bin" ;;                    # no tmux on PATH at all
    nosession)         make_bin "$root/bin" no ;;                 # has-session fails
    session-nopoller)  make_bin "$root/bin" yes ;;                # session, pane pid, but ps shows no poller
  esac
  : > "$root/tmux.log"
  rm -f "$root/store/.channel-keepalive-probe"
  # PATH: the stub dir first; for "absent" a dir with only the tools the script needs
  local path="$root/bin:/usr/bin:/bin"
  [ "$mode" = "absent" ] && { for t in date dirname grep head cut mkdir mv rm touch tr awk; do ln -sf "$(command -v $t)" "$root/bin/$t"; done; path="$root/bin"; }
  PROBE_OUT="$(cd "$root" && env -i HOME="$root" PATH="$path" TMUX_LOG="$root/tmux.log" /bin/bash "$root/scripts/channel-keepalive-probe.sh" 2>&1)"
  PROBE_STAMP="$root/store/.channel-keepalive-probe"
  PROBE_KA="$root/store/.channel-keepalive"
}

now_s() { date +%s; }

run_probe p-absent absent
if [ -f "$PROBE_STAMP" ]; then pass "(e) tmux missing: the stamp is written"; else fail "(e) tmux missing: no stamp ($PROBE_OUT)"; fi
run_probe p-nosession nosession
if [ -f "$PROBE_STAMP" ]; then pass "(e) no session: the stamp is written"; else fail "(e) no session: no stamp ($PROBE_OUT)"; fi
run_probe p-nopoller session-nopoller
if [ -f "$PROBE_STAMP" ]; then pass "(e) session but no poller: the stamp is written"; else fail "(e) no poller: no stamp ($PROBE_OUT)"; fi
if [ -f "$PROBE_KA" ]; then fail "(e) no poller: the keepalive must NOT be touched"; else pass "(e) no poller: the keepalive is not touched (the watchdog owns recovery)"; fi

stamp_val="$(cat "$PROBE_STAMP" 2>/dev/null)"
diff=$(( $(now_s) - ${stamp_val:-0} ))
if [ "$diff" -ge 0 ] && [ "$diff" -lt 60 ]; then pass "the stamp holds the current epoch seconds"; else fail "the stamp is not a current epoch ($stamp_val)"; fi
if ls "$TMP/p-nopoller/store" | grep -q '\.tmp$'; then fail "a tmp file is left behind"; else pass "no tmp file is left behind (atomic tmp + mv)"; fi

echo "doctor: the probe stamp line"
# The doctor is one long script that talks to launchd and the dashboard, so only its probe-stamp section runs here,
# cut out between its own marker comment and the next section heading, in a throw-away working directory.
DOCTOR_SECTION="$TMP/doctor-section.sh"
awk '/^# The keepalive probe stamps/{f=1} /^# --- [S]ettings ---/{f=0} f' "$SRC_DIR/doctor.sh" > "$DOCTOR_SECTION"
if [ -s "$DOCTOR_SECTION" ]; then pass "(f) the probe-stamp section is found in doctor.sh"; else fail "(f) the probe-stamp section is missing from doctor.sh"; fi
run_doctor() {
  local name="$1" age="$2" dir="$TMP/doctor-$1"
  mkdir -p "$dir/store"
  if [ "$age" != "none" ]; then touch "$dir/store/.channel-keepalive-probe"; set_age "$dir/store/.channel-keepalive-probe" "$age"; fi
  DOC_OUT="$(cd "$dir" && ok() { echo "OK $1"; }; warn() { echo "WARN $1"; }; fail() { echo "FAIL $1"; }; . "$DOCTOR_SECTION" 2>&1)"
}
run_doctor missing none
case "$DOC_OUT" in WARN*"NOT RUNNING"*"install-channel-keepalive-probe.sh"*) pass "(f) a missing stamp is a WARN with the fix command" ;; *) fail "(f) missing stamp: $DOC_OUT" ;; esac
run_doctor old 900
case "$DOC_OUT" in WARN*"NOT RUNNING (last run 9"*) pass "(f) an old stamp is a WARN" ;; *) fail "(f) old stamp: $DOC_OUT" ;; esac
run_doctor fresh 60
case "$DOC_OUT" in OK*"ran 6"*) pass "(f) a fresh stamp is OK" ;; *) fail "(f) fresh stamp: $DOC_OUT" ;; esac

echo "installer: waits for the first stamp and says what is missing"
# make_installer <name> <launchctl: writes-stamp|silent>: a throw-away tree with the installer, its label helper and a stub launchctl
make_installer() {
  local name="$1" mode="$2" root="$TMP/inst-$1"
  mkdir -p "$root/scripts" "$root/store" "$root/bin" "$root/home/Library/LaunchAgents"
  cp "$SRC_DIR/install-channel-keepalive-probe.sh" "$SRC_DIR/launchd-label.sh" "$root/scripts/"
  cp "$PROBE_SRC" "$root/scripts/channel-keepalive-probe.sh"
  printf 'SERVICE_ID=testbot\n' > "$root/.env"
  if [ "$mode" = "writes-stamp" ]; then
    printf '#!/bin/sh\ncase "$1" in load) date +%%s > "%s/store/.channel-keepalive-probe" ;; esac\nexit 0\n' "$root" > "$root/bin/launchctl"
  else
    printf '#!/bin/sh\nexit 0\n' > "$root/bin/launchctl"
  fi
  chmod +x "$root/bin/launchctl"
  INST_OUT="$(cd "$root" && env -i HOME="$root/home" PATH="$root/bin:/usr/bin:/bin" KEEPALIVE_PROBE_WAIT_SECONDS=5 /bin/bash "$root/scripts/install-channel-keepalive-probe.sh" --load 2>&1)"
  INST_RC=$?
}
make_installer inst-ok writes-stamp
case "$INST_OUT" in *"OK: the probe ran"*) pass "(g) a fresh stamp after the load: OK line" ;; *) fail "(g) no OK line: $INST_OUT" ;; esac
make_installer inst-none silent
case "$INST_OUT" in *"WARNING: the probe has not run within 5s"*"gui domain"*"launchctl bootstrap gui/"*) pass "(g) no stamp: the warning names the gui domain and the bootstrap command" ;; *) fail "(g) no warning: $INST_OUT" ;; esac
assert_eq "(g) a missing stamp does not fail the installer" "0" "$INST_RC"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
