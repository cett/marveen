import { defineConfig } from 'vitest/config'
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { PORTED, listUseTestDbFiles } from './src/__tests__/helpers/pg-modules.ts'

// The PostgreSQL MODULE run: the `useTestDb` test files of the PORTED list (src/__tests__/helpers/pg-modules.ts), in PG
// mode (MARVEEN_TEST_DB=pg). The same files also run in the default suite on SQLite, so a ported module is green on both
// backends. They need a throwaway server (MARVEEN_PG_TEST_URL); a missing one fails the run before any test, it does not skip.
//
// MARVEEN_PG_MODULES_ALL=1 runs EVERY useTestDb file instead of the ported list: the first-run / re-measure mode used to
// decide the order of the waves. The CI step never sets it.
const root = process.cwd()
const all = process.env.MARVEEN_PG_MODULES_ALL === '1'
// the same MARVEEN_SCRIPTS_DIR as the default config (the main working tree, also from a linked worktree), see vitest.config.ts
const mainRepoRoot = dirname(resolve(execSync('git rev-parse --git-common-dir').toString().trim()))

export default defineConfig({
  test: {
    include: all ? listUseTestDbFiles(root) : [...PORTED],
    // an empty ported list is a valid (early) state, not an error
    passWithNoTests: true,
    globalSetup: ['./src/__tests__/pg/global-setup.ts'],
    env: { MARVEEN_SCRIPTS_DIR: mainRepoRoot, MARVEEN_TEST_DB: 'pg' },
    testTimeout: 30000,
    hookTimeout: 60000,
    // one clone per test takes the template lock for a moment: a few workers, not all cores
    maxWorkers: 4,
  },
})
