// Self-test of tests-ratchet.mjs: the pure functions on synthetic eslint reports.
//   node tools/eslint/tests-ratchet-selftest.mjs      (exit 1 on the first failed expectation)
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { baselineToMap, compare, countFindings, mapToBaseline } from './tests-ratchet.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const abs = (rel) => path.join(root, rel)
const finding = (ruleId, extra = {}) => ({ ruleId: `@typescript-eslint/${ruleId}`, message: ruleId, ...extra })

// counting: per (repo-relative file, rule), messages without a rule id are not findings
const report = [
  { filePath: abs('src/__tests__/a.test.ts'), messages: [finding('require-await'), finding('require-await'), { message: 'inline config ignored' }] },
  { filePath: abs('src/__tests__/b.test.ts'), messages: [finding('no-floating-promises')] },
  { filePath: abs('src/web/clean.ts'), messages: [] },
]
const { counts, fatal } = countFindings(report)
assert.deepEqual(fatal, [])
assert.equal(counts.get('src/__tests__/a.test.ts|require-await'), 2)
assert.equal(counts.get('src/__tests__/b.test.ts|no-floating-promises'), 1)
assert.equal(counts.size, 2)

// a parse error is reported as fatal (a file the linter cannot read hides its findings)
assert.equal(countFindings([{ filePath: abs('src/x.ts'), messages: [{ fatal: true, message: 'boom' }] }]).fatal.length, 1)

// baseline round trip
const baseline = { 'src/__tests__/a.test.ts': { 'require-await': 2 } }
assert.deepEqual(mapToBaseline(baselineToMap(baseline)), baseline)

// a new floating promise in a file that is not in the baseline is a regression
let r = compare(counts, baselineToMap(baseline))
assert.equal(r.regressions.length, 1)
assert.match(r.regressions[0], /b\.test\.ts {2}no-floating-promises: 1 \(baseline 0\)/)
assert.deepEqual(r.improvements, [])

// one more finding in a file that is in the baseline is a regression
r = compare(new Map([['src/__tests__/a.test.ts|require-await', 3]]), baselineToMap(baseline))
assert.equal(r.regressions.length, 1)

// the same or fewer findings pass; fewer is reported as an improvement to lock in
r = compare(new Map([['src/__tests__/a.test.ts|require-await', 2]]), baselineToMap(baseline))
assert.deepEqual(r, { regressions: [], improvements: [] })
r = compare(new Map(), baselineToMap(baseline))
assert.equal(r.regressions.length, 0)
assert.equal(r.improvements.length, 1)

console.log('tests-ratchet selftest: ok')
