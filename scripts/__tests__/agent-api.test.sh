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
export MAIN_AGENT_ID=m; unset MARVEEN_AGENT_ID MARVEEN_AGENT_TOKEN_FILE MARVEEN_WEB_PORT WEB_PORT
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

# 2 missing own token falls back, and says who
reset; echo shared > "$INSTALL/store/.dashboard-token"
AGENT_API_VERBOSE=1 bash "$W" --agent a GET /api/agents >"$T/out" 2>"$T/err"
check "fallback: shared token on stdin" grep -q 'Bearer shared' "$T/stdin"
check "fallback: X-Agent-Id names the caller" grep -qx 'X-Agent-Id: a' "$T/argv"
check "fallback: source is reported" grep -q 'source=shared-fallback' "$T/err"
check "fallback: shared token not in argv" bash -c "! grep -q 'shared' '$T/argv'"

# 3 empty own token file is a miss
reset; : > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent a GET /api/agents >/dev/null 2>&1
check "empty own token file: falls back" grep -q 'Bearer shared' "$T/stdin"

# 4 nothing at all: no auth config, still a request (same as a hook with no token file today)
reset
bash "$W" --agent a GET /api/agents >/dev/null 2>&1; RC=$?
check "no token anywhere: request still made, exit 0" test "$RC" -eq 0 -a "$(cat "$T/calls")" = 1
check "no token anywhere: no -K config" bash -c "! grep -qx -- '-K' '$T/argv'"

# 5 a REFUSED own token is not retried on the shared one
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
STUB_CODE=401 bash "$W" --agent a GET /api/agents >"$T/out" 2>"$T/err"; RC=$?
check "401: exit 22" test "$RC" -eq 22
check "401: exactly one request, no shared retry" test "$(cat "$T/calls")" = 1
check "401: status on stderr" grep -q 'HTTP 401' "$T/err"
check "401: body still printed" grep -q '"ok"' "$T/out"

# 6 --token shared uses the shared token even when an own token exists
reset; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent a --token shared POST /api/agents/x/restart >/dev/null 2>&1
check "--token shared: shared token sent" grep -q 'Bearer shared' "$T/stdin"
check "--token shared: still names the caller" grep -qx 'X-Agent-Id: a' "$T/argv"

# 7 operator token
reset; echo op > "$INSTALL/store/.operator-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --token operator GET /api/agents >/dev/null 2>&1
check "--token operator: operator token sent" grep -q 'Bearer op' "$T/stdin"
reset; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --token operator GET /api/agents >/dev/null 2>&1
check "--token operator: missing file falls back" grep -q 'Bearer shared' "$T/stdin"

# 7b admin kind: main agent own token, everyone else shared
reset; echo own-m > "$INSTALL/.agent-token"; echo own-a > "$INSTALL/agents/a/.agent-token"; echo shared > "$INSTALL/store/.dashboard-token"
bash "$W" --agent m --token admin POST /api/agents/x/restart >/dev/null 2>&1
check "--token admin: main agent sends its own token" grep -q 'Bearer own-m' "$T/stdin"
bash "$W" --agent a --token admin POST /api/agents/x/restart >/dev/null 2>&1
check "--token admin: any other agent sends the shared token" grep -q 'Bearer shared' "$T/stdin"

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
( cd "$T" && bash "$W" GET /api/agents >/dev/null 2>&1 )
check "unknown cwd: shared token, no caller header" bash -c "grep -q 'Bearer shared' '$T/stdin' && ! grep -q 'X-Agent-Id' '$T/argv'"

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

# 12 base url
reset; DASHBOARD_BASE_URL=http://example.invalid:9 bash "$W" GET /api/x >/dev/null 2>&1
check "DASHBOARD_BASE_URL honoured" grep -qx 'http://example.invalid:9/api/x' "$T/argv"
reset; WEB_PORT=4999 bash "$W" GET /api/x >/dev/null 2>&1
check "WEB_PORT honoured" grep -qx 'http://localhost:4999/api/x' "$T/argv"

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
