#!/usr/bin/env bash
# CI helper: run vitest on a pull request, but only for what the PR touches.
#
# The full vitest suite runs on every push to develop (the Coverage step of the test job); on a pull
# request that would make every PR wait for it, and without anything here a stale test only failed AFTER
# the merge. So a PR runs `vitest related` on the TypeScript files it changed: vitest follows the import
# graph and runs every test that reaches them (and the changed test files themselves).
#
#   changed files = merge-base(BASE_SHA, HEAD)..HEAD, added/copied/modified/renamed only
#   - nothing TypeScript/JavaScript among them (docs, shell, python, workflows): skip cleanly, exit 0
#   - vitest config/setup, package.json, the lockfile or a tsconfig changed: the whole suite (fallback;
#     the import graph cannot say what such a change reaches)
#   - otherwise: `vitest related <files> --run --passWithNoTests` (no test reaching the files is no failure)
#
# Usage: scripts/ci-vitest-related.sh <base-sha>
# VITEST_CMD overrides the runner (default `npx vitest`); the tests use it to record the call.

set -euo pipefail

BASE_SHA="${1:-}"
if [[ -z "${BASE_SHA}" ]]; then
  echo "usage: $0 <base-sha>" >&2
  exit 2
fi
VITEST_CMD="${VITEST_CMD:-npx vitest}"

MERGE_BASE="$(git merge-base "${BASE_SHA}" HEAD)"
CHANGED="$(git diff --name-only --diff-filter=ACMR "${MERGE_BASE}" HEAD)"

if [[ -z "${CHANGED}" ]]; then
  echo "ci-vitest-related: no changed files, skipping."
  exit 0
fi

# A change that decides how every test runs: no import graph can narrow it down.
if grep -qE '^(vitest\.(config|workspace|setup)[^/]*|vite\.config\.[^/]*|package\.json|package-lock\.json|tsconfig[^/]*\.json)$' <<<"${CHANGED}"; then
  echo "ci-vitest-related: test configuration or dependencies changed, running the whole suite."
  # shellcheck disable=SC2086
  exec ${VITEST_CMD} run
fi

# TypeScript/JavaScript sources and tests only; node_modules/dist never appear in a diff, agents/ is excluded by vitest.
FILES="$(grep -E '^(src|scripts|tests)/.*\.(ts|tsx|mts|cts|js|mjs|cjs)$' <<<"${CHANGED}" || true)"
if [[ -z "${FILES}" ]]; then
  echo "ci-vitest-related: no TypeScript or JavaScript among the changed files, skipping."
  exit 0
fi

echo "ci-vitest-related: running the tests that reach $(wc -l <<<"${FILES}" | tr -d ' ') changed file(s):"
sed 's/^/  /' <<<"${FILES}"
# One word per line -> the argument list (paths in this repo contain no spaces).
# shellcheck disable=SC2086
exec ${VITEST_CMD} related $(tr '\n' ' ' <<<"${FILES}") --run --passWithNoTests
