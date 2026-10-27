#!/bin/bash
# Contract test for scripts/agent-api.sh (Phase T3 shell wrapper). A stub curl records what the
# wrapper hands it, so the test can prove the token is on STDIN and never in argv.
# Run: bash scripts/__tests__/agent-api.test.sh

set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
check() { # check "name" cmd...
  local name="$1"; shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
INSTALL="$T/install"; mkdir -p "$INSTALL/scripts" "$INSTALL/store" "$INSTALL/agents/a" "$INSTALL/bin" "$T/bin"
cp "$SRC/scripts/agent-api.sh" "$INSTALL/scripts/agent-api.sh"
W="$INSTALL/scripts/agent-api.sh"

cat > "$T/bin/curl" <<'STUB'
#!/bin/bash
n=0; [ -f "$STUB_DIR/calls" ] && n=$(cat "$STUB_DIR/calls"); echo $((n + 1)) > "$STUB_DIR/calls"
printf '%s\n' "$@" > "$STUB_DIR/argv"
: > "$STUB_DIR/stdin"
for a in "$@"; do [ "$a" = "-K" ] && cat > "$STUB_DIR/stdin"; done
for a in "$@"; do case "$a" in @*) cat "${a#@}" > "$STUB_DIR/body" 2>/dev/null ;; esac; done
printf '{"ok":true}\n%s' "${STUB_CODE:-200}"
STUB
chmod +x "$T/bin/curl"

export STUB_DIR="$T"; export PATH="$T/bin:$PATH"
export MAIN_AGENT_ID=m; unset MARVEEN_AGENT_ID MARVEEN_AGENT_TOKEN_FILE MARVEEN_WEB_PORT WEB_PORT CLAUDE_CONFIG_DIR
reset() { rm -f "$T/calls" "$T/argv" "$T/stdin" "$T/body"; rm -f "$INSTALL/store/".*-token "$INSTALL/store/.dashboard-token" "$INSTALL/agents/a/.agent-token" "$INSTALL/.agent-token"; }

echo "agent-api tests"
echo "==============="

# 1 own token: on stdin, not in argv
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
OUT="$(bash "$W" --agent a GET /api/agents 2>&1)"; RC=$?
check "own token: exit 0 and body printed" test "$RC" -eq 0 -a "$OUT" = '{"ok":true}'
check "own token: on the curl config (stdin)" grep -q 'Bearer own-a' "$T/stdin"
check "own token: never in argv" bash -c "! grep -q 'own-a' '$T/argv'"
check "own token: shared token not sent" bash -c "! grep -q 'shared' '$T/stdin'"
check "own token: no -H Authorization in argv" bash -c "! grep -qi 'authorization' '$T/argv'"

# 2 missing own token: NO fallback to the shared token, NO request, exit 3, the fix is named
reset; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent a GET /api/agents >"$T/out" 2>"$T/err"; RC=$?
check "missing own token: exit 3" test "$RC" -eq 3
check "missing own token: no request made at all (no shared_token_use for the server to count)" test ! -e "$T/calls"
check "missing own token: the shared token is not sent" bash -c "! grep -q 'shared' '$T/stdin' 2>/dev/null"
check "missing own token: the message names the fix" grep -q 'agent-tokens -- issue a' "$T/err"
check "missing own token: no response body" test ! -s "$T/out"

# 3 empty own token file is a miss, same outcome
reset; : > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent a GET /api/agents >/dev/null 2>&1; RC=$?
check "empty own token file: exit 3, no request" bash -c "test $RC -eq 3 && test ! -e '$T/calls'"

# 4 nothing at all: no token and no shared file either, same outcome
reset
bash "$W" --agent a GET /api/agents >/dev/null 2>&1; RC=$?
check "no token anywhere: exit 3, no request" bash -c "test $RC -eq 3 && test ! -e '$T/calls'"

# 5 a REFUSED own token is not retried on the shared one
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
STUB_CODE=401 bash "$W" --agent a GET /api/agents >"$T/out" 2>"$T/err"; RC=$?
check "401: exit 22" test "$RC" -eq 22
check "401: exactly one request, no shared retry" test "$(cat "$T/calls")" = 1
check "401: status on stderr" grep -q 'HTTP 401' "$T/err"
check "401: body still printed" grep -q '"ok"' "$T/out"

# 6 --token shared is gone: a usage error, no request, whatever tokens exist
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent a --token shared POST /api/agents/x/restart >/dev/null 2>"$T/err"; RC=$?
check "--token shared: exit 2 (usage), no request" bash -c "test $RC -eq 2 && test ! -e '$T/calls'"
check "--token shared: says it no longer exists" grep -q 'no longer exists' "$T/err"

# 7 operator token
reset; echo op > "$INSTALL/store/.operator-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --token operator GET /api/agents >/dev/null 2>&1
check "--token operator: operator token sent" grep -q 'Bearer op' "$T/stdin"
reset; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --token operator GET /api/agents >"$T/out" 2>"$T/err"; RC=$?
check "--token operator: missing file is exit 3, not the shared token" bash -c "test $RC -eq 3 && test ! -e '$T/calls'"
check "--token operator: the message names issue-operator" grep -q 'issue-operator' "$T/err"

# 7b admin kind: the main agent's own token; every other agent is refused (exit 3), no request
reset; echo own-m > "$INSTALL/.agent-token"; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent m --token admin POST /api/agents/x/restart >/dev/null 2>&1
check "--token admin: main agent sends its own token" grep -q 'Bearer own-m' "$T/stdin"
rm -f "$T/calls" "$T/stdin"
bash "$W" --agent a --token admin POST /api/agents/x/restart >/dev/null 2>"$T/err"; RC=$?
check "--token admin: any other agent is refused, exit 3, no request" bash -c "test $RC -eq 3 && test ! -e '$T/calls'"
check "--token admin: the refusal names the way (ask the main agent)" grep -q 'ask the main agent' "$T/err"

# 7c main kind: the main agent's token whoever runs it
reset; echo own-m > "$INSTALL/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
( cd "$T" && bash "$W" --token main GET /api/agents >/dev/null 2>&1 )
check "--token main: main agent token from any cwd" grep -q 'Bearer own-m' "$T/stdin"
check "--token main: names the main agent" grep -qx 'X-Agent-Id: m' "$T/argv"

# 8 main agent: token in the install root, cwd decides the identity
reset; echo own-m > "$INSTALL/.agent-token"
( cd "$INSTALL" && bash "$W" GET /api/agents >/dev/null 2>&1 )
check "main agent: install-root token from the cwd" grep -q 'Bearer own-m' "$T/stdin"
reset; echo own-a > "$INSTALL/agents/a/.agent-token"
( cd "$INSTALL/agents/a" && bash "$W" GET /api/agents >/dev/null 2>&1 )
check "sub-agent: token from the cwd" grep -q 'Bearer own-a' "$T/stdin"
reset; echo shared > "$INSTALL/store/.dashboard-token"
( cd "$T" && bash "$W" GET /api/agents >/dev/null 2>"$T/err" ); RC=$?
check "unknown cwd and no identity: exit 3, no request, the shared token is not a way out" bash -c "test ! -e '$T/calls' && grep -q 'unknown agent' '$T/err'"

# 8b a cwd that names nobody: the launch's config dir does
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
( cd "$T" && CLAUDE_CONFIG_DIR="$INSTALL/agents/a/.claude-config" bash "$W" GET /api/agents >/dev/null 2>&1 )
check "scratch cwd + agent config dir: the agent's own token" grep -q 'Bearer own-a' "$T/stdin"
check "scratch cwd + agent config dir: names the agent" grep -qx 'X-Agent-Id: a' "$T/argv"
( cd "$T" && CLAUDE_CONFIG_DIR="$INSTALL/agents/a/.claude-config/projects/" bash "$W" GET /api/agents >/dev/null 2>&1 )
check "scratch cwd + path below the config dir: still the agent" grep -qx 'X-Agent-Id: a' "$T/argv"
reset; echo own-m > "$INSTALL/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
( cd "$T" && CLAUDE_CONFIG_DIR="$INSTALL/.channels-config" bash "$W" GET /api/agents >/dev/null 2>&1 )
check "scratch cwd + main channels config dir: the main agent's token" grep -q 'Bearer own-m' "$T/stdin"
reset; echo shared > "$INSTALL/store/.dashboard-token"
( cd "$T" && CLAUDE_CONFIG_DIR="$INSTALL/agents/a/notes" bash "$W" GET /api/agents >/dev/null 2>&1 )
check "an agent directory that is not a config dir names nobody: no request" test ! -e "$T/calls"
( cd "$T" && CLAUDE_CONFIG_DIR="$T/other/agents/a/.claude-config" bash "$W" GET /api/agents >/dev/null 2>&1 )
check "another install's config dir names nobody: no request" test ! -e "$T/calls"
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo own-m > "$INSTALL/.agent-token"
( cd "$INSTALL" && CLAUDE_CONFIG_DIR="$INSTALL/agents/a/.claude-config" bash "$W" GET /api/agents >/dev/null 2>&1 )
check "the working directory still wins over the config dir" grep -q 'Bearer own-m' "$T/stdin"

# 9 explicit token file
reset; echo explicit > "$T/tok"; echo shared > "$INSTALL/store/.dashboard-token"
MARVEEN_AGENT_TOKEN_FILE="$T/tok" bash "$W" --agent a GET /api/agents >/dev/null 2>&1
check "MARVEEN_AGENT_TOKEN_FILE: used" grep -q 'Bearer explicit' "$T/stdin"

# 10 bodies
reset; echo own-a > "$INSTALL/agents/a/.agent-token"
bash "$W" --agent a POST /api/memories '{"a":1}' >/dev/null 2>&1
check "inline body: sent from a file, not argv" bash -c "grep -qx '{\"a\":1}' '$T/body' && ! grep -q '\"a\":1' '$T/argv'"
printf '{"s":2}' | bash "$W" --agent a POST /api/memories - >/dev/null 2>&1
check "stdin body" grep -qx '{"s":2}' "$T/body"
printf '{"f":3}' > "$T/payload.json"
bash "$W" --agent a POST /api/memories "@$T/payload.json" >/dev/null 2>&1
check "@file body" grep -qx '{"f":3}' "$T/body"

# 11 usage errors
bash "$W" --agent a FETCH /api/x >/dev/null 2>&1; check "bad method: exit 2" test $? -eq 2
bash "$W" --agent a GET /x >/dev/null 2>&1; check "bad path: exit 2" test $? -eq 2
bash "$W" --token nope GET /api/x >/dev/null 2>&1; check "bad --token: exit 2" test $? -eq 2

# 11b max-time (these need a token to get as far as curl)
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; export MARVEEN_AGENT_ID=a
bash "$W" --max-time 5 GET /api/x >/dev/null 2>&1
check "--max-time passed to curl" grep -qx -- '--max-time' "$T/argv"
bash "$W" --max-time abc GET /api/x >/dev/null 2>&1; check "bad --max-time: exit 2" test $? -eq 2

# 11c with-status
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; OUT="$(bash "$W" --with-status GET /api/x 2>/dev/null)"
check "--with-status: body then status line" test "$OUT" = "$(printf '{"ok":true}\n200')"
OUT="$(STUB_CODE=201 bash "$W" --with-status POST /api/x '{}' 2>/dev/null)"
check "--with-status: the exact 2xx code is reported" test "${OUT##*$'\n'}" = 201

# 12 base url
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; DASHBOARD_BASE_URL=http://example.invalid:9 bash "$W" GET /api/x >/dev/null 2>&1
check "DASHBOARD_BASE_URL honoured" grep -qx 'http://example.invalid:9/api/x' "$T/argv"
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; WEB_PORT=4999 bash "$W" GET /api/x >/dev/null 2>&1
check "WEB_PORT honoured" grep -qx 'http://localhost:4999/api/x' "$T/argv"

# 13 X-Caller-Config: the agent the session was launched as, from CLAUDE_CONFIG_DIR, sent whatever the wrapper
# resolves as the acting agent. A measurement signal only: the token, the exit code and the acting agent stay
# exactly what the cwd / --token rules gave before. A stderr warning when the acting agent came from the install
# root or from --token main and is not the launched agent.
mkdir -p "$T/scratch" "$INSTALL/agents/a/.claude-config" "$INSTALL/.channels-config"
matrix() { # matrix NAME CWD CONFIG KIND EXPECT_TOKEN EXPECT_HEADER(a|m|none) EXPECT_WARN(yes|no)
  local name="$1" cwd="$2" cfg="$3" kind="$4" tok="$5" hdr="$6" warn="$7"
  reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo own-m > "$INSTALL/.agent-token"
  local err rc; unset MARVEEN_AGENT_ID MARVEEN_AGENT_TOKEN_FILE
  if [ -n "$cfg" ]; then export CLAUDE_CONFIG_DIR="$cfg"; else unset CLAUDE_CONFIG_DIR; fi
  err="$(cd "$cwd" && bash "$W" --token "$kind" GET /api/x 2>&1 >/dev/null)"; rc=$?
  unset CLAUDE_CONFIG_DIR
  check "$name: exit 0" test "$rc" -eq 0
  check "$name: token $tok" grep -q "Bearer own-$tok" "$T/stdin"
  if [ "$hdr" = none ]; then check "$name: no X-Caller-Config" bash -c "! grep -q 'X-Caller-Config' '$T/argv'"
  else check "$name: X-Caller-Config: $hdr" grep -qx "X-Caller-Config: $hdr" "$T/argv"; fi
  if [ "$warn" = yes ]; then check "$name: warns" bash -c "echo \"\$1\" | grep -q 'warning: acting as'" _ "$err"
  else check "$name: no warning" bash -c "! echo \"\$1\" | grep -q 'warning'" _ "$err"; fi
}
CFG_A="$INSTALL/agents/a/.claude-config"; CFG_M="$INSTALL/.channels-config"
#      name                               cwd                 config   kind   token header warn
matrix "root cwd, sub-agent config"       "$INSTALL"          "$CFG_A" agent  m     a      yes
matrix "root cwd, main config"            "$INSTALL"          "$CFG_M" agent  m     m      no
matrix "root cwd, no config"              "$INSTALL"          ""       agent  m     none   no
matrix "agent cwd, sub-agent config"      "$INSTALL/agents/a" "$CFG_A" agent  a     a      no
matrix "agent cwd, main config"           "$INSTALL/agents/a" "$CFG_M" agent  a     m      no
matrix "scratch cwd, sub-agent config"    "$T/scratch"        "$CFG_A" agent  a     a      no
matrix "scratch cwd, main config"         "$T/scratch"        "$CFG_M" agent  m     m      no
matrix "--token main, sub-agent config"   "$T/scratch"        "$CFG_A" main   m     a      yes
matrix "--token main, main config"        "$T/scratch"        "$CFG_M" main   m     m      no
matrix "--token main, no config"          "$T/scratch"        ""       main   m     none   no
# negative control: a sub-agent config with the install root as cwd must never be given a token it did not have
# before (it was the main agent's, and still is: this change only reports it).
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo own-m > "$INSTALL/.agent-token"
OUT="$(cd "$INSTALL" && CLAUDE_CONFIG_DIR="$CFG_A" bash "$W" --agent a GET /api/x 2>&1 >/dev/null)"
check "explicit --agent with a sub-agent config: own token, no warning" bash -c "grep -q 'Bearer own-a' '$T/stdin' && ! echo \"\$1\" | grep -q warning" _ "$OUT"

# 14 a hostile config directory (the variable is the caller's own text): the agent segment is dropped whole, so no
# extra header line, no raw control character on stderr, no header and no warning at all. The call itself goes out
# as it would without a config directory (here: the main agent, from the install root).
hostile() { # hostile NAME SEGMENT
  local name="$1" seg="$2" err
  reset; echo own-m > "$INSTALL/.agent-token"
  err="$(cd "$INSTALL" && CLAUDE_CONFIG_DIR="$INSTALL/agents/$seg/.claude-config" bash "$W" GET /api/x 2>&1 >/dev/null)"
  check "hostile config ($name): the call still goes out on the main agent's token" grep -q 'Bearer own-m' "$T/stdin"
  check "hostile config ($name): no X-Caller-Config header" bash -c "! grep -q 'X-Caller-Config' '$T/argv'"
  check "hostile config ($name): no injected header line" bash -c "! grep -qi 'X-Evil' '$T/argv'"
  check "hostile config ($name): nothing raw on stderr" bash -c "[ -z \"\$1\" ]" _ "$err"
}
hostile "CRLF" "$(printf 'a\r\nX-Evil: 1')"
hostile "LF" "$(printf 'a\nX-Evil: 1')"
hostile "colon" "a: b"
hostile "TAB and ESC" "$(printf 'a\t\033[31m')"
hostile "3000 characters" "$(printf 'a%.0s' $(seq 1 3000))"
hostile "65 characters" "$(printf 'a%.0s' $(seq 1 65))"
# the acting agent printed in the warning is filtered too (here the main agent id itself carries an escape sequence)
reset; echo own-m > "$INSTALL/.agent-token"
err="$(cd "$INSTALL" && MAIN_AGENT_ID="$(printf 'm\033[31m')" CLAUDE_CONFIG_DIR="$CFG_A" bash "$W" GET /api/x 2>&1 >/dev/null)"; rc=$?
check "a main agent id with an escape sequence: no request, no raw control character on stderr" bash -c "[ \"\$1\" -eq 3 ] && [ ! -e '$T/calls' ] && ! printf '%s' \"\$2\" | grep -q \$'\\033'" _ "$rc" "$err"

# 15 the acting agent (the X-Agent-Id header and the token path) takes the same allowlist, whichever way it was named:
# --agent, MARVEEN_AGENT_ID, the working directory, the config directory, --token main. A value that fails it ends
# in the "no token for an unknown agent" exit (3), no request made, nothing raw on stderr.
hostile_agent() { # hostile_agent NAME VALUE HOW(flag|env|cwd|main)
  local name="$1" val="$2" how="$3" err rc
  reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo own-m > "$INSTALL/.agent-token"
  # the hostile id has a token of its own, so only the filter (not a missing token file) can end the call
  mkdir -p "$INSTALL/agents/$val" && echo own-x > "$INSTALL/agents/$val/.agent-token"
  case "$how" in
    flag) err="$(cd "$T/scratch" && bash "$W" --agent "$val" GET /api/x 2>&1 >/dev/null)"; rc=$? ;;
    env)  err="$(cd "$T/scratch" && MARVEEN_AGENT_ID="$val" bash "$W" GET /api/x 2>&1 >/dev/null)"; rc=$? ;;
    cwd)  mkdir -p "$INSTALL/agents/$val"; err="$(cd "$INSTALL/agents/$val" && bash "$W" GET /api/x 2>&1 >/dev/null)"; rc=$? ;;
    main) err="$(cd "$T/scratch" && MAIN_AGENT_ID="$val" bash "$W" --token main GET /api/x 2>&1 >/dev/null)"; rc=$? ;;
  esac
  check "hostile acting agent ($name, $how): exit 3 and no request" bash -c "[ \"\$1\" -eq 3 ] && [ ! -e '$T/calls' ]" _ "$rc"
  check "hostile acting agent ($name, $how): no raw control character on stderr" bash -c "! printf '%s' \"\$1\" | grep -q \$'[\\001-\\037]'" _ "$err"
}
for how in flag env cwd main; do
  hostile_agent "CRLF" "$(printf 'a\r\nX-Evil: 1')" "$how"
  hostile_agent "colon" "a: b" "$how"
  hostile_agent "ESC" "$(printf 'a\033[31m')" "$how"
  hostile_agent "65 characters" "$(printf 'a%.0s' $(seq 1 65))" "$how"
done
# a plain id still works through every door (here: the flag and the working directory)
reset; echo own-a > "$INSTALL/agents/a/.agent-token"
(cd "$T/scratch" && bash "$W" --agent a GET /api/x >/dev/null 2>&1)
check "a plain --agent id still sends X-Agent-Id" grep -qx "X-Agent-Id: a" "$T/argv"
# the allowlist keeps a plain id of the longest allowed length, and the id the fleet really uses
reset; echo own-m > "$INSTALL/.agent-token"; LONG="$(printf 'a%.0s' $(seq 1 64))"
(cd "$INSTALL" && CLAUDE_CONFIG_DIR="$INSTALL/agents/$LONG/.claude-config" bash "$W" GET /api/x >/dev/null 2>&1)
check "a 64 character id is still sent" grep -qx "X-Caller-Config: $LONG" "$T/argv"
reset; echo own-m > "$INSTALL/.agent-token"
(cd "$INSTALL" && CLAUDE_CONFIG_DIR="$INSTALL/agents/agent-b_2/.claude-config" bash "$W" GET /api/x >/dev/null 2>&1)
check "an id with a hyphen, an underscore and a digit is still sent" grep -qx "X-Caller-Config: agent-b_2" "$T/argv"

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
