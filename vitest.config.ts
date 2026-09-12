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
      // src/web/routes/backups.ts, src/web/routes/ideas.ts,
      // src/web/routes/profiles.ts, src/web/routes/connectors-hu.ts,
      // src/web/routes/agent-conversation.ts, src/web/routes/agents-skills.ts,
      // src/web/routes/onboarding.ts (18% -> ~93%),
      // src/web/routes/background-tasks.ts (22.76% -> 72.35% statements,
      // covering the GET list/by-id, DELETE, validation, and
      // sweepOrphanedBackgroundTasks paths that only had 2 POST-error tests
      // before), and (this step) src/web/routes/tool-log.ts (40.74% -> 100%,
      // the GET recent-calls and GET analyze routes had zero route-level
      // tests -- only the POST/OTel-span write path was covered) and
      // src/web/routes/skill-usage.ts (58.36% file-level per the prior
      // measurement, but its own POST and GET-recent-rows routes had zero
      // route-level tests -- only summary/stats were covered plus
      // standalone schema tests that never call the handler; now 100%
      // statements / 97.14% branches), and (this step)
      // src/web/routes/updates.ts (28.96% -> 86.89% statements / 86.95%
      // branches -- GET /api/updates, GET /api/updates/status,
      // POST /api/updates/diagnose, and every previously-untested
      // POST /api/updates/apply branch (lock-write-failed, EEXIST retry-race
      // vs retry-lock-write-failed, preflight crash, dirty-tree+autoStash,
      // store-unwritable, the happy path, and the async spawn error handler)
      // now have route-level tests; only the pf/git inline closures passed
      // into the already-mocked checkNoConcurrentUpdate/checkUpdatePreflight
      // remain uncovered by design, since those are dead code paths from
      // this file's own tests' point of view). Local baseline after this
      // step: statements 65.19%, branches 64.51%, functions 65.63%,
      // lines 66.61%. Floor left UNCHANGED that step: updates.ts is only
      // 302 of ~24.5k total statements, so even its ~58-point jump moved the
      // global baseline by well under half a point. And (this step)
      // src/web/routes/connectors.ts (26.6% -> 89.64% statements / 81.77%
      // branches -- the lowest-coverage route file left, and the largest at
      // 898 lines: GET /api/connectors (the full plugin/.mcp.json/mcp-list-
      // cache/agent/agent-project/external-project listing), connector
      // detail/add/delete/assign, external-paths and github-repos CRUD,
      // GET /api/mcp-catalog installed-detection (cache match + configMatch-
      // via-.mcp.json fallback), catalog install/uninstall success paths,
      // and the entire previously-untested Vault section -- secrets CRUD
      // with the admin-vs-tenant-scoped access guard, bindings (explicit
      // targets and serverName-derived targets), sync, scan, and import --
      // plus GET /api/ollama/models. atomic-write.js is mocked so success
      // paths that persist to disk (add/delete/assign) never touch the real
      // filesystem. Local baseline after this step: statements 66.61%,
      // branches 65.64%, functions 65.92%, lines 68.15% -- a materially
      // bigger jump than prior steps since connectors.ts is a large file, so
      // the floor moves up this time (a modest +1 on each metric, well
      // inside the buffer the fresh measurement leaves). Raise only once the
      // level actually reached clearly supports it, never round up ahead of
      // the measurement. Ratchet up further as more steps land in this
      // branch.
      thresholds: {
        statements: 64,
        branches: 63,
        functions: 64,
        lines: 65,
      },
    },
  },
})
