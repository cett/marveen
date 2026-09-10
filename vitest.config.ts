import { defineConfig, configDefaults } from 'vitest/config'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'

// Resolve the main working tree root regardless of whether vitest is run from a
// git worktree in /tmp. `git rev-parse --git-common-dir` always returns the main
// repo's .git directory (absolute when called from a linked worktree, relative
// ".git" when called from the main tree). resolve() normalises both cases to an
// absolute path; dirname then strips the trailing /.git component.
// This value is injected as MARVEEN_SCRIPTS_DIR so that agent-scaffold.ts resolves
// hook-script paths to the real repo (not the /tmp worktree), keeping
// isUnsafeHookCommand from blocking every inject* call in tests. PROJECT_ROOT is
// deliberately left pointing at the worktree so agent-config lookups stay isolated.
const gitCommonDir = resolve(execSync('git rev-parse --git-common-dir').toString().trim())
const mainRepoRoot = dirname(gitCommonDir)

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
// dist/** is excluded so that `npm run build` (tsc) compiling tests into
// dist/__tests__/ does not cause vitest to double-run the compiled JS copies,
// which would fail (compiled tests import relative .ts sources that don't
// exist under dist/).
export default defineConfig({
  test: {
    env: {
      MARVEEN_SCRIPTS_DIR: mainRepoRoot,
    },
    // 'agents/**' and '.channels-config/**' are excluded because a shared working
    // tree (multiple fleet agents checking out worktrees/config under this repo
    // root) otherwise gets picked up by vitest's default glob, causing spurious
    // failures from other agents' Playwright/config files (#807).
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'dist/**', 'agents/**', '.channels-config/**'],
    // Default 5 s is too tight for DB-heavy tests in a fully-parallel suite run.
    // Affected tests pass in isolation; the timeout is a concurrency artefact.
    testTimeout: 15000,
    // `coverage` must live under `test` -- it was previously a top-level sibling
    // of `test`, which vitest 4.x silently ignores (no error, no warning), so
    // the configured thresholds never actually enforced. `npm run coverage`
    // always exited 0 regardless of the measured percentages.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // Only measure backend TypeScript; web/modules/*.js is browser-only JS
      // and cannot be instrumented by vitest (would show 0% and break the gate).
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'dist/**'],
      // Ratchet floor, re-measured for #751 (backend coverage -> 85%, one
      // feature branch for the whole gradual series -- Jonas's call, keep
      // adding steps here rather than opening a PR per module). Steps so
      // far: src/web/routes/fleet-q.ts, src/web/routes/docs.ts,
      // src/web/routes/agent-taskstate.ts, src/web/routes/fleet.ts
      // (export/import), src/web/routes/spans.ts, src/web/routes/status.ts,
      // src/web/routes/backups.ts, and (this step) src/web/routes/ideas.ts,
      // src/web/routes/profiles.ts, src/web/routes/connectors-hu.ts, all
      // 0% -> fully covered. Local baseline after this step: statements
      // 62.46%, branches 61.93%, functions 63.88%, lines 63.84%. Floor
      // bumped to match (still ~1.5-1.9 points of buffer below the measured
      // numbers) rather than bumped again for this small an increment per
      // step -- raise only once the level actually reached clearly supports
      // it, never round up ahead of the measurement. Ratchet up further as
      // more steps land in this branch.
      thresholds: {
        statements: 61,
        branches: 60,
        functions: 62,
        lines: 62,
      },
    },
  },
})
