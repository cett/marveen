#!/bin/bash
# Tests for the post-checkout hook that scripts/install-prod-tree-guard-hook.sh installs on the MAIN checkout.
# Run: bash scripts/__tests__/prod-tree-guard-hook.test.sh
#
# The alert about a branch switch on the live tree goes to the install's own main agent (MAIN_AGENT_ID of the .env of
# the guarded tree, read when the alert is sent) through the API wrapper, as WHOEVER RAN THE CHECKOUT: the wrapper's
# own identity, no `--token main`, no `from` in the body (the server takes it from a fleet-agent token), and a retry
# naming the main agent when the server insists on a sender (the main agent's token). A failed send is reported on
# stderr, never swallowed. Not as a fixed "marveen" (an unknown recipient is rejected by the API), and not with curl
# and the dashboard token file. Here the installer runs in a throw-away git repo, with a stub wrapper that records its
# arguments and the request body, so nothing real is contacted; a second part runs the REAL wrapper with a fake curl.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="${PROD_GUARD_INSTALLER:-$SRC_DIR/install-prod-tree-guard-hook.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

# make_tree <name> <env-content|NOENV> <wrapper: yes|no>: a repo on branch develop with the guard installed
make_tree() {
  local name="$1" envc="$2" wrapper="$3"
  mkdir -p "$TMP/$name/scripts"
  ROOT="$(cd "$TMP/$name" && pwd -P)"
  cp "$INSTALLER" "$ROOT/scripts/install-prod-tree-guard-hook.sh"
  if [ "$wrapper" = "yes" ]; then
    # records the arguments and, for a `-` body argument, the body from stdin
    cat > "$ROOT/scripts/agent-api.sh" <<'EOF'
#!/bin/sh
D="$(dirname "$0")/.."
echo "$*" >> "$D/wrapper-args.log"
echo "CFG=${CLAUDE_CONFIG_DIR-unset}" >> "$D/wrapper-env.log"
for a in "$@"; do if [ "$a" = "-" ]; then cat > "$D/wrapper-body.log"; cat "$D/wrapper-body.log" >> "$D/wrapper-bodies.log"; echo >> "$D/wrapper-bodies.log"; fi; done
# stub-mode: need-from = answer HTTP 400 (exit 22) to a body without "from" (what the server does for the main
# agent's token); no-token = the wrapper's "no readable own token" (exit 3)
case "$(cat "$D/stub-mode" 2>/dev/null)" in
  need-from) grep -q '"from"' "$D/wrapper-body.log" || { echo "agent-api: HTTP 400 (POST /api/messages)" >&2; exit 22; } ;;
  no-token) echo "agent-api: no readable own token (/x/.agent-token) for sub-a; the operator issues it with: npm run agent-tokens -- issue sub-a" >&2; exit 3 ;;
esac
exit 0
EOF
    chmod +x "$ROOT/scripts/agent-api.sh"
  fi
  [ "$envc" = "NOENV" ] || printf '%s\n' "$envc" > "$ROOT/.env"
  git -C "$ROOT" init -q -b develop
  echo base > "$ROOT/file.txt"
  git -C "$ROOT" add file.txt
  git -C "$ROOT" commit -q -m base
  INSTALL_OUT="$(bash "$ROOT/scripts/install-prod-tree-guard-hook.sh" 2>&1)" || fail "the installer failed in $name: $INSTALL_OUT"
}

# switch <root>: a branch switch on the main checkout (the hook alerts and reverts)
switch() { (cd "$1" && git checkout -q -b feature 2>/dev/null); }
field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1/wrapper-body.log" 2>/dev/null | head -1; }

echo "the alert goes to the main agent of the guarded tree, as the caller"
make_tree a "MAIN_AGENT_ID=mainbot" yes
switch "$ROOT"
assert_eq "the body names no sender (the server takes it from the token)" "" "$(field "$ROOT" from)"
assert_eq "the default recipient is MAIN_AGENT_ID of the .env" "mainbot" "$(field "$ROOT" to)"
if grep -q -- "--token\|--agent" "$ROOT/wrapper-args.log" 2>/dev/null; then fail "the wrapper was told whose identity to use ($(cat "$ROOT/wrapper-args.log"))"; else pass "no --token / --agent: the wrapper uses the caller's own identity"; fi
assert_eq "one request when the server accepts it" "1" "$(wc -l < "$ROOT/wrapper-bodies.log" | tr -d ' ')"
if grep -q "POST /api/messages" "$ROOT/wrapper-args.log" 2>/dev/null; then pass "it posts to /api/messages"; else fail "no POST /api/messages"; fi
if grep -q "Fa: $ROOT" "$ROOT/wrapper-body.log" 2>/dev/null; then pass "the alert names the tree it fired in"; else fail "tree not named in the alert"; fi
assert_eq "the clean tree is auto-reverted to develop" "develop" "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

echo "fallbacks"
make_tree b NOENV yes
switch "$ROOT"
assert_eq "no .env: the stock id marveen" "marveen" "$(field "$ROOT" to)"
make_tree c "OTHER=1" yes
switch "$ROOT"
assert_eq ".env without MAIN_AGENT_ID: marveen" "marveen" "$(field "$ROOT" to)"
make_tree d 'MAIN_AGENT_ID=bad;"id$(x)' yes
switch "$ROOT"
assert_eq "an id with shell or JSON characters is stripped to its safe part" "badidx" "$(field "$ROOT" to)"
make_tree e "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && MARVEEN_GUARD_ALERT_TO=someone git checkout -q -b feature 2>/dev/null)
assert_eq "MARVEEN_GUARD_ALERT_TO still overrides the recipient" "someone" "$(field "$ROOT" to)"
make_tree e2 "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && MARVEEN_GUARD_ALERT_TO='some.one"x' git checkout -q -b feature 2>/dev/null)
assert_eq "...filtered to a safe id like MAIN_AGENT_ID (it goes into hand-built JSON)" "someonex" "$(field "$ROOT" to)"
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$ROOT/wrapper-body.log" 2>/dev/null; then pass "...and the body is valid JSON"; else fail "invalid JSON: $(cat "$ROOT/wrapper-body.log")"; fi

echo "the server insists on a sender (the main agent's token): one retry naming the main agent"
make_tree r "MAIN_AGENT_ID=mainbot" yes
echo need-from > "$ROOT/stub-mode"
HOOK_ERR="$(cd "$ROOT" && git checkout -q -b feature 2>&1)"
assert_eq "two requests" "2" "$(wc -l < "$ROOT/wrapper-bodies.log" | tr -d ' ')"
assert_eq "the retry names the main agent as sender" "mainbot" "$(field "$ROOT" from)"
assert_eq "nothing is reported as failed when the retry went through" "" "$HOOK_ERR"

echo "a failed send is reported, never swallowed, and never fails the checkout"
make_tree s "MAIN_AGENT_ID=mainbot" yes
echo no-token > "$ROOT/stub-mode"
HOOK_ERR="$(cd "$ROOT" && git checkout -q -b feature 2>&1)"; rc=$?
assert_eq "the checkout succeeds" "0" "$rc"
case "$HOOK_ERR" in *"alert was NOT sent (agent-api exit 3)"*"no readable own token"*) pass "a local error line names the exit code and the wrapper's reason" ;; *) fail "no local error line: '$HOOK_ERR'" ;; esac
assert_eq "no retry on exit 3" "1" "$(wc -l < "$ROOT/wrapper-bodies.log" | tr -d ' ')"
assert_eq "the tree was still auto-reverted" "develop" "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

echo "the REAL wrapper and a fake curl: a sub-agent session under AGENT_API_STRICT=1, and the main agent"
# The fake curl plays the server: a request on the MAIN agent's token needs a sender in the body (HTTP 400 without,
# as the real server answers), a request on a sub-agent's token is accepted without one. It records every call.
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/curl" <<'FAKE'
#!/bin/bash
cfg=""; body=""; prev=""
for a in "$@"; do
  if [ "$a" = "-K" ]; then cfg="$(cat)"; fi
  case "$prev" in --data-binary) body="$(cat "${a#@}" 2>/dev/null)" ;; esac
  prev="$a"
done
echo "$cfg" >> "$FAKE_REC.cfg"; echo "$body" >> "$FAKE_REC.bodies"; printf '%s\n' "$@" >> "$FAKE_REC.argv"; echo x >> "$FAKE_REC.calls"
case "$cfg" in
  *main-fixture-token*) case "$body" in *'"from"'*) printf '{}\n200' ;; *) printf '{"error":"required"}\n400' ;; esac ;;
  *) printf '{}\n200' ;;
esac
FAKE
chmod +x "$FAKEBIN/curl"
# real_tree <name>: a tree with the real wrapper and a token file for the main agent and for sub-a
real_tree() {
  make_tree "$1" "MAIN_AGENT_ID=mainbot" no
  cp "$SRC_DIR/agent-api.sh" "$ROOT/scripts/agent-api.sh"
  mkdir -p "$ROOT/agents/sub-a"
  echo main-fixture-token > "$ROOT/.agent-token"; echo sub-fixture-token > "$ROOT/agents/sub-a/.agent-token"
  REC="$TMP/rec-$1"
}

real_tree i
(cd "$ROOT" && env CLAUDE_CONFIG_DIR="$ROOT/agents/sub-a/.claude-config" AGENT_API_STRICT=1 MAIN_AGENT_ID=mainbot PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" git checkout -q -b feature 2>"$TMP/i.err")
assert_eq "STRICT=1, sub-agent session: exactly one request went out" "1" "$(wc -l < "$REC.calls" 2>/dev/null | tr -d ' ')"
if grep -q 'sub-fixture-token' "$REC.cfg" 2>/dev/null; then pass "it carried the sub-agent's own token"; else fail "the sub-agent's token is missing from the request"; fi
if grep -q 'main-fixture-token' "$REC.cfg" 2>/dev/null; then fail "the main agent's token was used by a sub-agent session"; else pass "the main agent's token was not used"; fi
if grep -q '"from"' "$REC.bodies" 2>/dev/null; then fail "the body names a sender: $(cat "$REC.bodies")"; else pass "the body names no sender"; fi
if grep -q '"to":"mainbot"' "$REC.bodies" 2>/dev/null; then pass "it is addressed to the main agent"; else fail "wrong recipient: $(cat "$REC.bodies" 2>/dev/null)"; fi
assert_eq "nothing was reported as failed" "" "$(cat "$TMP/i.err")"
# control: the main agent's token from that session IS refused (E1), so reverting the hook to --token main would fail the checks above
(cd "$ROOT" && env CLAUDE_CONFIG_DIR="$ROOT/agents/sub-a/.claude-config" AGENT_API_STRICT=1 MAIN_AGENT_ID=mainbot PATH="$FAKEBIN:$PATH" FAKE_REC="$TMP/rec-ctl" bash scripts/agent-api.sh --token main GET /api/x >/dev/null 2>"$TMP/ctl.err"); ctl_rc=$?
assert_eq "control: --token main from that session is refused (exit 3)" "3" "$ctl_rc"
if grep -q 'refused (E1)' "$TMP/ctl.err"; then pass "control: the refusal is rule E1"; else fail "control: no E1 text ($(cat "$TMP/ctl.err"))"; fi

# the main agent's own session (or a terminal in the prod tree): the cwd names the main agent, its token needs a sender
real_tree k
(cd "$ROOT" && env -u CLAUDE_CONFIG_DIR AGENT_API_STRICT=1 MAIN_AGENT_ID=mainbot PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" git checkout -q -b feature 2>"$TMP/k.err")
assert_eq "main agent: two requests (without a sender, then with one)" "2" "$(wc -l < "$REC.calls" 2>/dev/null | tr -d ' ')"
if grep -q '"from":"mainbot"' "$REC.bodies" 2>/dev/null; then pass "the retry names the main agent"; else fail "no sender in the retry: $(cat "$REC.bodies" 2>/dev/null)"; fi
assert_eq "main agent: nothing was reported as failed" "" "$(cat "$TMP/k.err")"

# a sub-agent without a token file: a local error line, the checkout goes on
real_tree m
rm -f "$ROOT/agents/sub-a/.agent-token"
(cd "$ROOT" && env CLAUDE_CONFIG_DIR="$ROOT/agents/sub-a/.claude-config" AGENT_API_STRICT=1 MAIN_AGENT_ID=mainbot PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" git checkout -q -b feature 2>"$TMP/m.err"); rc=$?
assert_eq "no token file: the checkout still succeeds" "0" "$rc"
assert_eq "no token file: no request was made" "" "$(cat "$REC.calls" 2>/dev/null)"
case "$(cat "$TMP/m.err")" in *"alert was NOT sent (agent-api exit 3)"*"no readable own token"*) pass "no token file: a local error line says why" ;; *) fail "no token file: '$(cat "$TMP/m.err")'" ;; esac

echo "a branch name that would break the hand-built JSON body"
make_tree j "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && git checkout -q -b 'fe"at"ure' 2>/dev/null)
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["to"]=="mainbot" and "PROD-FA" in d["content"]' "$ROOT/wrapper-body.log" 2>/dev/null; then pass "the body is valid JSON with a double quote in the branch name"; else fail "body is not valid JSON: $(cat "$ROOT/wrapper-body.log" 2>/dev/null)"; fi

echo "no wrapper, no alert; the checkout is never failed"
make_tree f "MAIN_AGENT_ID=mainbot" no
(cd "$ROOT" && git checkout -q -b feature 2>/dev/null); rc=$?
assert_eq "the checkout succeeds without the wrapper" "0" "$rc"
if [ -e "$ROOT/wrapper-body.log" ]; then fail "an alert was sent without a wrapper"; else pass "no alert without a wrapper"; fi

echo "the installed hook no longer carries the old direct call"
HOOK="$(cd "$ROOT" && git rev-parse --git-common-dir)/hooks/post-checkout"
case "$HOOK" in /*) ;; *) HOOK="$ROOT/$HOOK" ;; esac
if grep -q "dashboard-token\|curl" "$HOOK"; then fail "the hook still reads the token file or calls curl"; else pass "no token file, no curl in the hook"; fi
if grep -q 'MAIN_AGENT_ID' "$HOOK"; then pass "the hook reads MAIN_AGENT_ID"; else fail "the hook does not read MAIN_AGENT_ID"; fi
# a re-install replaces an old (curl + token file) copy that carries the marker
printf '#!/bin/sh\n# marveen-prod-tree-guard : old\nTOKEN_FILE="$PROD_ROOT/store/.dashboard-token"\ncurl -s http://x\n' > "$HOOK"
bash "$ROOT/scripts/install-prod-tree-guard-hook.sh" >/dev/null 2>&1
if grep -q "dashboard-token\|curl" "$HOOK"; then fail "a re-install did not replace the old hook"; else pass "a re-install replaces the old hook"; fi
if ls "$(dirname "$HOOK")" | grep -q 'post-checkout.pre-prod-guard.bak'; then fail "our own old copy was backed up as a .bak"; else pass "our own old copy leaves no .bak"; fi

echo "doctor: drift check of the installed hook against the installer"
# The doctor is one long script that talks to launchd and the dashboard, so only its prod-tree-guard section runs
# here, cut out between its own heading and the next one, in the fixture checkout.
DOCTOR_SECTION="$TMP/doctor-ptg-section.sh"
awk '/^# --- Prod-tree guard hook/{f=1; next} /^# --- /{f=0} f' "$SRC_DIR/doctor.sh" > "$DOCTOR_SECTION"
if [ -s "$DOCTOR_SECTION" ]; then pass "the prod-tree guard section is found in doctor.sh"; else fail "the prod-tree guard section is missing from doctor.sh"; fi
run_doctor() { DOC_OUT="$(cd "$1" && BOLD="" RESET=""; ok() { echo "OK $1"; }; warn() { echo "WARN $1"; }; fail() { echo "FAIL $1"; }; . "$DOCTOR_SECTION" 2>&1)"; }
make_tree g "MAIN_AGENT_ID=mainbot" yes
run_doctor "$ROOT"
case "$DOC_OUT" in *"OK prod-tree guard: post-checkout hook matches the installer"*) pass "a freshly installed hook is OK" ;; *) fail "fresh install: $DOC_OUT" ;; esac
G_HOOK="$ROOT/.git/hooks/post-checkout"
printf '#!/bin/sh\n# marveen-prod-tree-guard : old\nTOKEN_FILE="$PROD_ROOT/store/.dashboard-token"\ncurl -s http://x\n' > "$G_HOOK"
run_doctor "$ROOT"
case "$DOC_OUT" in *"WARN"*"OLD version"*"install-prod-tree-guard-hook.sh"*) pass "the old curl + token-file hook is a WARN naming the fix" ;; *) fail "old hook: $DOC_OUT" ;; esac
printf '#!/bin/sh\n# marveen-prod-tree-guard : something else\nexit 0\n' > "$G_HOOK"
run_doctor "$ROOT"
case "$DOC_OUT" in *"WARN"*"differs from the installer"*) pass "any other difference is a drift WARN" ;; *) fail "drift: $DOC_OUT" ;; esac
mv "$G_HOOK" "$G_HOOK.moved"
run_doctor "$ROOT"
case "$DOC_OUT" in *"WARN"*"NOT installed"*) pass "a missing hook is a WARN" ;; *) fail "missing hook: $DOC_OUT" ;; esac

echo "doctor: stale global hook copies (content drift, not name equality)"
STALE_SECTION="$TMP/doctor-stale-section.sh"
awk '/^# --- Stale global hook copies/{f=1; next} /^# --- /{f=0} f' "$SRC_DIR/doctor.sh" > "$STALE_SECTION"
if [ -s "$STALE_SECTION" ]; then pass "the stale-copy section is found in doctor.sh"; else fail "the stale-copy section is missing from doctor.sh"; fi
# run_stale <name> <global-dir: yes|no>: a fake checkout with two repo hooks and a fake HOME
run_stale() {
  local name="$1" has_global="$2" dir="$TMP/stale-$1"
  mkdir -p "$dir/scripts/hooks" "$dir/home"
  printf 'repo version A\n' > "$dir/scripts/hooks/synced.py"
  printf 'repo version B\n' > "$dir/scripts/hooks/drifted.py"
  [ "$has_global" = "yes" ] && mkdir -p "$dir/home/.claude/hooks"
  STALE_DIR="$dir"
}
exec_stale() { DOC_OUT="$(cd "$STALE_DIR" && HOME="$STALE_DIR/home"; ok() { echo "OK $1"; }; warn() { echo "WARN $1"; }; fail() { echo "FAIL $1"; }; . "$STALE_SECTION" 2>&1)"; }
run_stale s1 yes
cp "$STALE_DIR/scripts/hooks/synced.py" "$STALE_DIR/home/.claude/hooks/synced.py"
exec_stale
case "$DOC_OUT" in OK*"no global hook copy has drifted"*) pass "an identical synced copy is not a finding" ;; *) fail "identical copy: $DOC_OUT" ;; esac
run_stale s2 yes
cp "$STALE_DIR/scripts/hooks/synced.py" "$STALE_DIR/home/.claude/hooks/synced.py"
printf 'OLD version\n' > "$STALE_DIR/home/.claude/hooks/drifted.py"
exec_stale
case "$DOC_OUT" in *"FAIL stale global copy: "*"drifted.py has drifted from scripts/hooks/drifted.py"*) pass "a same-name copy with other content is a FAIL naming both files" ;; *) fail "drifted copy: $DOC_OUT" ;; esac
case "$DOC_OUT" in *"synced.py"*) fail "the identical copy was reported too: $DOC_OUT" ;; *) pass "only the drifted copy is reported" ;; esac
case "$DOC_OUT" in *"OK no global hook copy"*) fail "OK printed next to a FAIL: $DOC_OUT" ;; *) pass "no OK line next to a finding" ;; esac
run_stale s3 yes
printf 'unrelated\n' > "$STALE_DIR/home/.claude/hooks/only-global.py"
exec_stale
case "$DOC_OUT" in OK*) pass "a global file without a repo counterpart is ignored" ;; *) fail "global-only file: $DOC_OUT" ;; esac
run_stale s4 no
exec_stale
assert_eq "no ~/.claude/hooks directory: nothing printed" "" "$DOC_OUT"
run_stale s5 yes
printf 'repo version A \n' > "$STALE_DIR/home/.claude/hooks/synced.py"
exec_stale
case "$DOC_OUT" in *"FAIL stale global copy"*"synced.py"*) pass "a one-byte difference is drift" ;; *) fail "one-byte drift: $DOC_OUT" ;; esac

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
