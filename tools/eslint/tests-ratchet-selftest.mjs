// Self-test of tests-ratchet.mjs: the pure functions on synthetic eslint reports.
//   node tools/eslint/tests-ratchet-selftest.mjs      (exit 1 on the first failed expectation)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_PATH, baselineToMap, compare, countFindings, mapToBaseline } from './tests-ratchet.mjs'

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
// only files under src/__tests__ count as test files, with or without findings
assert.equal(countFindings(report).testFiles, 2)
assert.equal(countFindings([{ filePath: abs('src/__tests__/clean.test.ts'), messages: [] }]).testFiles, 1)
assert.equal(countFindings([]).testFiles, 0)
assert.equal(countFindings([{ filePath: abs('src/web/clean.ts'), messages: [] }]).testFiles, 0)

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

// the command line: the exit code of main() on a real report file. The report that matches the committed baseline
// exactly is built from the baseline itself, so these cases do not depend on what the baseline holds today.
const ratchetScript = fileURLToPath(new URL('./tests-ratchet.mjs', import.meta.url))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tests-ratchet-selftest-'))
try {
  const run = (reportOrNull, ...flags) => {
    const args = [ratchetScript]
    if (reportOrNull !== null) {
      const f = path.join(tmp, 'report.json')
      writeFileSync(f, JSON.stringify(reportOrNull))
      args.push(f)
    }
    return spawnSync(process.execPath, [...args, ...flags], { encoding: 'utf8' })
  }
  const clean = { filePath: abs('src/__tests__/zz-selftest-clean.test.ts'), messages: [] }
  const atBaseline = [
    ...Object.entries(JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))).map(([file, rules]) => ({
      filePath: abs(file),
      messages: Object.entries(rules).flatMap(([rule, n]) => Array.from({ length: n }, () => finding(rule))),
    })),
    clean,
  ]
  const baselineBefore = readFileSync(BASELINE_PATH, 'utf8')

  assert.equal(run(null).status, 2, 'no report file: usage, exit 2')
  assert.equal(run(atBaseline).status, 0, 'a report equal to the baseline passes')
  assert.equal(run([...atBaseline.slice(0, -1), { ...clean, messages: [finding('no-floating-promises')] }]).status, 1, 'a new finding fails')
  assert.equal(run([...atBaseline, { filePath: abs('src/__tests__/zz-selftest-fatal.test.ts'), messages: [{ fatal: true, message: 'boom' }] }]).status, 1, 'a file that could not be linted fails')

  // fail closed: a report that says nothing about the tests is not "zero findings"
  const empty = run([])
  assert.equal(empty.status, 1, 'an empty report fails')
  assert.match(empty.stderr, /no file under src\/__tests__/)
  const noTests = run([{ filePath: abs('src/web/clean.ts'), messages: [] }, { filePath: abs('scripts/x.mjs'), messages: [] }])
  assert.equal(noTests.status, 1, 'a report with no test file fails')
  assert.match(noTests.stderr, /no file under src\/__tests__/)
  // --write on such a report must not wipe the baseline
  assert.equal(run([], '--write').status, 1, '--write on an empty report fails')
  assert.equal(readFileSync(BASELINE_PATH, 'utf8'), baselineBefore, 'the baseline is untouched')

  // a test that was deleted or renamed is a file missing from the report, not an empty report: other tests are there
  assert.equal(run([clean]).status, 0, 'a report with one clean test file passes (below the baseline is not a failure)')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('tests-ratchet selftest: ok')
