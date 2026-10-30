#!/bin/bash
# Tests for the post-checkout hook that scripts/install-prod-tree-guard-hook.sh installs on the MAIN checkout.
# Run: bash scripts/__tests__/prod-tree-guard-hook.test.sh
#
# The alert about a branch switch on the live tree is sent as the install's own main agent (MAIN_AGENT_ID of the
# .env of the guarded tree, read when the alert is sent), through the API wrapper with the main agent's token. Not
# as a fixed "marveen" (an unknown sender is rejected by the API, and the alert vanished into `|| true`), and not
# with curl and the dashboard token file. Here the installer runs in a throw-away git repo, with a stub wrapper that
# records its arguments and the request body, so nothing real is contacted.

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
echo "$*" >> "$(dirname "$0")/../wrapper-args.log"
echo "CFG=${CLAUDE_CONFIG_DIR-unset} AID=${MARVEEN_AGENT_ID-unset} TF=${MARVEEN_AGENT_TOKEN_FILE-unset}" >> "$(dirname "$0")/../wrapper-env.log"
echo "DBU=${DASHBOARD_BASE_URL-unset} SD=${MARVEEN_STORE_DIR-unset} MID=${MAIN_AGENT_ID-unset} WP=${WEB_PORT-unset}${MARVEEN_WEB_PORT-} PATH=$PATH" >> "$(dirname "$0")/../wrapper-env2.log"
for a in "$@"; do if [ "$a" = "-" ]; then cat > "$(dirname "$0")/../wrapper-body.log"; fi; done
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

echo "the alert is sent as the main agent of the guarded tree"
make_tree a "MAIN_AGENT_ID=mainbot" yes
switch "$ROOT"
assert_eq "from is MAIN_AGENT_ID of the .env" "mainbot" "$(field "$ROOT" from)"
assert_eq "the default recipient is the same main agent" "mainbot" "$(field "$ROOT" to)"
if grep -q -- "--token main" "$ROOT/wrapper-args.log" 2>/dev/null; then pass "it goes through the wrapper with the main agent token"; else fail "wrapper not called with --token main ($(cat "$ROOT/wrapper-args.log" 2>/dev/null))"; fi
if grep -q "POST /api/messages" "$ROOT/wrapper-args.log" 2>/dev/null; then pass "it posts to /api/messages"; else fail "no POST /api/messages"; fi
if grep -q "Fa: $ROOT" "$ROOT/wrapper-body.log" 2>/dev/null; then pass "the alert names the tree it fired in"; else fail "tree not named in the alert"; fi
assert_eq "the clean tree is auto-reverted to develop" "develop" "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"

echo "fallbacks"
make_tree b NOENV yes
switch "$ROOT"
assert_eq "no .env: the stock id marveen" "marveen" "$(field "$ROOT" from)"
make_tree c "OTHER=1" yes
switch "$ROOT"
assert_eq ".env without MAIN_AGENT_ID: marveen" "marveen" "$(field "$ROOT" from)"
make_tree d 'MAIN_AGENT_ID=bad;"id$(x)' yes
switch "$ROOT"
assert_eq "an id with shell or JSON characters is stripped to its safe part" "badidx" "$(field "$ROOT" from)"
make_tree e "MAIN_AGENT_ID=mainbot
MARVEEN_GUARD_ALERT_TO=some.one\"x" yes
(cd "$ROOT" && git checkout -q -b feature 2>/dev/null)
assert_eq "MARVEEN_GUARD_ALERT_TO in the .env of the tree overrides the recipient (filtered to a safe id)" "someonex" "$(field "$ROOT" to)"
make_tree e2 "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && MARVEEN_GUARD_ALERT_TO=victim git checkout -q -b feature 2>/dev/null)
assert_eq "the recipient is NOT taken from the session environment" "mainbot" "$(field "$ROOT" to)"
assert_eq "...and the sender stays the main agent" "mainbot" "$(field "$ROOT" from)"

echo "the alert from a sub-agent session (AGENT_API_STRICT=1 refuses --token main there)"
# git runs the hook inside the session that ran the checkout, so a sub-agent's launch identity is in its environment.
make_tree h "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && CLAUDE_CONFIG_DIR="$ROOT/agents/sub-a/.claude-config" MARVEEN_AGENT_ID=sub-a MARVEEN_AGENT_TOKEN_FILE="$ROOT/agents/sub-a/.agent-token" \
  git checkout -q -b feature 2>/dev/null)
assert_eq "the wrapper is called without the session's launch identity" "CFG=unset AID=unset TF=unset" "$(head -1 "$ROOT/wrapper-env.log" 2>/dev/null)"
assert_eq "...and the alert still names the main agent as sender" "mainbot" "$(field "$ROOT" from)"

# The call carries the main agent's token, so nothing the session sets may steer it: not the URL, the store, the main
# agent id, the port, nor the PATH the wrapper finds curl on.
make_tree h2 "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && DASHBOARD_BASE_URL=http://evil.invalid:9 MARVEEN_DASHBOARD_ORIGIN=http://evil.invalid:9 MARVEEN_STORE_DIR=/tmp/evil-store \
  MAIN_AGENT_ID=evil WEB_PORT=9 MARVEEN_WEB_PORT=9 PATH="/tmp/evil-bin:$PATH" git checkout -q -b feature 2>/dev/null)
assert_eq "session URL, store, main id, port and PATH do not reach the wrapper" \
  "DBU=http://localhost:3420 SD=unset MID=unset WP=unset PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" "$(head -1 "$ROOT/wrapper-env2.log" 2>/dev/null)"
make_tree h3 "MAIN_AGENT_ID=mainbot
MARVEEN_DASHBOARD_ORIGIN=http://127.0.0.1:3555" yes
(cd "$ROOT" && git checkout -q -b feature 2>/dev/null)
case "$(head -1 "$ROOT/wrapper-env2.log" 2>/dev/null)" in "DBU=http://127.0.0.1:3555 "*) pass "a loopback origin in the .env of the tree is used" ;; *) fail "loopback origin not used: $(head -1 "$ROOT/wrapper-env2.log" 2>/dev/null)" ;; esac
n=0
for bad in "http://evil.invalid" "http://localhost:80@evil.invalid" "http://localhost.evil.invalid" "https://localhost" "http://localhost:3420/x"; do
  n=$((n + 1))
  make_tree "h4-$n" "MAIN_AGENT_ID=mainbot
MARVEEN_DASHBOARD_ORIGIN=$bad" yes
  (cd "$ROOT" && git checkout -q -b feature 2>/dev/null)
  case "$(head -1 "$ROOT/wrapper-env2.log" 2>/dev/null)" in "DBU=http://localhost:3420 "*) pass "origin '$bad' from the .env is ignored" ;; *) fail "origin '$bad' was used: $(head -1 "$ROOT/wrapper-env2.log" 2>/dev/null)" ;; esac
done

# The same with the REAL wrapper and a fake curl: with the identity dropped the request goes out under the main
# agent's token (the sub-agent's token file is not read); with the identity kept the wrapper refuses (exit 3, E1),
# which is the failure the hook must not suffer.
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
# The hook runs the wrapper in a clean environment with a fixed PATH, so neither a PATH entry nor a variable can
# carry the fake curl or its record path in: the fixture wrapper calls the fake by absolute path and the fake has
# its record path written into it.
cat > "$FAKEBIN/curl" <<FAKE
#!/bin/bash
# records that a request was made, its arguments and the config fed on stdin (-K -); answers 200
for a in "\$@"; do if [ "\$a" = "-K" ]; then cat >> "$TMP/rec-i.cfg"; fi; done
echo x >> "$TMP/rec-i.calls"
printf '%s\n' "\$@" >> "$TMP/rec-i.argv"
printf '{}\n200'
FAKE
chmod +x "$FAKEBIN/curl"
make_tree i "MAIN_AGENT_ID=mainbot" no
sed "s#| curl -K - #| $FAKEBIN/curl -K - #" "$SRC_DIR/agent-api.sh" > "$ROOT/scripts/agent-api.sh"
grep -q "$FAKEBIN/curl -K -" "$ROOT/scripts/agent-api.sh" && pass "fixture: the wrapper copy calls the fake curl" || fail "fixture: the curl call in agent-api.sh changed, the test cannot inject its fake"
mkdir -p "$ROOT/agents/sub-a"
echo main-fixture-token > "$ROOT/.agent-token"; echo sub-fixture-token > "$ROOT/agents/sub-a/.agent-token"
SUB_ENV=(CLAUDE_CONFIG_DIR="$ROOT/agents/sub-a/.claude-config" MARVEEN_AGENT_TOKEN_FILE="$ROOT/agents/sub-a/.agent-token" AGENT_API_STRICT=1 MAIN_AGENT_ID=mainbot DASHBOARD_BASE_URL=http://evil.invalid:9)
(cd "$ROOT" && env "${SUB_ENV[@]}" git checkout -q -b feature 2>/dev/null)
if grep -q 'evil.invalid' "$TMP/rec-i.argv" 2>/dev/null; then fail "the session's DASHBOARD_BASE_URL was the request target"; elif grep -q 'http://localhost:3420/api/messages' "$TMP/rec-i.argv" 2>/dev/null; then pass "the request went to the tree's own dashboard, not the session's URL"; else fail "unexpected request target: $(cat "$TMP/rec-i.argv" 2>/dev/null)"; fi
assert_eq "STRICT=1, sub-agent session: the alert request went out" "1" "$(wc -l < "$TMP/rec-i.calls" 2>/dev/null | tr -d ' ')"
if grep -q 'main-fixture-token' "$TMP/rec-i.cfg" 2>/dev/null; then pass "it carried the main agent's token"; else fail "main token missing from the request"; fi
if grep -q 'sub-fixture-token' "$TMP/rec-i.cfg" 2>/dev/null; then fail "the sub-agent's token file was read for --token main"; else pass "the sub-agent's token was not used"; fi
# control: the same environment straight into the wrapper IS refused, so the test above would catch a regression
(cd "$ROOT" && env "${SUB_ENV[@]}" bash scripts/agent-api.sh --token main GET /api/x >/dev/null 2>"$TMP/ctl.err"); ctl_rc=$?
assert_eq "control: the wrapper refuses that environment (exit 3)" "3" "$ctl_rc"
if grep -q 'refused (E1)' "$TMP/ctl.err"; then pass "control: the refusal is rule E1"; else fail "control: no E1 text ($(cat "$TMP/ctl.err"))"; fi

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
