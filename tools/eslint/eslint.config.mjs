// Async-correctness rules for the 1017 Phase 1 rewrite (the db layer becomes async).
// ERROR MODE for production src/ (Phase 1 base wave): a finding fails the build. The test files
// (ESLINT_ASYNC_TESTS=1) stay in report mode: the tests are rewritten module by module with the waves.
//
// Type-aware (the rules need the types of the expressions): the project's tsconfig.json is used as is.
// Only src/ production code is linted; ESLINT_ASYNC_TESTS=1 adds the tests.
//
// PHASE-OUT: this whole directory (tools/eslint/) exists only because typescript-eslint needs the classic
// TypeScript JS API (peer typescript <6.1.0) and the project builds with TypeScript 7, which does not ship it.
// As soon as typescript-eslint supports TypeScript 7, delete tools/eslint/, move these four rules into a root
// eslint config and drop the "Async lint" CI steps and the tools/eslint audit step. check-fixture.mjs guards
// against a silent false negative in the meantime (the CI step that runs it fails the build).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const withTests = process.env.ESLINT_ASYNC_TESTS === '1'
const severity = withTests ? 'warn' : 'error'

const requireAwaitContractFiles = [
  // ChannelProvider: every adapter method returns a Promise, the Telegram/Slack/Discord adapters just have no await yet.
  'src/channel-provider.ts',
  // Vector search/backfill: the same signature on the SQLite and the PostgreSQL (pgvector) backend, async by contract.
  'src/db/vector.ts',
  // RouteHandler = (ctx) => Promise<boolean> (src/web/routes/types.ts, RouteDispatcher awaits every handler).
  'src/web/routes/agent-conversation.ts',
  'src/web/routes/agent-tenant-guard.ts',
  'src/web/routes/audit-log.ts',
  'src/web/routes/claude-update.ts',
  'src/web/routes/docs.ts',
  'src/web/routes/homoglyphs.ts',
  'src/web/routes/overview.ts',
  'src/web/routes/profiles.ts',
  'src/web/routes/rbac-shadow-log.ts',
  'src/web/routes/recall.ts',
  'src/web/routes/static.ts',
  'src/web/routes/tenant-gate-status.ts',
  'src/web/routes/token-shadow.ts',
  // Startup hook: the caller chains .catch on the Promise; the body reaches the db, which the waves make awaited.
  'src/web/startup-reconciliation.ts',
]

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/generated/**', '**/*.d.ts', ...(withTests ? [] : ['**/__tests__/**'])],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: root,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    // Inline eslint-disable comments are ignored: this run only measures the four async rules, so a comment
    // for a rule that is not loaded here (import/first, ...) must not become an error, and a disable comment
    // must not hide a finding from the count.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-floating-promises': severity,
      '@typescript-eslint/no-misused-promises': severity,
      '@typescript-eslint/await-thenable': severity,
      '@typescript-eslint/require-await': severity,
    },
  },
  // require-await, files whose async is part of a contract. FILE-level on purpose: an inline comment would be
  // ignored (noInlineConfig) and must not be able to hide a finding anyway. An entry leaves this list when the
  // wave that moves the file's db calls onto the async facade gives its functions a real await.
  {
    files: requireAwaitContractFiles,
    rules: { '@typescript-eslint/require-await': 'off' },
  },
)
