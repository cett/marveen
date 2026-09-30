#!/bin/bash
# Unit tests for seed-skills and seed-scheduled-tasks seeding logic.
# Run: bash scripts/__tests__/seed-skills.test.sh

set -e

PASS=0
FAIL=0
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "seed-skills tests"
echo "================="

# --- Test 1: seed-skills copies new skills ---
echo ""
echo "Test 1: seed-skills copies new skills"
SKILLS_TARGET="$TMPDIR_BASE/t1-skills"
mkdir -p "$SKILLS_TARGET"
SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"

SEED_NEW=0
for skill_dir in "$SEED_SKILLS_DIR"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  target="$SKILLS_TARGET/$skill_name"
  mkdir -p "$target"
  for f in "$skill_dir"*; do
    [ -f "$f" ] || continue
    cp "$f" "$target/$(basename "$f")"
  done
  SEED_NEW=$((SEED_NEW + 1))
done

if [ "$SEED_NEW" -ge 3 ]; then
  pass "copied $SEED_NEW skills"
else
  fail "expected >= 3 skills, got $SEED_NEW"
fi

for name in ai-fleet-project-execution channel-plugin-duplicate-socket github-pr-rebase-merge; do
  if [ -f "$SKILLS_TARGET/$name/SKILL.md" ]; then
    pass "$name/SKILL.md exists"
  else
    fail "$name/SKILL.md missing"
  fi
done

# --- Test 2: seed-skills skips existing directories ---
echo ""
echo "Test 2: seed-skills skips existing directories"
SKILLS_TARGET2="$TMPDIR_BASE/t2-skills"
mkdir -p "$SKILLS_TARGET2/ai-fleet-project-execution"
echo "custom content" > "$SKILLS_TARGET2/ai-fleet-project-execution/SKILL.md"

SEED_NEW=0
SEED_SKIP=0
for skill_dir in "$SEED_SKILLS_DIR"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  target="$SKILLS_TARGET2/$skill_name"
  if [ -d "$target" ]; then
    SEED_SKIP=$((SEED_SKIP + 1))
    continue
  fi
  mkdir -p "$target"
  for f in "$skill_dir"*; do
    [ -f "$f" ] || continue
    cp "$f" "$target/$(basename "$f")"
  done
  SEED_NEW=$((SEED_NEW + 1))
done

if [ "$SEED_SKIP" -ge 1 ]; then
  pass "skipped $SEED_SKIP existing skills"
else
  fail "expected >= 1 skipped, got $SEED_SKIP"
fi

EXISTING_CONTENT=$(cat "$SKILLS_TARGET2/ai-fleet-project-execution/SKILL.md")
if [ "$EXISTING_CONTENT" = "custom content" ]; then
  pass "existing skill content preserved"
else
  fail "existing skill content was overwritten"
fi

# --- Test 3: seed-scheduled-tasks applies template substitution ---
echo ""
echo "Test 3: seed-scheduled-tasks template substitution"
SCHED_TARGET="$TMPDIR_BASE/t3-sched"
mkdir -p "$SCHED_TARGET"
SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"
MAIN_AGENT_ID="testbot"
BOT_NAME="TestBot"
OWNER_NAME="Tester"

for tpl in "$SEED_SCHED_DIR"/*/; do
  [ -d "$tpl" ] || continue
  task_name=$(basename "$tpl")
  target="$SCHED_TARGET/$task_name"
  mkdir -p "$target"
  for f in "$tpl"*; do
    [ -f "$f" ] || continue
    sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
        -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
        -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
        -e "s|{{INSTALL_DIR}}|/opt/testbot|g" \
        "$f" > "$target/$(basename "$f")"
  done
done

if [ -f "$SCHED_TARGET/kanban-audit/SKILL.md" ]; then
  pass "kanban-audit/SKILL.md created"
else
  fail "kanban-audit/SKILL.md missing"
fi

if [ -f "$SCHED_TARGET/kanban-audit/task-config.json" ]; then
  pass "kanban-audit/task-config.json created"
else
  fail "kanban-audit/task-config.json missing"
fi

if grep -q '"testbot"' "$SCHED_TARGET/kanban-audit/task-config.json"; then
  pass "MAIN_AGENT_ID substituted in task-config.json"
else
  fail "MAIN_AGENT_ID NOT substituted in task-config.json"
fi

if grep -q '/opt/testbot/store/claudeclaw.db' "$SCHED_TARGET/kanban-audit/SKILL.md"; then
  pass "INSTALL_DIR substituted in SKILL.md"
else
  fail "INSTALL_DIR NOT substituted in SKILL.md"
fi

if grep -q "skip ha assignee='testbot'" "$SCHED_TARGET/kanban-audit/SKILL.md"; then
  pass "MAIN_AGENT_ID substituted in SKILL.md buktatok"
else
  fail "MAIN_AGENT_ID NOT substituted in SKILL.md buktatok"
fi

# No raw placeholders remain
if grep -q '{{MAIN_AGENT_ID}}' "$SCHED_TARGET/kanban-audit/task-config.json" 2>/dev/null; then
  fail "raw {{MAIN_AGENT_ID}} placeholder remains in task-config.json"
else
  pass "no raw placeholders in task-config.json"
fi

if grep -q '{{INSTALL_DIR}}' "$SCHED_TARGET/kanban-audit/SKILL.md" 2>/dev/null; then
  fail "raw {{INSTALL_DIR}} placeholder remains in SKILL.md"
else
  pass "no raw placeholders in SKILL.md"
fi

# --- Test 4: seed-scheduled-tasks skips existing (full copy-loop) ---
echo ""
echo "Test 4: seed-scheduled-tasks skips existing (full loop)"
SCHED_TARGET2="$TMPDIR_BASE/t4-sched"
# Pre-create EVERY existing seed template so the skip-existing path covers them
# all (the test asserts 0 newly seeded). Robust to new templates being added.
for tpl in "$SEED_SCHED_DIR"/*/; do [ -d "$tpl" ] && mkdir -p "$SCHED_TARGET2/$(basename "$tpl")"; done
echo "custom" > "$SCHED_TARGET2/kanban-audit/task-config.json"

SCHED_NEW=0
SCHED_SKIP=0
for tpl in "$SEED_SCHED_DIR"/*/; do
  [ -d "$tpl" ] || continue
  task_name=$(basename "$tpl")
  target="$SCHED_TARGET2/$task_name"
  if [ -d "$target" ]; then
    SCHED_SKIP=$((SCHED_SKIP + 1))
    continue
  fi
  mkdir -p "$target"
  for f in "$tpl"*; do
    [ -f "$f" ] || continue
    sed -e "s/{{MAIN_AGENT_ID}}/testbot/g" \
        -e "s/{{BOT_NAME}}/TestBot/g" \
        -e "s/{{OWNER_NAME}}/Tester/g" \
        -e "s|{{INSTALL_DIR}}|/opt/testbot|g" \
        "$f" > "$target/$(basename "$f")"
  done
  SCHED_NEW=$((SCHED_NEW + 1))
done

if [ "$SCHED_SKIP" -ge 1 ]; then
  pass "skipped $SCHED_SKIP existing scheduled tasks"
else
  fail "expected >= 1 skipped, got $SCHED_SKIP"
fi

if [ "$SCHED_NEW" -eq 0 ]; then
  pass "no new tasks seeded (all existed)"
else
  fail "expected 0 new tasks, got $SCHED_NEW"
fi

EXISTING=$(cat "$SCHED_TARGET2/kanban-audit/task-config.json")
if [ "$EXISTING" = "custom" ]; then
  pass "existing scheduled task config preserved"
else
  fail "existing scheduled task config was overwritten"
fi

# --- Test 5: update.sh's --reseed-fleet loop substitutes {{WEB_PORT}} ---
# Regression guard: update.sh has its OWN copy of this sed pipeline (separate
# from install-macos.sh/install-linux.sh/render_seed_template()) for its
# --reseed-fleet force-refresh loop. That copy once lacked the {{WEB_PORT}}
# substitution entirely (only MAIN_AGENT_ID/BOT_NAME/OWNER_NAME/INSTALL_DIR),
# leaving the literal placeholder in a force-reseeded kanban-audit/SKILL.md --
# its autonomy-read curl then hit "localhost:{{WEB_PORT}}", an invalid URL.
echo ""
echo "Test 5: update.sh reseed-fleet loop substitutes {{WEB_PORT}}"

# 5a: static guard on the actual script -- the exact sed pipeline update.sh's
# reseed-fleet loop uses for seed-scheduled-tasks must include the WEB_PORT
# substitution alongside the other four. Anchored on the loop's own preceding
# comment so it does not also match install-macos.sh/install-linux.sh's (or
# update.sh's OWN CLAUDE.md-regen) separate, already-correct pipelines.
UPDATE_SH="$INSTALL_DIR/update.sh"
RESEED_LOOP_BLOCK=$(awk '/Default skip-if-exists; --reseed-fleet force-refreshes/,/^    done$/' "$UPDATE_SH")
if echo "$RESEED_LOOP_BLOCK" | grep -q '{{WEB_PORT}}'; then
  pass "update.sh reseed-fleet loop's sed pipeline includes {{WEB_PORT}}"
else
  fail "update.sh reseed-fleet loop's sed pipeline is MISSING {{WEB_PORT}} substitution"
fi

# 5b: behavioral -- same pipeline shape, run with WEB_PORT=4567, on the real
# kanban-audit seed source (which references {{WEB_PORT}} in its autonomy
# curl recipe as of this fix).
SCHED_TARGET5="$TMPDIR_BASE/t5-sched"
mkdir -p "$SCHED_TARGET5/kanban-audit"
WEB_PORT="4567"
for f in "$SEED_SCHED_DIR/kanban-audit/"*; do
  [ -f "$f" ] || continue
  sed -e "s/{{MAIN_AGENT_ID}}/testbot/g" \
      -e "s/{{BOT_NAME}}/TestBot/g" \
      -e "s/{{OWNER_NAME}}/Tester/g" \
      -e "s|{{INSTALL_DIR}}|/opt/testbot|g" \
      -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g" \
      "$f" > "$SCHED_TARGET5/kanban-audit/$(basename "$f")"
done

if grep -q 'localhost:4567' "$SCHED_TARGET5/kanban-audit/SKILL.md"; then
  pass "WEB_PORT=4567 substituted to localhost:4567 in SKILL.md"
else
  fail "WEB_PORT NOT substituted -- localhost:4567 missing from SKILL.md"
fi

if grep -q '{{WEB_PORT}}' "$SCHED_TARGET5/kanban-audit/SKILL.md" 2>/dev/null; then
  fail "raw {{WEB_PORT}} placeholder remains in SKILL.md"
else
  pass "no raw {{WEB_PORT}} placeholder in SKILL.md"
fi
unset WEB_PORT

# 5c/5d: run the REAL update.sh block (not a hand-copied pipeline like 5b),
# extracted by the same comment anchors update.sh itself uses to bound this
# section (from "Seed skills & scheduled tasks" down to, but not including,
# the CLAUDE.md-regen section that follows it). This is what actually catches
# a regression 5a/5b cannot: 5a only checks the sed pipeline has a {{WEB_PORT}}
# clause at all, and 5b's WEB_PORT="4567" is unquoted plain text, so neither
# would notice the .env-read line itself being wrong (missing tr -d '"', or
# unconditionally overwriting an already-exported WEB_PORT).
BLOCK_FILE="$TMPDIR_BASE/reseed-block.sh"
sed -n '/^# Seed skills & scheduled tasks (idempotent: skip existing)$/,/^# --- Main CLAUDE.md identity check/p' "$UPDATE_SH" \
  | sed '$d' > "$BLOCK_FILE"
if [ ! -s "$BLOCK_FILE" ]; then
  fail "could not extract the reseed block from update.sh (comment anchors moved?)"
fi

echo ""
echo "Test 5c: real update.sh block, quoted WEB_PORT in .env"
FIXTURE_INSTALL="$TMPDIR_BASE/t5c-install"
FIXTURE_HOME="$TMPDIR_BASE/t5c-home"
mkdir -p "$FIXTURE_INSTALL" "$FIXTURE_HOME"
ln -s "$SEED_SCHED_DIR" "$FIXTURE_INSTALL/seed-scheduled-tasks"
printf 'MAIN_AGENT_ID=testbot\nBOT_NAME=TestBot\nOWNER_NAME=Tester\nWEB_PORT="4567"\n' > "$FIXTURE_INSTALL/.env"

( unset WEB_PORT
  export INSTALL_DIR="$FIXTURE_INSTALL" HOME="$FIXTURE_HOME" RESEED_FLEET=""
  bash "$BLOCK_FILE" > /dev/null 2>&1
)

T5C_SKILL="$FIXTURE_HOME/.claude/scheduled-tasks/kanban-audit/SKILL.md"
if [ -f "$T5C_SKILL" ] && grep -q 'localhost:4567' "$T5C_SKILL"; then
  pass "real update.sh block: quoted .env WEB_PORT renders as localhost:4567"
else
  fail "real update.sh block did NOT render localhost:4567 (quoted .env value)"
fi
if grep -q '{{WEB_PORT}}' "$T5C_SKILL" 2>/dev/null; then
  fail "real update.sh block left a raw {{WEB_PORT}} placeholder"
else
  pass "real update.sh block left no raw {{WEB_PORT}} placeholder"
fi
if grep -qF '"4567"' "$T5C_SKILL" 2>/dev/null || grep -q 'localhost:"4567"' "$T5C_SKILL" 2>/dev/null; then
  fail "the .env value's quotes were not stripped -- literal quote characters leaked into SKILL.md"
else
  pass "the .env value's quotes were stripped before substitution"
fi

echo ""
echo "Test 5d: real update.sh block respects an already-exported WEB_PORT over .env"
FIXTURE_INSTALL2="$TMPDIR_BASE/t5d-install"
FIXTURE_HOME2="$TMPDIR_BASE/t5d-home"
mkdir -p "$FIXTURE_INSTALL2" "$FIXTURE_HOME2"
ln -s "$SEED_SCHED_DIR" "$FIXTURE_INSTALL2/seed-scheduled-tasks"
# .env deliberately disagrees with the pre-exported value below -- the
# pre-exported one must win (same precedence run_seed_refresh() already uses).
printf 'MAIN_AGENT_ID=testbot\nBOT_NAME=TestBot\nOWNER_NAME=Tester\nWEB_PORT=1111\n' > "$FIXTURE_INSTALL2/.env"

( export INSTALL_DIR="$FIXTURE_INSTALL2" HOME="$FIXTURE_HOME2" RESEED_FLEET="" WEB_PORT="9876"
  bash "$BLOCK_FILE" > /dev/null 2>&1
)

T5D_SKILL="$FIXTURE_HOME2/.claude/scheduled-tasks/kanban-audit/SKILL.md"
if [ -f "$T5D_SKILL" ] && grep -q 'localhost:9876' "$T5D_SKILL"; then
  pass "an already-exported WEB_PORT (9876) wins over a conflicting .env value (1111)"
else
  fail "the pre-exported WEB_PORT was NOT respected (expected localhost:9876)"
fi
if grep -q 'localhost:1111' "$T5D_SKILL" 2>/dev/null; then
  fail "the .env value (1111) was used instead of the pre-exported one -- exported WEB_PORT got overwritten"
fi

echo ""
echo "Test 5e: real update.sh block falls back to the documented default (3420) when WEB_PORT is set nowhere"
FIXTURE_INSTALL3="$TMPDIR_BASE/t5e-install"
FIXTURE_HOME3="$TMPDIR_BASE/t5e-home"
mkdir -p "$FIXTURE_INSTALL3" "$FIXTURE_HOME3"
ln -s "$SEED_SCHED_DIR" "$FIXTURE_INSTALL3/seed-scheduled-tasks"
# No WEB_PORT line in .env at all, and (per the `unset WEB_PORT` after Test 5b,
# and no `export` of it anywhere in this test file) none in the environment
# either -- this is the "nothing set it" case the ${WEB_PORT:-3420} fallback
# literal itself is responsible for, distinct from 5c (quoted value present)
# and 5d (pre-exported value present). Mutation testing flagged this as the
# one case the other two tests cannot catch: a mutant changing the fallback
# literal (e.g. 3420 -> 3421) survived until this test existed.
printf 'MAIN_AGENT_ID=testbot\nBOT_NAME=TestBot\nOWNER_NAME=Tester\n' > "$FIXTURE_INSTALL3/.env"

( unset WEB_PORT
  export INSTALL_DIR="$FIXTURE_INSTALL3" HOME="$FIXTURE_HOME3" RESEED_FLEET=""
  bash "$BLOCK_FILE" > /dev/null 2>&1
)

T5E_SKILL="$FIXTURE_HOME3/.claude/scheduled-tasks/kanban-audit/SKILL.md"
if [ -f "$T5E_SKILL" ] && grep -q 'localhost:3420' "$T5E_SKILL"; then
  pass "no WEB_PORT anywhere: real update.sh block falls back to localhost:3420"
else
  fail "no WEB_PORT anywhere: expected the localhost:3420 default, not found"
fi
if grep -q '{{WEB_PORT}}' "$T5E_SKILL" 2>/dev/null; then
  fail "raw {{WEB_PORT}} placeholder remains when no WEB_PORT was set anywhere"
fi

# --- Summary ---
echo ""
echo "================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED: $FAIL tests"
  exit 1
fi
echo "All tests passed."
