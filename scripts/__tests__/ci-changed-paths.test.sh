#!/bin/bash
# Contract tests for scripts/ci-changed-paths.sh (the step filter of the `gates` job and the job filter of `pg-parity`).
#
# Each cell builds a throwaway git repository with two commits, runs the script on their shas and compares the answer.
# The derivation of the `scripts` group is re-run here: every repo path that a Python or shell test reads as text must
# be answered `true` by the group, so a new test that reads a file this group does not cover turns the derivation cell red.
#
# Run: bash scripts/__tests__/ci-changed-paths.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CI_CHANGED_PATHS_BIN:-$INSTALL_DIR/scripts/ci-changed-paths.sh}"

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
REPO="$ROOT/repo"
mkdir -p "$REPO/src/__tests__/helpers" "$REPO/scripts"
cp "$SRC" "$REPO/ci-changed-paths.sh"
cat > "$REPO/src/__tests__/helpers/pg-modules.ts" <<'EOF'
export const PORTED: readonly string[] = [
  'src/__tests__/ported-example.test.ts',
]
EOF
git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@example.invalid -c user.name=t add -A
git -C "$REPO" -c user.email=t@example.invalid -c user.name=t commit -qm base
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"

# change <path>...: commit the given paths on top of base and echo the head sha
change() {
  local p
  for p in "$@"; do
    mkdir -p "$REPO/$(dirname "$p")"
    echo "x" >> "$REPO/$p"
  done
  git -C "$REPO" add -A
  git -C "$REPO" -c user.email=t@example.invalid -c user.name=t commit -qm "change" --allow-empty
  git -C "$REPO" rev-parse HEAD
}

# answer <group> <base> <head> [env...]: the script's answer, run from inside the throwaway repo
answer() {
  local group="$1" base="$2" head="$3"
  shift 3
  (cd "$REPO" && env -i PATH="$PATH" HOME="$HOME" "$@" bash ./ci-changed-paths.sh "$base" "$head" "$group")
}

# cell <expected> <name> <group> <base> <head> [env...]
cell() {
  local expected="$1" name="$2" group="$3" base="$4" head="$5"
  shift 5
  local got
  got="$(answer "$group" "$base" "$head" "$@")"
  if [ "$got" = "$expected" ]; then pass "$name"; else fail "$name" "$expected" "$got"; fi
}

# A throwaway head that changes only documentation
HEAD_DOCS="$(change docs/notes.md)"
cell false "docs only: the scripts group is skipped" scripts "$BASE_SHA" "$HEAD_DOCS"

# A scripts file
git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_SCRIPTS="$(change scripts/hooks/example-gate.py)"
cell true "one scripts file: the scripts group runs" scripts "$BASE_SHA" "$HEAD_SCRIPTS"

# A src file that a Python test reads (src/db.ts is in the derivation)
git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_SRC="$(change src/db.ts)"
cell true "a src file a Python test reads: the scripts group runs" scripts "$BASE_SHA" "$HEAD_SRC"

# An empty diff
cell false "empty diff: nothing runs" scripts "$BASE_SHA" "$BASE_SHA"

# No base: cannot compute, run it
cell true "no base: run it" scripts "" "$HEAD_DOCS"

# A zero sha (first push of a branch): run it
ZERO="0000000000000000000000000000000000000000"
cell true "zero sha base: run it" scripts "$ZERO" "$HEAD_DOCS"

# A push to develop always runs everything, even for docs only
cell true "push to develop: always run" scripts "$BASE_SHA" "$HEAD_DOCS" GITHUB_EVENT_NAME=push GITHUB_REF_NAME=develop

# pg group
git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_PG_DB="$(change src/db/tasks.ts)"
cell true "pg: a src/db file runs the PG parity" pg "$BASE_SHA" "$HEAD_PG_DB"

git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_PG_PORTED="$(change src/__tests__/ported-example.test.ts)"
cell true "pg: a PORTED test file runs the PG parity" pg "$BASE_SHA" "$HEAD_PG_PORTED"

git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_PG_CI="$(change .github/workflows/ci.yml)"
cell true "pg: a change to ci.yml runs the PG parity" pg "$BASE_SHA" "$HEAD_PG_CI"

cell false "pg: docs only is skipped" pg "$BASE_SHA" "$HEAD_DOCS"

cell true "pg: the ci-full label runs it on a docs-only change" pg "$BASE_SHA" "$HEAD_DOCS" CI_FULL_LABEL=1

# The script itself and its test: a change to either answers true for both groups (the decider never judges its own change).
git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_SELF="$(change scripts/ci-changed-paths.sh)"
cell true "pg: a change to the script itself runs the PG parity" pg "$BASE_SHA" "$HEAD_SELF"
git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_SELF="$(change scripts/ci-changed-paths.sh)"
cell true "scripts: a change to the script itself runs the scripts group" scripts "$BASE_SHA" "$HEAD_SELF"
git -C "$REPO" reset -q --hard "$BASE_SHA"
HEAD_SELF_T="$(change scripts/__tests__/ci-changed-paths.test.sh)"
cell true "pg: a change to the script's test runs the PG parity" pg "$BASE_SHA" "$HEAD_SELF_T"

# Derivation: every repo path that a Python or shell test reads as text must run the scripts group.
DERIVED="$(cd "$INSTALL_DIR" && python3 - <<'PY'
import glob
import os
import re

root = os.getcwd()
files = glob.glob(os.path.join(root, "scripts", "__tests__", "*.test.py")) + glob.glob(os.path.join(root, "scripts", "__tests__", "*.test.sh"))
tok = re.compile(r"[\"']((?:src|docs|tools|scripts|web|\.github|migrations-pg|migrations)/[A-Za-z0-9_./-]+|CHANGELOG\.md|README\.md|package(?:-lock)?\.json|vitest[A-Za-z0-9_.-]*\.(?:ts|mjs)|docs/[A-Za-z0-9_./-]+)[\"']")
found = set()
for f in files:
    text = open(f, encoding="utf-8", errors="replace").read()
    for m in tok.finditer(text):
        p = m.group(1)
        if any(ch in p for ch in "*{}$"):
            continue
        if os.path.exists(os.path.join(root, p)) and not os.path.isdir(os.path.join(root, p)):
            found.add(p)
print("\n".join(sorted(found)))
PY
)"
COUNT=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  COUNT=$((COUNT + 1))
  git -C "$REPO" reset -q --hard "$BASE_SHA"
  H="$(change "$p")"
  cell true "derivation: a change to $p runs the scripts group" scripts "$BASE_SHA" "$H"
done <<EOF
$DERIVED
EOF
echo "  derivation covered $COUNT paths"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
