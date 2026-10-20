#!/usr/bin/env bash
# The three scripts that call an outside API with a secret (set-bot-menu.sh, smoke-test-slack-channel.sh,
# pre-pr-review.sh) hand the secret to curl on stdin, never on its command line, and pre-pr-review.sh does not send a
# diff that fails the secret gate. A fake curl records what it was given (its argv, and the config it was fed on stdin);
# the scripts run in a throw-away install with their real lib and gate runner.
# Test values only: none of them has the shape of a real credential.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILS=0
ok() { echo "  OK   $1"; }
bad() { echo "  FAIL $1"; FAILS=$((FAILS + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/curl-secret-scripts.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"

# A curl that only records. Argv goes to argv.<n>, the config fed with `-K -` goes to cfg.<n>; the reply depends on
# what the call was for. The Slack send also leaves the evidence the smoke test polls for.
cat > "$FAKEBIN/curl" <<'FAKE'
#!/bin/bash
REC="${FAKE_REC:?}"
n=$(( $(cat "$REC/n" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$REC/n"
printf '%s\n' "$@" > "$REC/argv.$n"
for a in "$@"; do
  if [ "$a" = "-K" ]; then cat > "$REC/cfg.$n"; break; fi
done
touch "$REC/cfg.$n"
all="$(cat "$REC/argv.$n" "$REC/cfg.$n")"
case "$all" in
  *conversations.open*) echo '{"ok":true,"channel":{"id":"D123"}}' ;;
  *chat.postMessage*)
    mkdir -p "$FAKE_STATE_DIR/sessions/D123"; echo '{}' > "$FAKE_STATE_DIR/sessions/D123/s1.json"
    echo '{"kind":"gate.inbound.deliver"}' >> "$FAKE_STATE_DIR/audit.jsonl"
    echo '{"ok":true}' ;;
  *api.openai.com*) echo '{"choices":[{"message":{"content":"openai-review-ok"}}]}' ;;
  *generativelanguage*) echo '{"candidates":[{"content":{"parts":[{"text":"gemini-review-ok"}]}}]}' ;;
  *) echo '{"ok":true}' ;;
esac
FAKE
printf '#!/bin/bash\nexit 0\n' > "$FAKEBIN/sleep"
chmod +x "$FAKEBIN/curl" "$FAKEBIN/sleep"

# A throw-away install with the real scripts, helper, gate runner and gate core.
new_install() {
  INST="$WORK/inst-$1"
  REC="$WORK/rec-$1"
  mkdir -p "$INST/scripts/lib" "$INST/src/security" "$INST/store" "$REC"
  cp "$ROOT/scripts/set-bot-menu.sh" "$ROOT/scripts/smoke-test-slack-channel.sh" "$ROOT/scripts/pre-pr-review.sh" \
     "$ROOT/scripts/secret-gate.ts" "$INST/scripts/"
  cp "$ROOT/scripts/lib/curl-tok.sh" "$INST/scripts/lib/"
  cp "$ROOT/src/security/secret-gate.ts" "$INST/src/security/"
  cp "$ROOT/package.json" "$INST/package.json"
  ln -s "$ROOT/node_modules" "$INST/node_modules"
  : > "$INST/store/.operator-token"
}
args_hold() { grep -q -F -- "$2" "$1"/argv.* 2>/dev/null; } # dir, text: does any recorded argv hold the text?
cfg_hold() { grep -q -F -- "$2" "$1"/cfg.* 2>/dev/null; }

echo "1) set-bot-menu.sh: the bot token is in the URL, so it goes in the stdin config"
new_install bot
mkdir -p "$WORK/home-bot/.claude/channels/telegram"
echo 'TELEGRAM_BOT_TOKEN=TESTBOT:fixturevalue' > "$WORK/home-bot/.claude/channels/telegram/.env"
OUT="$(HOME="$WORK/home-bot" PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" bash "$INST/scripts/set-bot-menu.sh" 2>&1)"; RC=$?
[ "$RC" = 0 ] && ok "exit 0" || bad "exit $RC: $OUT"
cfg_hold "$REC" 'url = "https://api.telegram.org/botTESTBOT:fixturevalue/setMyCommands"' && ok "the URL with the token is in the config" || bad "the config does not hold the URL"
args_hold "$REC" 'TESTBOT' && bad "the bot token is in curl's argv" || ok "the bot token is not in curl's argv"
args_hold "$REC" 'setMyCommands' && bad "the method URL is in argv (the token travels with it)" || ok "no URL in argv"
args_hold "$REC" '"commands"' && ok "the command list still goes as the body" || bad "the body is missing"

echo "2) smoke-test-slack-channel.sh: the Slack bot token goes in the stdin config on both calls"
new_install slack
STATE="$INST/agents/slacker/.claude/channels/slack"
mkdir -p "$STATE"
echo 'SLACK_BOT_TOKEN=slackfixturevalue' > "$STATE/.env"
echo '{"allowFrom":["U1"]}' > "$STATE/access.json"
OUT="$(SLACK_SMOKE_TEST_ALLOWED=true PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" FAKE_STATE_DIR="$STATE" bash "$INST/scripts/smoke-test-slack-channel.sh" 2>&1)"; RC=$?
[ "$RC" = 0 ] && ok "exit 0 (session file and audit entry seen)" || bad "exit $RC: $OUT"
[ "$(grep -l -F 'Authorization: Bearer slackfixturevalue' "$REC"/cfg.* 2>/dev/null | wc -l | tr -d ' ')" = 2 ] && ok "both calls carried the Authorization header in the config" || bad "the header is not in both configs"
args_hold "$REC" 'slackfixturevalue' && bad "the Slack token is in curl's argv" || ok "the Slack token is not in curl's argv"
case "$OUT" in *slackfixturevalue*) bad "the token was printed" ;; *) ok "the token is not printed" ;; esac

# pre-pr-review.sh runs in a git repo (the install itself): a base commit, then the change under test.
run_review() { # name, then: a shell snippet that makes the change and commits it
  new_install "$1"
  printf '#!/bin/bash\nprintf %%s %q\n' "${VAULT_REPLY}" > "$INST/scripts/agent-api.sh"
  ( cd "$INST" && git init -q && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m base && git tag base \
    && eval "$2" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m change ) >/dev/null 2>&1
  OUT="$(cd "$INST" && PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" FAKE_STATE_DIR="$WORK" bash scripts/pre-pr-review.sh base 2>"$WORK/err-$1")"; RC=$?
  ERR="$(cat "$WORK/err-$1")"
  CALLS="$(cat "$REC/n" 2>/dev/null || echo 0)"
}

echo "3) pre-pr-review.sh: a clean diff is reviewed, the keys go in the stdin config, the body is a file"
VAULT_REPLY='{"value":"vaultfixturevalue"}'
run_review clean 'echo "a harmless note" > notes.txt'
[ "$RC" = 0 ] && ok "exit 0" || bad "exit $RC: $ERR"
case "$OUT" in *openai-review-ok*gemini-review-ok*) ok "both reviews printed" ;; *) bad "reviews missing: $OUT" ;; esac
cfg_hold "$REC" 'Authorization: Bearer vaultfixturevalue' && ok "the OpenAI key is in the config" || bad "no OpenAI header in a config"
cfg_hold "$REC" 'x-goog-api-key: vaultfixturevalue' && ok "the Gemini key is in the config as a header" || bad "no Gemini header in a config"
args_hold "$REC" 'vaultfixturevalue' && bad "a key is in curl's argv" || ok "no key in curl's argv"
args_hold "$REC" 'key=' && bad "a ?key= query is back" || ok "no ?key= query"
args_hold "$REC" '--data-binary' && ok "the body goes as a file" || bad "no --data-binary"
args_hold "$REC" 'harmless note' && bad "the diff text is in curl's argv (argument-size limit, ps)" || ok "the diff text is not in curl's argv"
[ "$(grep -l -F -- '--data-binary' "$REC"/argv.* 2>/dev/null | wc -l | tr -d ' ')" = 2 ] && ok "both requests send their body from a file" || bad "a request does not send its body from a file"

echo "4) pre-pr-review.sh: a secret shape in the diff stops it before anything is sent"
SECRETLINE="printf 'token ghp_%s\n' \"\$(printf 'A%.0s' \$(seq 1 36))\" > leak.txt"
run_review leak "$SECRETLINE"
[ "$RC" = 1 ] && ok "exit 1" || bad "exit $RC (wanted 1)"
[ "$CALLS" = 0 ] && ok "curl was never called" || bad "curl was called $CALLS time(s)"
case "$ERR" in *"NOT sent"*) ok "the refusal is stated" ;; *) bad "no refusal text: $ERR" ;; esac
case "$OUT$ERR" in *AAAAAAAAAAAAAAAA*) bad "the secret was printed" ;; *) ok "the secret is not printed" ;; esac

echo "5) pre-pr-review.sh: a secret on a REMOVED line counts (the diff carries it, the working tree no longer does)"
VAULT_REPLY='{"value":"vaultfixturevalue"}'
# The base holds a file with a secret shape; the change deletes the secret line (a) or the whole file (b).
run_review_removed() { # name, change
  new_install "$1"
  printf '#!/bin/bash\nprintf %%s %q\n' "${VAULT_REPLY}" > "$INST/scripts/agent-api.sh"
  printf 'token ghp_%s\nkept line\n' "$(printf 'B%.0s' $(seq 1 36))" > "$INST/old.txt"
  ( cd "$INST" && git init -q && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m base && git tag base \
    && eval "$2" && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m change ) >/dev/null 2>&1
  OUT="$(cd "$INST" && PATH="$FAKEBIN:$PATH" FAKE_REC="$REC" FAKE_STATE_DIR="$WORK" bash scripts/pre-pr-review.sh base 2>/dev/null)"; RC=$?
  CALLS="$(cat "$REC/n" 2>/dev/null || echo 0)"
}
run_review_removed removed-line 'echo "kept line" > old.txt && echo hi > added.txt'
[ "$RC" = 1 ] && [ "$CALLS" = 0 ] && ok "a modified file: blocked, nothing sent" || bad "modified file: exit $RC, calls $CALLS"
run_review_removed removed-file 'git rm -q old.txt && echo hi > added.txt'
[ "$RC" = 1 ] && [ "$CALLS" = 0 ] && ok "a deleted file: blocked, nothing sent" || bad "deleted file: exit $RC, calls $CALLS"

echo "5b) pre-pr-review.sh: channel material in an added line is caught (a rule that anchors on the line start)"
run_review channel 'printf "[Uzenet @%s-tol -- quoted\n" peer > quoted.txt'
[ "$RC" = 1 ] && [ "$CALLS" = 0 ] && ok "blocked, nothing sent" || bad "exit $RC, calls $CALLS"

echo "6) pre-pr-review.sh: a denied path stops it"
run_review denied 'mkdir -p evidence && echo "run output" > evidence/run.txt'
[ "$RC" = 1 ] && [ "$CALLS" = 0 ] && ok "blocked, nothing sent" || bad "exit $RC, calls $CALLS"

echo "7) pre-pr-review.sh: no keys in the vault means both reviews are skipped and nothing is sent"
VAULT_REPLY='{}'
run_review nokeys 'echo "a harmless note" > notes.txt'
[ "$RC" = 0 ] && [ "$CALLS" = 0 ] && ok "exit 0, curl not called" || bad "exit $RC, calls $CALLS"
case "$OUT" in *"ChatGPT review skipped"*"Gemini review skipped"*) ok "both skips are reported" ;; *) bad "skip lines missing: $OUT" ;; esac

echo "TOTAL: $FAILS failure(s)"
exit "$FAILS"
