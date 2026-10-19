#!/bin/bash
# Contract tests for the wake gate of telegram_progress_watchdog.py.
# Run: bash scripts/__tests__/telegram-watchdog-wake.test.sh
#
# A placeholder's age is measured on the wall clock, so a machine that slept makes every live placeholder look old
# and the sentry rewrote the placeholder of a healthy turn into the error text. kern.waketime (via the shared
# portable_wake_epoch helper) fixes it: for WAKE_GRACE_SEC (600) after a wake the run does nothing, afterwards an
# age is counted from the later of the file's mtime and the wake. Unknown wake time, or one in the future, keeps
# the behaviour without the gate.
#
# Hermetic like telegram-watchdog-wedged.test.sh: HOME and MARVEEN_ROOT are pinned to a temp tree, all Bot API
# traffic goes to a local stub, and kern.waketime comes from a stub sysctl (PORTABLE_SYSCTL_BIN) that prints
# STUB_WAKE_AGO seconds before now. Neutral fixtures only.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub (logs "<method> <body>" per request) -----------------
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        payload = json.dumps({"ok": True, "result": {"message_id": 9001}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as f: f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[ -z "$PORT" ] && { echo "FATAL: stub did not start"; exit 1; }
API_BASE="http://127.0.0.1:$PORT"

# --- Stub sysctl: `{ sec = N, usec = 0 } <date>`, N = now - STUB_WAKE_AGO; STUB_WAKE_RAW overrides the whole answer
cat > "$TMP/sysctl" <<'SHEOF'
#!/bin/bash
if [ -n "${STUB_WAKE_RAW+x}" ]; then printf '%s\n' "$STUB_WAKE_RAW"; exit 0; fi
printf '{ sec = %s, usec = 0 } Mon Oct 19 14:00:00 2026\n' "$(( $(date +%s) - STUB_WAKE_AGO ))"
SHEOF
chmod +x "$TMP/sysctl"

CHAT="10000000001"
ANSWER="EZ_A_VALODI_VALASZ"

# make_case NAME KIND AGE -> prints the progress dir. KIND: hung (reply tool call without result) | work (finished tool call)
make_case() {
    local name="$1" kind="$2" age="$3"
    local pdir="$TMP/root/agents/$name/.claude/channels/telegram/progress"
    local sdir="$TMP/root/agents/$name/.claude/channels/telegram"
    mkdir -p "$pdir"
    printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$sdir/.env"
    local tr="$sdir/transcript.jsonl"
    case "$kind" in
      hung)
        { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"}]}}';
          printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuReply1","name":"mcp__plugin_telegram_telegram__reply"}]}}'; } > "$tr" ;;
      work)
        { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"},{"type":"tool_use","id":"tuBash1","name":"Bash"}]}}';
          printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tuBash1"}]}}'; } > "$tr" ;;
    esac
    printf '[{"chat_id":"%s","message_id":555,"transcript_path":"%s"}]\n' "$CHAT" "$tr" > "$pdir/SID.json"
    python3 - "$pdir/SID.json" "$age" <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
    echo "$pdir"
}
make_marker() { # progress_dir age
    : > "$1/seen-m1.marker"
    python3 - "$1/seen-m1.marker" "$2" <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
}
pend_exists() { [ -f "$1/SID.json" ] && echo yes || echo no; }
marker_exists() { [ -f "$1/seen-m1.marker" ] && echo yes || echo no; }
count() { grep -c "^$1 " "$REQLOG" 2>/dev/null; }
wd_log() { cat "$1/debug.log" 2>/dev/null; }

# run_wd FORCE_UP WEDGED_UP_SEC  -- the wake comes from the environment of the caller (STUB_WAKE_AGO / STUB_WAKE_RAW)
run_wd() {
    : > "$REQLOG"
    HOME="$TMP" MARVEEN_ROOT="$TMP/root" TELEGRAM_API_BASE="$API_BASE" \
      PORTABLE_SYSCTL_BIN="${SYSCTL_BIN:-$TMP/sysctl}" \
      TELEGRAM_WATCHDOG_FORCE_AGENT_UP="$1" TELEGRAM_WATCHDOG_WEDGED_UP_SEC="$2" \
      python3 "$WATCHDOG"
}
reset_cases() { rm -rf "$TMP/root"; }

echo "telegram-watchdog-wake tests"
echo "============================"

# ---------------------------------------------------------------------------
echo ""
echo "(a) Inside the grace after a wake nothing is touched, whatever the file age"
reset_cases
export STUB_WAKE_AGO=60
PA="$(make_case wa work 5000)"            # far past the 900 s backstop
run_wd 1 1
assert_eq "backstop-old placeholder is NOT delivered" "0" "$(count sendMessage)"
assert_eq "no error edit" "0" "$(count editMessageText)"
assert_eq "placeholder preserved" "yes" "$(pend_exists "$PA")"
assert_eq "the skip is logged" "yes" "$(wd_log "$PA" | grep -q 'recently woken' && echo yes || echo no)"

reset_cases
PA2="$(make_case wb hung 5000)"           # a hung reply, fast threshold: would fire at once without the gate
run_wd 1 1
assert_eq "hung-reply placeholder is NOT delivered inside the grace" "0" "$(count sendMessage)"
assert_eq "placeholder preserved (hung)" "yes" "$(pend_exists "$PA2")"

reset_cases
PA3="$(make_case wc work 5000)"           # agent DOWN
run_wd 0 1
assert_eq "agent-down placeholder is NOT touched inside the grace" "0" "$(( $(count editMessageText) + $(count sendMessage) ))"
assert_eq "placeholder preserved (down)" "yes" "$(pend_exists "$PA3")"

# ---------------------------------------------------------------------------
echo ""
echo "(b) The grace edge: 590 s after the wake still skips, 610 s does not"
reset_cases
export STUB_WAKE_AGO=590
PB="$(make_case wd hung 5000)"
run_wd 1 1
assert_eq "590 s after the wake: skipped" "0" "$(count sendMessage)"
reset_cases
export STUB_WAKE_AGO=610
PB2="$(make_case we hung 5000)"
run_wd 1 1
assert_eq "610 s after the wake: the hung reply is delivered" "1" "$(count sendMessage)"
assert_eq "610 s after the wake: placeholder removed" "no" "$(pend_exists "$PB2")"

# ---------------------------------------------------------------------------
echo ""
echo "(c) After the grace an age counts from the later of mtime and wake"
reset_cases
export STUB_WAKE_AGO=700                  # past the grace; the file is 5000 s old, but only 700 s since the wake
PC="$(make_case wf work 5000)"            # backstop is 900 s
run_wd 1 1
assert_eq "age 5000 s but 700 s since the wake: below the backstop, untouched" "0" "$(count sendMessage)"
assert_eq "placeholder preserved" "yes" "$(pend_exists "$PC")"

reset_cases
export STUB_WAKE_AGO=1000                 # 1000 s since the wake > 900 s backstop
PC2="$(make_case wg work 5000)"
run_wd 1 1
assert_eq "1000 s since the wake: the backstop fires" "1" "$(count sendMessage)"

reset_cases
export STUB_WAKE_AGO=700
PC3="$(make_case wh work 100)"            # a placeholder created AFTER the wake keeps its own (younger) age
run_wd 1 1
assert_eq "a post-wake placeholder is not made older by the wake" "0" "$(count sendMessage)"
assert_eq "post-wake placeholder preserved" "yes" "$(pend_exists "$PC3")"

# ---------------------------------------------------------------------------
echo ""
echo "(d) Orphan dedup markers are aged the same way"
reset_cases
export STUB_WAKE_AGO=700
PD="$(make_case wi work 100)"
make_marker "$PD" 7200                    # 2 h old on the wall clock, 700 s since the wake
run_wd 1 1
assert_eq "marker kept: only 700 s since the wake (live turn's dedup marker)" "yes" "$(marker_exists "$PD")"
reset_cases
export STUB_WAKE_AGO=7000
PD2="$(make_case wj work 100)"
make_marker "$PD2" 7200
run_wd 1 1
assert_eq "marker swept once the wake is older than an hour too" "no" "$(marker_exists "$PD2")"

# ---------------------------------------------------------------------------
echo ""
echo "(e) Unknown or unbelievable wake time keeps the behaviour without the gate"
unset STUB_WAKE_AGO
reset_cases
SYSCTL_BIN="$TMP/no-such-sysctl"
PE="$(make_case wk work 1000)"
run_wd 1 1
assert_eq "no sysctl binary: the backstop still fires" "1" "$(count sendMessage)"

for raw in "garbage" "" "{ sec = abc, usec = 0 }" "{ usec = 5 }"; do
  reset_cases
  SYSCTL_BIN="$TMP/sysctl"; export STUB_WAKE_RAW="$raw"
  make_case wl work 1000 >/dev/null
  run_wd 1 1
  assert_eq "unparseable answer '$raw': the backstop still fires" "1" "$(count sendMessage)"
done
unset STUB_WAKE_RAW

reset_cases
SYSCTL_BIN="$TMP/sysctl"; export STUB_WAKE_AGO=-3600     # a wake time one hour in the FUTURE (clock set back)
make_case wm work 1000 >/dev/null
run_wd 1 1
assert_eq "wake in the future is ignored: the backstop still fires" "1" "$(count sendMessage)"
unset STUB_WAKE_AGO SYSCTL_BIN

# ---------------------------------------------------------------------------
echo ""
echo "(f) A stray copy without the shared library has no wake information (no crash)"
reset_cases
mkdir -p "$TMP/stray/scripts/hooks" "$TMP/stray/.claude"
cp "$WATCHDOG" "$TMP/stray/scripts/hooks/telegram_progress_watchdog.py"
make_case wn work 1000 >/dev/null
: > "$REQLOG"
HOME="$TMP" MARVEEN_ROOT="$TMP/root" TELEGRAM_API_BASE="$API_BASE" PORTABLE_SYSCTL_BIN="$TMP/sysctl" STUB_WAKE_AGO=60 \
  TELEGRAM_WATCHDOG_FORCE_AGENT_UP=1 python3 "$TMP/stray/scripts/hooks/telegram_progress_watchdog.py"
assert_eq "no portable.sh next to it: runs as before and delivers" "1" "$(count sendMessage)"

echo ""
echo "=============================="
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
