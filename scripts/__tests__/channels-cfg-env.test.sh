#!/bin/bash
# Contract tests for the config-dir env prefix of the main agent in scripts/channels.sh.
#
# The shell that runs channels.sh exports the fleet CLAUDE_CODE_OAUTH_TOKEN (from .env or the fleet token
# file) and puts it in the tmux global environment. A token in the environment strictly overrides the login a
# config dir stores, so the `explicit` and `rotated` modes (a dir with its OWN .credentials.json) would lose
# their login unless the launch command drops the token again. The `isolated` mode has a dir without a login
# and seeds the token from the fleet token file instead; its prefix must stay as it was.
#
# Driven through `channels.sh --resolve-cfg-env <mode> <dir>`, which prints the prefix and exits before
# touching tmux, the store or the network. The prefix is then run in a real shell that already carries a token,
# the way the launched session does.
# Run: bash scripts/__tests__/channels-cfg-env.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/scripts" "$ROOT/store"
cp "$SRC" "$ROOT/scripts/channels.sh"
printf '%s' 'fleet-file-token' > "$ROOT/store/.claude-oauth-token"

prefix() { bash "$ROOT/scripts/channels.sh" --resolve-cfg-env "$1" "$2" 2>/dev/null | head -1; }

# The environment a shell sees after the prefix ran in a session that inherited a token.
# $1 = prefix, $2 = variable
env_after_prefix() {
  CLAUDE_CODE_OAUTH_TOKEN="inherited-token" bash -c "${1}printf '%s' \"\${$2-<unset>}\""
}

echo "channels.sh main-agent config-dir env prefix"

for mode in explicit rotated; do
  p="$(prefix "$mode" /x/dir)"
  want="export CLAUDE_CONFIG_DIR='/x/dir' && unset CLAUDE_CODE_OAUTH_TOKEN && "
  if [ "$p" = "$want" ]; then pass "$mode: prefix"; else fail "$mode: prefix" "$want" "$p"; fi

  got="$(env_after_prefix "$p" CLAUDE_CODE_OAUTH_TOKEN)"
  if [ "$got" = "<unset>" ]; then pass "$mode: an inherited token is gone in the launched shell"; else fail "$mode: inherited token" "<unset>" "$got"; fi

  got="$(env_after_prefix "$p" CLAUDE_CONFIG_DIR)"
  if [ "$got" = "/x/dir" ]; then pass "$mode: the config dir is exported"; else fail "$mode: config dir" "/x/dir" "$got"; fi
done

# isolated: unchanged. The literal is the prefix as it was before the token was unset for the other two modes.
p="$(prefix isolated /x/iso)"
want="export CLAUDE_CONFIG_DIR='/x/iso' && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$ROOT/store/.claude-oauth-token')\" && "
if [ "$p" = "$want" ]; then pass "isolated: prefix unchanged"; else fail "isolated: prefix" "$want" "$p"; fi

got="$(env_after_prefix "$p" CLAUDE_CODE_OAUTH_TOKEN)"
if [ "$got" = "fleet-file-token" ]; then pass "isolated: the token comes from the fleet token file"; else fail "isolated: token" "fleet-file-token" "$got"; fi

echo ""
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
