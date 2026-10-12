#!/bin/bash
# scripts/ci-vitest-related.sh selection contract, on a throwaway git repo with a stub runner that
# records how it was called. Run: bash scripts/__tests__/ci-vitest-related.test.sh

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/ci-vitest-related.sh"

# The stub runner: records its arguments, exits with $STUB_EXIT (default 0).
STUB="$TMPDIR_BASE/stub-vitest"
cat > "$STUB" <<'EOF'
#!/bin/bash
echo "$@" > "$STUB_LOG"
exit "${STUB_EXIT:-0}"
EOF
chmod +x "$STUB"

# new_repo <name>: a repo with a base commit holding a few files; echoes the path. BASE is the base commit.
new_repo() {
  local r="$TMPDIR_BASE/$1"
  mkdir -p "$r/src/__tests__" "$r/docs" "$r/scripts"
  ( cd "$r" && git init -q && git config user.email t@example.invalid && git config user.name t \
    && echo "export const a = 1" > src/a.ts && echo "test" > src/__tests__/a.test.ts \
    && echo "doc" > docs/readme.md && echo "{}" > package.json && echo "old" > src/gone.ts \
    && git add -A && git commit -q -m base )
  echo "$r"
}

# run_in <repo>: runs the script against the repo's first commit; sets OUT, RC, CALL ("" when the runner was not called).
run_in() {
  local r="$1"
  local base; base="$(cd "$r" && git rev-list --max-parents=0 HEAD)"
  export STUB_LOG="$r/call.log"; rm -f "$STUB_LOG"
  OUT="$(cd "$r" && VITEST_CMD="$STUB" bash "$SCRIPT" "$base" 2>&1)"; RC=$?
  CALL=""; [ -f "$STUB_LOG" ] && CALL="$(cat "$STUB_LOG")"
}
commit_change() {  # commit_change <repo> <command...>
  local r="$1"; shift
  ( cd "$r" && eval "$@" && git add -A && git commit -q -m change )
}

echo "ci-vitest-related.sh selection"

R="$(new_repo docsonly)"; commit_change "$R" 'echo more >> docs/readme.md'
run_in "$R"
[ "$RC" -eq 0 ] && [ -z "$CALL" ] && pass "a docs-only change: skipped cleanly, the runner is not called" || fail "docs-only: rc=$RC call='$CALL'"

R="$(new_repo srcchange)"; commit_change "$R" 'echo "export const b = 2" >> src/a.ts'
run_in "$R"
[ "$CALL" = "related src/a.ts --run --passWithNoTests" ] && pass "a source change: vitest related on that file, with --run --passWithNoTests" || fail "source change: call='$CALL'"

R="$(new_repo testchange)"; commit_change "$R" 'echo more >> src/__tests__/a.test.ts; echo "export const c = 3" > src/c.ts'
run_in "$R"
[ "$CALL" = "related src/__tests__/a.test.ts src/c.ts --run --passWithNoTests" ] && pass "changed test files and sources are both passed (new files included)" || fail "test+source: call='$CALL'"

R="$(new_repo deleted)"; commit_change "$R" 'git rm -q src/gone.ts'
run_in "$R"
[ "$RC" -eq 0 ] && [ -z "$CALL" ] && pass "a deleted file is not passed to vitest (nothing to run, skipped)" || fail "deleted: rc=$RC call='$CALL'"

R="$(new_repo pkg)"; commit_change "$R" 'echo "{\"a\":1}" > package.json'
run_in "$R"
[ "$CALL" = "run" ] && pass "package.json changed: the whole suite" || fail "package.json: call='$CALL'"

R="$(new_repo vconf)"; commit_change "$R" 'echo "export default {}" > vitest.config.ts'
run_in "$R"
[ "$CALL" = "run" ] && pass "vitest.config.ts changed: the whole suite" || fail "vitest.config.ts: call='$CALL'"

R="$(new_repo tsconf)"; commit_change "$R" 'echo "{}" > tsconfig.json'
run_in "$R"
[ "$CALL" = "run" ] && pass "tsconfig.json changed: the whole suite" || fail "tsconfig.json: call='$CALL'"

R="$(new_repo lock)"; commit_change "$R" 'echo "{}" > package-lock.json'
run_in "$R"
[ "$CALL" = "run" ] && pass "package-lock.json changed: the whole suite" || fail "package-lock.json: call='$CALL'"

R="$(new_repo nested)"; commit_change "$R" 'mkdir -p docs/sub && echo "{}" > docs/sub/package.json'
run_in "$R"
[ -z "$CALL" ] && pass "a package.json elsewhere in the tree is not the root one: skipped" || fail "nested package.json: call='$CALL'"

R="$(new_repo failing)"; commit_change "$R" 'echo "export const b = 2" >> src/a.ts'
export STUB_EXIT=1; run_in "$R"; unset STUB_EXIT
[ "$RC" -eq 1 ] && pass "a failing vitest run fails the step (exit code passes through)" || fail "failing run: rc=$RC"

OUT="$(cd "$TMPDIR_BASE" && bash "$SCRIPT" 2>&1)"; RC=$?
[ "$RC" -eq 2 ] && pass "no base sha: usage error, exit 2" || fail "no base sha: rc=$RC"

echo ""
echo "ci-vitest-related: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
