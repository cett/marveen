#!/usr/bin/env bash
# Decides whether a group of CI steps must run for this change. Prints `true` or `false`.
#
# Usage: scripts/ci-changed-paths.sh <base-sha> <head-sha> <group>
#   group `scripts`: the Python and shell tests (the step-level filter of the `gates` job).
#   group `pg`:      the PostgreSQL parity job (the job-level filter of `pg-parity`).
#
# Fail-safe: the answer is `true` whenever it cannot be computed (no base, a zero sha on a first push, a shallow
# clone without the base, a failing diff). A skipped check must never be a guess; the cost of a wrong `true` is minutes.
#
# Always `true` on a push to develop (the full run is the safety net after a merge), and `true` for the `pg` group when
# the pull request carries the label `ci-full` (CI_FULL_LABEL=1, set by the workflow from the event payload).
#
# Derivation of the `scripts` group (kept in step with the tests by scripts/__tests__/ci-changed-paths.test.sh, which
# re-derives the list from the Python and shell tests and fails on any path a test reads that this group does not cover):
#   - the gate code and its tooling: scripts/**, tools/**, .github/**, and the package files
#   - the repo files that the Python tests read as text: CHANGELOG.md, README.md, docs/openapi.yaml, vitest.config.ts,
#     web/** (the i18n and error-message modules), src/__tests__/** (the vitest guard reads the test tree), and the
#     src/ files named by the ratchets and the static checks (listed below).
#
# The `pg` group: src/db/**, src/migrations*/**, src/__tests__/pg/**, src/__tests__/helpers/**, every test file named in
# the PORTED list of src/__tests__/helpers/pg-modules.ts (parsed here, not copied), vitest.pg*.config.ts, the package
# files, and .github/workflows/ci.yml.

set -u

base="${1:-}"
head="${2:-}"
group="${3:-}"

yes() { echo true; exit 0; }
no() { echo false; exit 0; }

case "$group" in
  scripts|pg) ;;
  *) yes ;;
esac

# A push to develop runs everything (the safety net after a merge).
if [ "${GITHUB_EVENT_NAME:-}" = "push" ] && [ "${GITHUB_REF_NAME:-}" = "develop" ]; then
  yes
fi

# The label that asks for the full PG run on a pull request.
if [ "$group" = "pg" ] && [ "${CI_FULL_LABEL:-0}" = "1" ]; then
  yes
fi

# No base, or a zero sha (a first push of a branch): the diff cannot be computed, run it.
case "$base" in ""|*[!0]*) ;; *) yes ;; esac
[ -n "$head" ] || yes
[ -n "$base" ] || yes

files=$(git diff --name-only "$base...$head" 2>/dev/null) || yes
[ -n "$files" ] || no

in_scripts_group() {
  case "$1" in
    scripts/*|tools/*|.github/*|package.json|package-lock.json) return 0 ;;
    vitest.config.ts|CHANGELOG.md|README.md|docs/openapi.yaml) return 0 ;;
    web/*|src/__tests__/*) return 0 ;;
    src/agent-tokens.ts|src/api-error-catalog.ts|src/channel-coordinator-main.ts|src/config.ts) return 0 ;;
    src/db-migrations.ts|src/db.ts|src/db/tasks.ts|src/generated/api.ts|src/otel-signals.ts) return 0 ;;
    src/pane-state.ts|src/security/secret-gate.ts|src/skill-sync.ts|src/web/routes/static.ts) return 0 ;;
    src/web/update-checker.ts) return 0 ;;
  esac
  return 1
}

in_pg_group() {
  case "$1" in
    src/db/*|src/migrations*/*|src/__tests__/pg/*|src/__tests__/helpers/*) return 0 ;;
    vitest.pg*.config.ts|package.json|package-lock.json|.github/workflows/ci.yml) return 0 ;;
    # the PostgreSQL restore drill and its test (the test lives under scripts/, outside the PG test directory)
    scripts/pg-restore-drill.sh|scripts/__tests__/pg-restore-drill.pg.test.ts) return 0 ;;
  esac
  # the PORTED list of the PG harness, parsed from the BASE (a pull request cannot shorten its own list)
  if [ -z "${PORTED_LIST:-}" ]; then
    PORTED_LIST=$(git show "$base:src/__tests__/helpers/pg-modules.ts" 2>/dev/null | sed -n '/PORTED: readonly string\[\] = \[/,/^\];/p' | grep -o "'[^']*'" | tr -d "'")
  fi
  printf '%s\n' "$PORTED_LIST" | grep -qxF "$1" && return 0
  return 1
}

while IFS= read -r f; do
  [ -n "$f" ] || continue
  # A change to this script or to its test answers true for both groups: the rule that decides the run is never
  # decided by the change it judges (the workflow also runs the base copy, see ci.yml).
  case "$f" in
    scripts/ci-changed-paths.sh|scripts/__tests__/ci-changed-paths.test.sh) yes ;;
  esac
  case "$group" in
    scripts) in_scripts_group "$f" && yes ;;
    pg) in_pg_group "$f" && yes ;;
  esac
done <<EOF
$files
EOF

no
