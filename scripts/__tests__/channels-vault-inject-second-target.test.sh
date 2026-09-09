#!/bin/bash
# Contract test for #761 [3.1]: scripts/channels.sh must run the already-
# tested vault-inject-http-mcp.sh inject/restore cycle (mechanics covered by
# vault-inject-http-mcp.test.sh) against BOTH the default ~/.claude.json
# target AND the isolated main-agent config at
# $INSTALL_DIR/.channels-config/.claude.json.
#
# Root cause this closes: when the channel bot runs in isolated
# main-agent-config mode (MAIN_AGENT_ISOLATED_CONFIG=1), its actual
# CLAUDE_CONFIG_DIR resolves to .channels-config, which has its OWN
# mcpServers.*.headers block -- separate from ~/.claude.json. The default
# inject/restore call only ever covered the default target, so that second
# config's HTTP MCP headers (e.g. UptimeRobot's) never got vault-templated
# at rest. This test only checks that channels.sh actually invokes the
# script against both targets for both inject and restore -- the inject/
# restore mechanics themselves (idempotency, atomic write, missing-file
# no-op) are exercised in vault-inject-http-mcp.test.sh.
#
# Run: bash scripts/__tests__/channels-vault-inject-second-target.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

echo "channels.sh vault-inject second-target contract"

# --- inject: default target still present --------------------------------
if grep -qE '"\$INSTALL_DIR/scripts/vault-inject-http-mcp\.sh" inject >>' "$CHANNELS"; then
  pass "default-target inject call present"
else
  fail "default-target inject call present"
fi

# --- inject: .channels-config/.claude.json target added ------------------
if grep -qE '"\$INSTALL_DIR/scripts/vault-inject-http-mcp\.sh" inject "\$INSTALL_DIR/\.channels-config/\.claude\.json"' "$CHANNELS"; then
  pass "isolated-config-target inject call present"
else
  fail "isolated-config-target inject call present"
fi

# --- restore: both targets wired into the same EXIT/INT/TERM trap --------
trap_line="$(grep -E "^trap '.*vault-inject-http-mcp\.sh\" restore" "$CHANNELS")"
if [ -z "$trap_line" ]; then
  fail "restore trap line found at all"
else
  case "$trap_line" in
    *'vault-inject-http-mcp.sh" restore >>'*'vault-inject-http-mcp.sh" restore "$INSTALL_DIR/.channels-config/.claude.json"'*'EXIT INT TERM'*)
      pass "restore trap covers both targets and stays on EXIT INT TERM" ;;
    *)
      fail "restore trap covers both targets and stays on EXIT INT TERM" ;;
  esac
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
