#!/bin/bash
# Contract tests for the re-install hygiene of scripts/install-telegram-progress-hook.sh:
#   (a) a com.<other-id>.telegram-progress-watchdog job that belongs to THIS
#       install (renamed install, stale id) is booted out and its plist removed;
#   (b) a job running the shared legacy ~/.claude/hooks copy is retired too;
#   (c) a job that points into ANOTHER install (incl. a sibling dir that merely
#       shares a name prefix) is left alone;
#   (d) the own-label job and jobs of other names are never touched;
#   (e) an EXISTING stale ~/.claude/hooks copy is refreshed to the repo version,
#       a missing copy is NOT created, a symlinked copy is NOT overwritten;
#   (f) a second run is a no-op (idempotent).
# Run: bash scripts/__tests__/install-telegram-progress-retire.test.sh
#
# Fully hermetic: temp HOME, a temp copy of the installer tree (so INSTALL_DIR
# is a temp dir, not the real checkout), launchctl stubbed on PATH. Fixture ids
# are neutral (svc-new / svc-old / svc-other): no real agent or service names.
# bash 3.2 compatible (macOS /bin/bash).

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"
  else fail "$1 (expected '$2', got '$3')"; fi
}
assert_file()   { if [ -e "$1" ]; then pass "$2"; else fail "$2 (missing: $1)"; fi; }
assert_absent() { if [ ! -e "$1" ] && [ ! -L "$1" ]; then pass "$2"; else fail "$2 (should not exist: $1)"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK_FILES="telegram_progress.py telegram_progress_clear.py telegram_progress_reply_clear.py telegram_progress_watchdog.py"

# new_install <dir> <service-id>: a minimal installer tree under <dir>.
new_install() {
  mkdir -p "$1/scripts/hooks"
  cp "$REPO_ROOT/scripts/install-telegram-progress-hook.sh" "$REPO_ROOT/scripts/launchd-label.sh" "$1/scripts/"
  for f in $HOOK_FILES; do cp "$REPO_ROOT/scripts/hooks/$f" "$1/scripts/hooks/$f"; done
  printf 'SERVICE_ID=%s\n' "$2" > "$1/.env"
}

# mkplist <file> <label> <program-arg> <root>: a plist shaped like the installer's.
mkplist() {
  cat > "$1" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$2</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>$3</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>MARVEEN_ROOT</key>
        <string>$4</string>
    </dict>
</dict>
</plist>
EOF
}

# A fresh HOME + stub bin per case. launchctl records its argv, then succeeds.
setup_case() { # <name> -> sets CASE HOME_C BIN_C CALLS LA
  CASE="$TMP/$1"
  HOME_C="$CASE/home"
  BIN_C="$CASE/bin"
  CALLS="$CASE/launchctl.calls"
  LA="$HOME_C/Library/LaunchAgents"
  mkdir -p "$HOME_C/.claude/hooks" "$BIN_C" "$LA"
  : > "$CALLS"
  printf '#!/bin/bash\necho "$@" >> "%s"\nexit 0\n' "$CALLS" > "$BIN_C/launchctl"
  chmod +x "$BIN_C/launchctl"
}
run_install() { # <install-dir> -> OUT, EXIT
  OUT="$(HOME="$HOME_C" PATH="$BIN_C:$PATH" bash "$1/scripts/install-telegram-progress-hook.sh" 2>&1)"
  EXIT=$?
}

# ---------------------------------------------------------------------------
# (e) Global hook copies -- platform independent
# ---------------------------------------------------------------------------
echo ""
echo "(e) ~/.claude/hooks copies: refresh existing stale ones only"
setup_case case-e
INST_E="$CASE/install-new"
new_install "$INST_E" svc-new
HOOKS_E="$HOME_C/.claude/hooks"
# stale regular copy
printf '#!/usr/bin/env python3\n# stale\n' > "$HOOKS_E/telegram_progress_watchdog.py"
# up-to-date copy
cp "$REPO_ROOT/scripts/hooks/telegram_progress.py" "$HOOKS_E/telegram_progress.py"
# symlinked copy: the target must keep its content
printf 'symlink-target-original\n' > "$CASE/elsewhere.py"
ln -s "$CASE/elsewhere.py" "$HOOKS_E/telegram_progress_clear.py"
# telegram_progress_reply_clear.py intentionally absent
run_install "$INST_E"
assert_eq "exit 0" "0" "$EXIT"
if cmp -s "$REPO_ROOT/scripts/hooks/telegram_progress_watchdog.py" "$HOOKS_E/telegram_progress_watchdog.py"; then
  pass "stale watchdog copy refreshed to the repo version"
else
  fail "stale watchdog copy NOT refreshed"
fi
assert_eq "refreshed copy keeps the exec bit" "yes" \
  "$([ -x "$HOOKS_E/telegram_progress_watchdog.py" ] && echo yes || echo no)"
if cmp -s "$REPO_ROOT/scripts/hooks/telegram_progress.py" "$HOOKS_E/telegram_progress.py"; then
  pass "up-to-date copy stays identical"
else
  fail "up-to-date copy changed"
fi
assert_eq "symlinked copy: target not overwritten" "symlink-target-original" "$(cat "$CASE/elsewhere.py")"
assert_eq "symlinked copy: still a symlink" "yes" "$([ -L "$HOOKS_E/telegram_progress_clear.py" ] && echo yes || echo no)"
assert_absent "$HOOKS_E/telegram_progress_reply_clear.py" "missing copy is NOT created (#1305 contract)"
assert_eq "no temp file left behind" "0" "$(ls "$HOOKS_E" | grep -c '\.new\.')"
echo "$OUT" | grep -q "Refreshed stale global hook copy" && pass "refresh announced" || fail "refresh not announced"

if [ "$(uname -s)" != "Darwin" ]; then
  echo ""
  echo "SKIP: launchd cases (a)-(d), (f) need Darwin"
  echo ""
  echo "Result: $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]; exit $?
fi

# ---------------------------------------------------------------------------
# (a)-(d), (f) launchd plists
# ---------------------------------------------------------------------------
echo ""
echo "(a)-(d) launchd: retire own-tree leftovers, spare everything else"
setup_case case-l
INST_A="$CASE/install-new"
INST_OTHER="$CASE/install-other"
INST_SIBLING="$CASE/install-new-2"   # shares the name PREFIX of install-new
new_install "$INST_A" svc-new
OWN_REPO_WD="$INST_A/scripts/hooks/telegram_progress_watchdog.py"
LEGACY_WD="$HOME_C/.claude/hooks/telegram_progress_watchdog.py"

# (a) stale other-id job pointing at THIS install (repo watchdog + MARVEEN_ROOT)
mkplist "$LA/com.svc-old.telegram-progress-watchdog.plist" com.svc-old.telegram-progress-watchdog "$OWN_REPO_WD" "$INST_A"
# (b) stale other-id job running the shared legacy global copy
mkplist "$LA/com.svc-legacy.telegram-progress-watchdog.plist" com.svc-legacy.telegram-progress-watchdog "$LEGACY_WD" "$CASE/somewhere"
# (c) another install's job, and a sibling dir with a shared name prefix
mkplist "$LA/com.svc-other.telegram-progress-watchdog.plist" com.svc-other.telegram-progress-watchdog "$INST_OTHER/scripts/hooks/telegram_progress_watchdog.py" "$INST_OTHER"
mkplist "$LA/com.svc-sibling.telegram-progress-watchdog.plist" com.svc-sibling.telegram-progress-watchdog "$INST_SIBLING/scripts/hooks/telegram_progress_watchdog.py" "$INST_SIBLING"
# (d) a job of a DIFFERENT name that points at this install
mkplist "$LA/com.svc-old.channel-keepalive-probe.plist" com.svc-old.channel-keepalive-probe "$INST_A/scripts/channel-keepalive-probe.sh" "$INST_A"

run_install "$INST_A"
assert_eq "exit 0" "0" "$EXIT"
assert_absent "$LA/com.svc-old.telegram-progress-watchdog.plist" "(a) own-tree stale plist removed"
assert_absent "$LA/com.svc-legacy.telegram-progress-watchdog.plist" "(b) legacy-global-copy plist removed"
assert_file "$LA/com.svc-other.telegram-progress-watchdog.plist" "(c) other install's plist kept"
assert_file "$LA/com.svc-sibling.telegram-progress-watchdog.plist" "(c) prefix-sibling install's plist kept"
assert_file "$LA/com.svc-old.channel-keepalive-probe.plist" "(d) other-name plist untouched"
assert_file "$LA/com.svc-new.telegram-progress-watchdog.plist" "(d) own-label plist written"
if grep -qF "<string>$OWN_REPO_WD</string>" "$LA/com.svc-new.telegram-progress-watchdog.plist"; then
  pass "(d) own-label plist runs the repo watchdog"
else
  fail "(d) own-label plist does not run the repo watchdog"
fi

assert_eq "bootout issued for the stale own-tree label" "1" \
  "$(grep -c 'bootout .*com\.svc-old\.telegram-progress-watchdog' "$CALLS")"
assert_eq "bootout issued for the legacy-copy label" "1" \
  "$(grep -c 'bootout .*com\.svc-legacy\.telegram-progress-watchdog' "$CALLS")"
assert_eq "no bootout for the other install" "0" \
  "$(grep -c 'bootout .*com\.svc-other\.' "$CALLS")"
assert_eq "no bootout for the prefix sibling" "0" \
  "$(grep -c 'bootout .*com\.svc-sibling\.' "$CALLS")"
assert_eq "no bootout for the own label" "0" \
  "$(grep -c 'bootout .*com\.svc-new\.' "$CALLS")"
assert_eq "no bootout for the other-name job" "0" \
  "$(grep -c 'bootout .*channel-keepalive-probe' "$CALLS")"
echo "$OUT" | grep -q "Retired stale launchd job: com.svc-old.telegram-progress-watchdog" \
  && pass "retirement announced" || fail "retirement not announced"
echo "$OUT" | grep -q "Left alone: com.svc-other.telegram-progress-watchdog" \
  && pass "left-alone job reported" || fail "left-alone job not reported"

# ---------------------------------------------------------------------------
# (f) idempotent second run
# ---------------------------------------------------------------------------
echo ""
echo "(f) second run is a no-op"
: > "$CALLS"
run_install "$INST_A"
assert_eq "second run exit 0" "0" "$EXIT"
assert_eq "second run retires nothing" "0" "$(echo "$OUT" | grep -c 'Retired stale')"
assert_eq "second run issues no bootout" "0" "$(grep -c bootout "$CALLS")"
assert_file "$LA/com.svc-other.telegram-progress-watchdog.plist" "second run: other install's plist still kept"

# ---------------------------------------------------------------------------
# (g) failing launchctl must not abort the install (bootout AND unload fail)
# ---------------------------------------------------------------------------
echo ""
echo "(g) launchctl failure does not stop the retire + install"
setup_case case-fail
INST_F="$CASE/install-new"
new_install "$INST_F" svc-new
mkplist "$LA/com.svc-old.telegram-progress-watchdog.plist" com.svc-old.telegram-progress-watchdog "$INST_F/scripts/hooks/telegram_progress_watchdog.py" "$INST_F"
printf '#!/bin/bash\nexit 1\n' > "$BIN_C/launchctl"
run_install "$INST_F"
assert_eq "exit 0 despite launchctl failing" "0" "$EXIT"
assert_absent "$LA/com.svc-old.telegram-progress-watchdog.plist" "plist still removed when launchctl fails"
assert_file "$LA/com.svc-new.telegram-progress-watchdog.plist" "own plist still written when launchctl fails"

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
