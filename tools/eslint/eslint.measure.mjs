// One-off measurement (not part of the build): how many findings does typescript-eslint's
// no-unnecessary-condition give on production src/? Same parser setup as eslint.config.mjs.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/generated/**', '**/*.d.ts', '**/__tests__/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: root } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    rules: { '@typescript-eslint/no-unnecessary-condition': 'error' },
  },
)
