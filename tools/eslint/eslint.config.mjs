// Async-correctness rules for the 1017 Phase 1 rewrite (the db layer becomes async).
// REPORT MODE: every rule is a warning, so a finding never fails CI. They go to "error" in the
// Phase 1 base wave, once the findings of the current code are fixed.
//
// Type-aware (the rules need the types of the expressions): the project's tsconfig.json is used as is.
// Only src/ production code is linted; the tests are reported separately with --report-tests.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const withTests = process.env.ESLINT_ASYNC_TESTS === '1'

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
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/require-await': 'warn',
    },
  },
)
