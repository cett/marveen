#!/bin/bash
# Contract tests for main-agent model resolution in scripts/channels.sh.
#
# Why this exists (2026-07-29): the model was read ONLY from
# .claude/settings.json, which is a TRACKED file. An install that wants a
# different model than the repository ships had to edit that file, and then:
#   - the update preflight refused to run ("dirty tree"), so the dashboard's
#     update button was permanently blocked on that install, and
#   - checking out the release branch silently restored the repository's model,
#     so the next restart came up on a different model than the operator chose.
#     Silent, because nothing fails -- the agent just answers as another model.
#
# MAIN_AGENT_MODEL in .env (per-install, gitignored) now takes precedence, and
# settings.json remains the shipped default.
#
# Driven through `channels.sh --resolve-main-model`, which prints the resolved
# model and exits before touching tmux, the store or the network.
# Run: bash scripts/__tests__/channels-main-model.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

# Each case runs the script from a throwaway install root, so INSTALL_DIR (which
# the script derives from its own path) points at fixture files, not the repo.
# $1 = label, $2 = .env body, $3 = settings.json body, $4 = expected model
expect_model() {
  local label="$1" env_body="$2" settings_body="$3" want="$4"
  local root got
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/.claude"
  cp "$SRC" "$root/scripts/channels.sh"
  [ -n "$env_body" ] && printf '%s\n' "$env_body" > "$root/.env"
  [ -n "$settings_body" ] && printf '%s\n' "$settings_body" > "$root/.claude/settings.json"
  got="$(bash "$root/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
  rm -rf "$root"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "$want" "$got"; fi
}

echo "channels.sh main-model resolution"

expect_model "settings.json alone is still honoured (shipped default)" \
  "" '{"model":"claude-opus-4-8[1m]"}' 'claude-opus-4-8[1m]'

expect_model ".env wins over settings.json (the whole point)" \
  'MAIN_AGENT_MODEL=claude-opus-5' '{"model":"claude-opus-4-8[1m]"}' 'claude-opus-5'

expect_model ".env alone works with no settings.json" \
  'MAIN_AGENT_MODEL=claude-sonnet-5' '' 'claude-sonnet-5'

expect_model "neither present -> empty, launcher omits --model" \
  "" '' ''

expect_model "an empty MAIN_AGENT_MODEL does not shadow settings.json" \
  'MAIN_AGENT_MODEL=' '{"model":"claude-opus-5"}' 'claude-opus-5'

# A model id with a bracketed suffix must survive verbatim: the launcher
# single-quotes it, and an unquoted [1m] would glob-expand in the tmux shell.
expect_model "bracketed suffix survives the .env route" \
  'MAIN_AGENT_MODEL=claude-opus-5[1m]' '' 'claude-opus-5[1m]'

# .env carries other keys too; the matcher must be anchored, not a substring.
expect_model "a similarly named key does not leak in" \
  'NOT_MAIN_AGENT_MODEL=wrong-model
MAIN_AGENT_MODEL=claude-haiku-4-5' '' 'claude-haiku-4-5'

# Model-fallback downgrade overlay: store/model-fallback-state.json, keyed by
# agent id. While it holds an entry for the main agent it wins over the env
# file, which is never rewritten (it stays the revert target).
# $1 = label, $2 = env body, $3 = state-file body ('' = no file), $4 = expected
expect_overlay() {
  local label="$1" env_body="$2" state_body="$3" want="$4"
  local root got
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/.claude" "$root/store"
  cp "$SRC" "$root/scripts/channels.sh"
  printf '%s\n' "$env_body" > "$root/.env"
  [ -n "$state_body" ] && printf '%s\n' "$state_body" > "$root/store/model-fallback-state.json"
  got="$(bash "$root/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
  rm -rf "$root"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "$want" "$got"; fi
}

ENV_MAIN='MAIN_AGENT_ID=main-x
MAIN_AGENT_MODEL=claude-opus-5-5'

expect_overlay "fallback overlay wins over the env file for the main agent" \
  "$ENV_MAIN" '{"main-x":{"primary":"claude-opus-5-5","current":"claude-sonnet-5","downgradedAt":1}}' 'claude-sonnet-5'

expect_overlay "no state file -> env file as before" \
  "$ENV_MAIN" '' 'claude-opus-5-5'

expect_overlay "overlay for ANOTHER agent does not leak onto main" \
  "$ENV_MAIN" '{"sub-y":{"primary":"claude-opus-5-5","current":"claude-haiku-4-5-20251001","downgradedAt":1}}' 'claude-opus-5-5'

expect_overlay "corrupt state file -> env file (never breaks the launch)" \
  "$ENV_MAIN" '{not json' 'claude-opus-5-5'

expect_overlay "an overlay value that is not a plain model id is ignored" \
  "$ENV_MAIN" '{"main-x":{"primary":"x","current":"a b; echo pwned","downgradedAt":1}}' 'claude-opus-5-5'

expect_overlay "bracketed suffix survives the overlay route" \
  "$ENV_MAIN" '{"main-x":{"primary":"x","current":"claude-sonnet-5[1m]","downgradedAt":1}}' 'claude-sonnet-5[1m]'

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
