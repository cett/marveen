import { defineConfig } from 'vitest/config'

// The PostgreSQL tests (src/**/*.pg.test.ts, by convention in src/__tests__/pg/) need a throwaway server: MARVEEN_PG_TEST_URL, an admin URL (see
// src/__tests__/helpers/pg-test-db.ts). They run through `npm run test:pg` and the pg-parity CI job, never through
// the default `vitest run` (vitest.config.ts excludes the directory), so the default suite does not carry tests that
// skip when no server is there. A missing variable fails here, before any test, instead of skipping.
export default defineConfig({
  test: {
    include: ['src/**/*.pg.test.ts'],
    globalSetup: ['./src/__tests__/pg/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // one server, advisory-locked template builds: files may run in parallel, but keep it modest for a CI service container
    maxWorkers: 4,
  },
})
