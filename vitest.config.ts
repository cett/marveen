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
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'dist/**'],
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
      // Ratchet floor re-measured after fixing the coverage block's placement
      // (previously the block sat outside `test`, so it never took effect --
      // the include/exclude filters above are now actually applied for the
      // first time, and the resulting numbers differ from the earlier,
      // unenforced thresholds measured under the default config).
      // Local baseline: statements 57.98%, branches 56.81%, functions 60.54%,
      // lines 59.12%. CI measures slightly lower (statements 57.6, branches
      // 56.64, functions 60.13, lines 58.77) -- environment variance ~0.35%.
      // The first enforced run failed on lines (58.77% < 59%), so the floor is
      // set ~1-1.8 points below the CI numbers: a real regression still fails
      // the gate, but normal cross-environment jitter does not. Ratchet up via
      // the coverage-to-85% card as tests are added.
      thresholds: {
        statements: 56,
        branches: 55,
        functions: 59,
        lines: 57,
      },
    },
  },
})
