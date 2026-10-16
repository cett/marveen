#!/bin/bash
# Tests for scripts/channel-watchdog.sh: the file-age signals must work with BSD stat (macOS) as well as GNU stat.
# Run: bash scripts/__tests__/channel-watchdog-stat.test.sh
#
# The watchdog read the keepalive and the respawn stamp with "stat -c %Y", which is an illegal option on macOS. The
# failure became mtime 0, so every tick looked wedged (STALE=true) and the respawn grace never applied: the main
# session was respawned on every run. Here the script runs from a throw-away install tree with a stub tmux and
# claude on PATH, and a stub stat that behaves like BSD stat, like GNU stat, or does not work at all, so the macOS
# behaviour is checked on any host. One case also runs the real stat of the host.
#
# Fixtures only: no real tmux, claude or node is touched (PATH is the stub directory plus /usr/bin:/bin, the dist
# build the auth-dead arm needs does not exist, so that arm stays out).

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_SRC="${CHANNEL_WATCHDOG_PATH:-$SRC_DIR/channel-watchdog.sh}"
PY="$(command -v python3)"
[ -z "$PY" ] && { echo "FATAL: python3 is needed for the stub stat"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- stubs ---------------------------------------------------------------------------------------------------
# $1 = stat flavour: bsd | gnu | broken | real
make_bin() {
  local bin="$1" flavour="$2"
  mkdir -p "$bin"
  cat > "$bin/tmux" <<'EOF'
#!/bin/sh
echo "$*" >> "$TMUX_LOG"
case "$1" in
  has-session) exit 0 ;;
  respawn-pane) exit 0 ;;
  capture-pane) exit 0 ;;
esac
exit 0
EOF
  printf '#!/bin/sh\nexit 0\n' > "$bin/claude"
  case "$flavour" in
    bsd)
      cat > "$bin/stat" <<EOF
#!/bin/sh
# BSD stat: no -c option; -f %m is the mtime. STAT_FAIL_PATTERN makes one file unreadable.
case "\${STAT_FAIL_PATTERN:-}" in ?*) case "\$*" in *"\$STAT_FAIL_PATTERN"*) echo "stat: \$*: No such file or directory" >&2; exit 1 ;; esac ;; esac
if [ "\$1" = "-f" ] && [ "\$2" = "%m" ]; then exec "$PY" -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' "\$3"; fi
echo "stat: illegal option -- \$(printf %s "\$1" | cut -c2)" >&2
exit 1
EOF
      ;;
    gnu)
      cat > "$bin/stat" <<EOF
#!/bin/sh
# GNU stat: -c %Y is the mtime; -f is the filesystem status (several lines, exit 0)
case "\${STAT_FAIL_PATTERN:-}" in ?*) case "\$*" in *"\$STAT_FAIL_PATTERN"*) echo "stat: cannot stat" >&2; exit 1 ;; esac ;; esac
if [ "\$1" = "-c" ] && [ "\$2" = "%Y" ]; then exec "$PY" -c 'import os,sys;print(int(os.path.getmtime(sys.argv[1])))' "\$3"; fi
if [ "\$1" = "-f" ]; then printf '  File: "%s"\n    ID: 0 Namelen: 255 Type: ext2/ext3\n' "\$3"; exit 0; fi
exit 1
EOF
      ;;
    broken)
      printf '#!/bin/sh\necho "stat: not available" >&2\nexit 1\n' > "$bin/stat"
      ;;
  esac
  [ -f "$bin/stat" ] && chmod +x "$bin/stat"
  chmod +x "$bin/tmux" "$bin/claude"
}

# one throw-away install tree per case; prints its path
make_install() {
  local root="$1"
  mkdir -p "$root/scripts/lib" "$root/store"
  cp "$SCRIPT_SRC" "$root/scripts/channel-watchdog.sh"
  # NO_LIB=1 leaves the helper file out, as on a checkout that has not been updated completely
  [ "${NO_LIB:-}" = "1" ] || cp "$SRC_DIR/lib/portable.sh" "$root/scripts/lib/portable.sh"
  chmod +x "$root/scripts/channel-watchdog.sh"
  printf 'MAIN_AGENT_ID=testbot\n' > "$root/.env"
}

# run_case <name> <flavour> <keepalive: none|fresh|old> <stamp: none|fresh|old> [STAT_FAIL_PATTERN]
# leaves $OUT (the script's output), $RESPAWNS (number of respawn-pane calls) and $RC
run_case() {
  local name="$1" flavour="$2" ka="$3" stamp="$4" fail_pat="${5:-}"
  local root="$TMP/$name"
  make_install "$root"
  make_bin "$root/bin" "$flavour"
  case "$ka" in
    fresh) touch "$root/store/.channel-keepalive" ;;
    old) touch -t 202001010000 "$root/store/.channel-keepalive" ;;
  esac
  case "$stamp" in
    fresh) touch "$root/store/.channel-last-respawn" ;;
    old) touch -t 202001010000 "$root/store/.channel-last-respawn" ;;
  esac
  : > "$root/tmux.log"
  local path="$root/bin:/usr/bin:/bin"
  [ "$flavour" = "real" ] && path="$root/bin:/usr/bin:/bin"
  OUT="$(cd "$root" && env -i HOME="$root" PATH="$path" TMUX_LOG="$root/tmux.log" STAT_FAIL_PATTERN="$fail_pat" \
    /bin/bash "$root/scripts/channel-watchdog.sh" 2>&1)"
  RC=$?
  RESPAWNS="$(grep -c '^respawn-pane' "$root/tmux.log")"
}

echo "BSD stat (macOS)"
run_case bsd-fresh bsd fresh none
assert_eq "a fresh keepalive is not stale: exit 0" "0" "$RC"
assert_eq "a fresh keepalive is not stale: no respawn" "0" "$RESPAWNS"

run_case bsd-old bsd old none
assert_eq "an old keepalive is stale: respawn issued once" "1" "$RESPAWNS"
case "$OUT" in *"keepalive stale"*) pass "the log says the keepalive is stale" ;; *) fail "the log says the keepalive is stale ($OUT)" ;; esac

run_case bsd-old-fresh-stamp bsd old fresh
assert_eq "a fresh respawn stamp holds the grace: no respawn" "0" "$RESPAWNS"
case "$OUT" in *"within respawn grace"*) pass "the log says the respawn is deferred" ;; *) fail "the log says the respawn is deferred ($OUT)" ;; esac

run_case bsd-old-old-stamp bsd old old
assert_eq "an old respawn stamp lets the respawn through" "1" "$RESPAWNS"

run_case bsd-nokeepalive bsd none none
assert_eq "no keepalive file: no respawn" "0" "$RESPAWNS"

echo "GNU stat"
run_case gnu-fresh gnu fresh none
assert_eq "a fresh keepalive is not stale: no respawn" "0" "$RESPAWNS"
run_case gnu-old gnu old none
assert_eq "an old keepalive is stale: respawn issued once" "1" "$RESPAWNS"
run_case gnu-old-fresh-stamp gnu old fresh
assert_eq "a fresh respawn stamp holds the grace: no respawn" "0" "$RESPAWNS"

echo "stat that cannot answer"
run_case broken-fresh broken fresh none
assert_eq "an unreadable keepalive mtime is not stale: no respawn" "0" "$RESPAWNS"
assert_eq "an unreadable keepalive mtime: exit 0" "0" "$RC"
case "$OUT" in *"cannot read the mtime"*) pass "the log says why" ;; *) fail "the log says why ($OUT)" ;; esac

run_case bsd-stamp-unreadable bsd old fresh "last-respawn"
assert_eq "an unreadable stamp age defers instead of respawning" "0" "$RESPAWNS"
case "$OUT" in *"cannot be read -- deferring"*) pass "the log says the stamp age is unreadable" ;; *) fail "the log says the stamp age is unreadable ($OUT)" ;; esac

# scripts/lib/portable.sh physically missing (an incomplete update). The age helpers are then "command not found",
# which must read as "age unknown": no respawn on age, and a WARN line that says why. Without the guard an old
# keepalive would have been read as mtime 0 and the main session respawned on every tick.
echo "helper file scripts/lib/portable.sh missing"
NO_LIB=1 run_case nolib-old gnu old none
assert_eq "an old keepalive is NOT acted on without the helper: no respawn" "0" "$RESPAWNS"
assert_eq "the watchdog still runs to the end: exit 0" "0" "$RC"
case "$OUT" in *"WARN scripts/lib/portable.sh missing"*) pass "the log carries the WARN about the missing helper" ;; *) fail "the log carries the WARN about the missing helper ($OUT)" ;; esac
case "$OUT" in *"cannot read the mtime"*) pass "the log says the keepalive age is unknown" ;; *) fail "the log says the keepalive age is unknown ($OUT)" ;; esac

NO_LIB=1 run_case nolib-old-bsd bsd old old
assert_eq "same on a BSD stat host with an old respawn stamp: no respawn" "0" "$RESPAWNS"

# the control: with the helper present the very same fixture respawns, so the cases above prove the helper's absence
run_case withlib-old gnu old none
assert_eq "control: the same old keepalive WITH the helper respawns once" "1" "$RESPAWNS"
case "$OUT" in *"WARN scripts/lib/portable.sh missing"*) fail "control: no missing-helper WARN when the helper exists" ;; *) pass "control: no missing-helper WARN when the helper exists" ;; esac

echo "the stat of this host"
run_case real-fresh real fresh none
assert_eq "a fresh keepalive is not stale: no respawn" "0" "$RESPAWNS"
run_case real-old real old none
assert_eq "an old keepalive is stale: respawn issued once" "1" "$RESPAWNS"
run_case real-old-fresh-stamp real old fresh
assert_eq "a fresh respawn stamp holds the grace: no respawn" "0" "$RESPAWNS"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
