// Self-test of the async lint toolchain. Lints tools/eslint/fixture/cases.ts with the same four rules and the
// same parser, but against the fixture's own tsconfig, and compares the findings with the `// expect: <rule>`
// markers in the file. Any difference (a missed finding, an unexpected one, a parse error) exits 1.
//
// This step FAILS the build on purpose, unlike the lint of the project tree (report mode): its job is to catch
// a silent false negative, e.g. a type the linter's TypeScript cannot resolve while the real build stays green.
//
//   node tools/eslint/check-fixture.mjs

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import tseslint from 'typescript-eslint'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const fixture = path.join(here, 'fixture/cases.ts')
const fixtureTsconfig = path.join(here, 'fixture/tsconfig.json')

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { project: [fixtureTsconfig], tsconfigRootDir: repoRoot },
      },
      plugins: { '@typescript-eslint': tseslint.plugin },
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/require-await': 'error',
      },
    },
  ],
})

const expected = []
readFileSync(fixture, 'utf8').split('\n').forEach((line, i) => {
  const m = /\/\/ expect: ([a-z-]+)\s*$/.exec(line)
  if (m) expected.push(`${i + 1} ${m[1]}`)
})

const [result] = await eslint.lintFiles([fixture])
const actual = result.messages
  .filter((m) => m.ruleId || m.fatal)
  .map((m) => (m.fatal ? `${m.line} FATAL ${m.message}` : `${m.line} ${m.ruleId.replace('@typescript-eslint/', '')}`))

const sort = (a) => [...a].sort()
const missing = sort(expected).filter((e) => !actual.includes(e))
const unexpected = sort(actual).filter((a) => !expected.includes(a))

if (missing.length || unexpected.length || expected.length === 0) {
  console.error('async lint fixture check FAILED')
  if (expected.length === 0) console.error('  no `// expect:` marker found in the fixture')
  for (const m of missing) console.error(`  missed     (line rule): ${m}`)
  for (const u of unexpected) console.error(`  unexpected (line rule): ${u}`)
  console.error('A missed finding usually means a type did not resolve (is the root `npm ci` done? is the linter TypeScript supported?).')
  process.exit(1)
}
console.log(`async lint fixture check OK: ${expected.length} expected finding(s), nothing missed, nothing unexpected`)
