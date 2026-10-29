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
check "the session config dir beats the working directory: the sub-agent stays itself at the install root" grep -q 'Bearer own-a' "$T/stdin"

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
# resolves as the acting agent (a measurement signal only). Resolution: --agent / MARVEEN_AGENT_ID > the config
# dir > the cwd. A stderr warning when the cwd names somebody else than the session does, or (AGENT_API_STRICT=0)
# when a sub-agent session asks for the main agent through --token main.
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
  if [ "$warn" = yes ]; then check "$name: warns" bash -c "echo \"\$1\" | grep -q 'warning:'" _ "$err"
  else check "$name: no warning" bash -c "! echo \"\$1\" | grep -q 'warning'" _ "$err"; fi
}
CFG_A="$INSTALL/agents/a/.claude-config"; CFG_M="$INSTALL/.channels-config"
#      name                               cwd                 config   kind   token header warn
matrix "root cwd, sub-agent config"       "$INSTALL"          "$CFG_A" agent  a     a      yes
matrix "root cwd, main config"            "$INSTALL"          "$CFG_M" agent  m     m      no
matrix "root cwd, no config"              "$INSTALL"          ""       agent  m     none   no
matrix "agent cwd, sub-agent config"      "$INSTALL/agents/a" "$CFG_A" agent  a     a      no
matrix "agent cwd, main config"           "$INSTALL/agents/a" "$CFG_M" agent  m     m      yes
matrix "scratch cwd, sub-agent config"    "$T/scratch"        "$CFG_A" agent  a     a      no
matrix "scratch cwd, main config"         "$T/scratch"        "$CFG_M" agent  m     m      no
matrix "--token main, sub-agent config"   "$T/scratch"        "$CFG_A" main   m     a      yes
matrix "--token main, main config"        "$T/scratch"        "$CFG_M" main   m     m      no
matrix "--token main, no config"          "$T/scratch"        ""       main   m     none   no
# negative control: a sub-agent config with the install root as cwd is given its OWN token, never the main agent's.
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
mkdir -p "$INSTALL/agents/$LONG" "$INSTALL/agents/agent-b_2"; echo own-l > "$INSTALL/agents/$LONG/.agent-token"; echo own-x > "$INSTALL/agents/agent-b_2/.agent-token"
(cd "$INSTALL" && CLAUDE_CONFIG_DIR="$INSTALL/agents/$LONG/.claude-config" bash "$W" GET /api/x >/dev/null 2>&1)
check "a 64 character id is still sent" grep -qx "X-Caller-Config: $LONG" "$T/argv"
reset; echo own-x > "$INSTALL/agents/agent-b_2/.agent-token"
(cd "$INSTALL" && CLAUDE_CONFIG_DIR="$INSTALL/agents/agent-b_2/.claude-config" bash "$W" GET /api/x >/dev/null 2>&1)
check "an id with a hyphen, an underscore and a digit is still sent" grep -qx "X-Caller-Config: agent-b_2" "$T/argv"

# 16 AGENT_API_STRICT: what a session launched as a sub-agent may not ask for (E1 main/admin, E2 operator, E3 another
# agent). Exit 3 and NO request with 1; with 0 (the default) the request goes out as before and stderr says it would
# be refused. A session with no sub-agent identity (a system script, cron, the main agent) is never touched.
mkdir -p "$INSTALL/agents/b/.claude-config" "$T/other"
CFG_B="$INSTALL/agents/b/.claude-config"
strict() { # strict NAME STRICT CWD CONFIG ARGS... -> sets RC, ERR; the caller checks
  local name="$1" st="$2" cwd="$3" cfg="$4"; shift 4
  reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo own-b > "$INSTALL/agents/b/.agent-token"; echo own-m > "$INSTALL/.agent-token"; echo op > "$INSTALL/store/.operator-token"
  unset MARVEEN_AGENT_ID MARVEEN_AGENT_TOKEN_FILE
  if [ -n "$cfg" ]; then export CLAUDE_CONFIG_DIR="$cfg"; else unset CLAUDE_CONFIG_DIR; fi
  if [ -n "$st" ]; then export AGENT_API_STRICT="$st"; else unset AGENT_API_STRICT; fi
  ERR="$(cd "$cwd" && bash "$W" "$@" GET /api/x 2>&1 >/dev/null)"; RC=$?
  unset CLAUDE_CONFIG_DIR AGENT_API_STRICT
}
refused() { # refused NAME RULE: exit 3, no request, the rule named on stderr
  check "$1: exit 3 ($2)" test "$RC" -eq 3
  check "$1: no request made" test ! -e "$T/calls"
  check "$1: stderr names $2" bash -c "echo \"\$1\" | grep -q 'refused ($2)'" _ "$ERR"
}
allowed() { # allowed NAME TOKEN(a|b|m|op): the request goes out on that token
  check "$1: exit 0" test "$RC" -eq 0
  case "$2" in op) tok="op" ;; *) tok="own-$2" ;; esac
  check "$1: token $2" grep -q "Bearer $tok" "$T/stdin"
}
would() { # would NAME RULE: the request went out, stderr says it would be refused
  check "$1: the request goes out (STRICT off)" test -e "$T/calls"
  check "$1: stderr says would be refused ($2)" bash -c "echo \"\$1\" | grep -q 'would be refused with AGENT_API_STRICT=1 ($2)'" _ "$ERR"
}
none() { check "$1: no refusal text" bash -c "! echo \"\$1\" | grep -q 'refused'" _ "$ERR"; }

# the spec matrix, STRICT=1
strict "BASE, sub-agent a, nothing" 1 "$INSTALL" "$CFG_A"; allowed "BASE, sub-agent a, nothing" a; none "BASE, sub-agent a, nothing"
check "BASE, sub-agent a, nothing: the cwd/config warning names both" bash -c "echo \"\$1\" | grep -q 'cwd names m, the session config directory names a: using a'" _ "$ERR"
strict "BASE, sub-agent a, --token main" 1 "$INSTALL" "$CFG_A" --token main; refused "BASE, sub-agent a, --token main" E1
strict "agent cwd, sub-agent a, --token admin" 1 "$INSTALL/agents/a" "$CFG_A" --token admin; refused "agent cwd, sub-agent a, --token admin" E1
strict "agent cwd, sub-agent a, --agent b" 1 "$INSTALL/agents/a" "$CFG_A" --agent b; refused "agent cwd, sub-agent a, --agent b" E3
strict "agent cwd, sub-agent a, --agent a" 1 "$INSTALL/agents/a" "$CFG_A" --agent a; allowed "agent cwd, sub-agent a, --agent a" a; none "agent cwd, sub-agent a, --agent a"
strict "scratch, sub-agent a, --token operator" 1 "$T/scratch" "$CFG_A" --token operator; refused "scratch, sub-agent a, --token operator" E2
strict "BASE, sub-agent a, --agent m" 1 "$INSTALL" "$CFG_A" --agent m; refused "BASE, sub-agent a, --agent m" E3
strict "BASE, sub-agent a, --agent m --token admin" 1 "$INSTALL" "$CFG_A" --agent m --token admin; refused "BASE, sub-agent a, --agent m --token admin" E1
strict "agent cwd b, sub-agent a, nothing" 1 "$INSTALL/agents/b" "$CFG_A"; allowed "agent cwd b, sub-agent a, nothing" a
strict "scratch, sub-agent a, nothing" 1 "$T/scratch" "$CFG_A"; allowed "scratch, sub-agent a, nothing" a
# MARVEEN_AGENT_ID naming somebody else is E3 as well
reset; echo own-b > "$INSTALL/agents/b/.agent-token"
ERR="$(cd "$T/scratch" && AGENT_API_STRICT=1 MARVEEN_AGENT_ID=b CLAUDE_CONFIG_DIR="$CFG_A" bash "$W" GET /api/x 2>&1 >/dev/null)"; RC=$?
refused "MARVEEN_AGENT_ID=b in a's session" E3
reset; echo own-a > "$INSTALL/agents/a/.agent-token"
ERR="$(cd "$T/scratch" && AGENT_API_STRICT=1 MARVEEN_AGENT_ID=a CLAUDE_CONFIG_DIR="$CFG_A" bash "$W" GET /api/x 2>&1 >/dev/null)"; RC=$?
allowed "MARVEEN_AGENT_ID=a in a's session" a
# the main agent's session: everything stays
strict "BASE, main session, nothing" 1 "$INSTALL" "$CFG_M"; allowed "BASE, main session, nothing" m; none "BASE, main session, nothing"
strict "BASE, main session, --agent a" 1 "$INSTALL" "$CFG_M" --agent a; allowed "BASE, main session, --agent a (a main-agent task)" a
strict "BASE, main session, --token admin" 1 "$INSTALL" "$CFG_M" --token admin; allowed "BASE, main session, --token admin" m
strict "BASE, main session, --token main" 1 "$INSTALL" "$CFG_M" --token main; allowed "BASE, main session, --token main" m
strict "BASE, main session, --token operator" 1 "$INSTALL" "$CFG_M" --token operator; allowed "BASE, main session, --token operator" op
# no session identity (system script, cron): today's behaviour stays, and the exception is not too wide
strict "BASE, no session, --token main" 1 "$INSTALL" "" --token main; allowed "BASE, no session, --token main (system script)" m
strict "BASE, no session, --token admin" 1 "$INSTALL" "" --token admin; allowed "BASE, no session, --token admin (system script)" m
strict "scratch, no session, --agent b" 1 "$T/scratch" "" --agent b; allowed "scratch, no session, --agent b (system script)" b
strict "BASE, no session, --token operator" 1 "$INSTALL" "" --token operator; allowed "BASE, no session, --token operator (system script)" op
strict "another install's config dir, --token main" 1 "$INSTALL" "$T/other/agents/a/.claude-config" --token main; allowed "another install's config dir names nobody: --token main passes" m
strict "scratch, no session, nothing" 1 "$T/scratch" ""; check "scratch, no session, nothing: exit 3, no request, as today" bash -c "test $RC -eq 3 && test ! -e '$T/calls'"

# STRICT=0 (the default, unset too): the same calls go out exactly as before, stderr says they would be refused
for st in 0 ""; do
  strict "STRICT=${st:-unset}: --token main" "$st" "$INSTALL" "$CFG_A" --token main; allowed "STRICT=${st:-unset}: --token main" m; would "STRICT=${st:-unset}: --token main" E1
  strict "STRICT=${st:-unset}: --token admin (--agent m)" "$st" "$INSTALL" "$CFG_A" --agent m --token admin; allowed "STRICT=${st:-unset}: --agent m --token admin" m; would "STRICT=${st:-unset}: --agent m --token admin" E1
  strict "STRICT=${st:-unset}: --token operator" "$st" "$T/scratch" "$CFG_A" --token operator; allowed "STRICT=${st:-unset}: --token operator" op; would "STRICT=${st:-unset}: --token operator" E2
  strict "STRICT=${st:-unset}: --agent b" "$st" "$INSTALL/agents/a" "$CFG_A" --agent b; allowed "STRICT=${st:-unset}: --agent b" b; would "STRICT=${st:-unset}: --agent b" E3
  strict "STRICT=${st:-unset}: own identity" "$st" "$INSTALL" "$CFG_A"; allowed "STRICT=${st:-unset}: own identity" a
  check "STRICT=${st:-unset}: own identity: no would-refuse line" bash -c "! echo \"\$1\" | grep -q 'AGENT_API_STRICT'" _ "$ERR"
done
# the --token main call still carries the launched agent in X-Caller-Config, whatever STRICT says
strict "STRICT=0 --token main header" 0 "$INSTALL" "$CFG_A" --token main
check "STRICT=0 --token main: X-Caller-Config names the launched sub-agent" grep -qx 'X-Caller-Config: a' "$T/argv"
check "STRICT=0 --token main: X-Agent-Id is the main agent (as before)" grep -qx 'X-Agent-Id: m' "$T/argv"
strict "bad AGENT_API_STRICT" yes "$INSTALL" "$CFG_A"
check "AGENT_API_STRICT=yes: usage error exit 2, no request" bash -c "test $RC -eq 2 && test ! -e '$T/calls'"

# 17 the id allowlist is byte-wise, whatever the locale: an accented letter is not in A-Za-z
for loc in C en_US.UTF-8 hu_HU.UTF-8; do
  reset; mkdir -p "$INSTALL/agents/aé"; echo own-x > "$INSTALL/agents/aé/.agent-token"
  ERR="$(cd "$T/scratch" && LC_ALL="$loc" bash "$W" --agent "aé" GET /api/x 2>&1 >/dev/null)"; RC=$?
  check "non-ASCII agent id under $loc: exit 3, no request" bash -c "test $RC -eq 3 && test ! -e '$T/calls'"
done

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
