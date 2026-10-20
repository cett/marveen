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
make_tree e "MAIN_AGENT_ID=mainbot" yes
(cd "$ROOT" && MARVEEN_GUARD_ALERT_TO=someone git checkout -q -b feature 2>/dev/null)
assert_eq "MARVEEN_GUARD_ALERT_TO still overrides the recipient" "someone" "$(field "$ROOT" to)"
assert_eq "...and the sender stays the main agent" "mainbot" "$(field "$ROOT" from)"

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

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
