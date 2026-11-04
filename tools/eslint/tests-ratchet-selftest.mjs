// Self-test of tests-ratchet.mjs: the pure functions on synthetic eslint reports.
//   node tools/eslint/tests-ratchet-selftest.mjs      (exit 1 on the first failed expectation)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_PATH, DEFAULT_MIN_SHARE, baselineToMap, compare, countFindings, listTestFiles, mapToBaseline, minTestFiles, parseMinShare } from './tests-ratchet.mjs'

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
// the directory is src/__tests__ itself: another __tests__ directory, or a file merely named like one, is not a test file here
assert.equal(countFindings([{ filePath: abs('scripts/__tests__/x.test.ts'), messages: [] }]).testFiles, 0)
assert.equal(countFindings([{ filePath: abs('src/web/__tests__/x.test.ts'), messages: [] }]).testFiles, 0)
assert.equal(countFindings([{ filePath: abs('src/__tests__x/y.test.ts'), messages: [] }]).testFiles, 0)

// the share of the test files a report must hold: the threshold arithmetic and the value from the environment
assert.equal(minTestFiles(10, 0.5), 5)
assert.equal(minTestFiles(11, 0.5), 6, 'rounds up')
assert.equal(minTestFiles(10, 0), 0)
assert.equal(minTestFiles(10, 1), 10)
assert.equal(DEFAULT_MIN_SHARE, 0.5)
assert.equal(parseMinShare(undefined), 0.5)
assert.equal(parseMinShare(''), 0.5)
assert.equal(parseMinShare('0'), 0)
assert.equal(parseMinShare('0.75'), 0.75)
assert.equal(parseMinShare('1'), 1)
for (const bad of ['abc', '-0.1', '1.5', 'NaN', 'Infinity']) assert.equal(parseMinShare(bad), null, bad)
const onDisk = listTestFiles()
assert.ok(onDisk.length > 100, 'the test directory is listed')
assert.ok(onDisk.every((f) => f.startsWith('src/__tests__/') && f.endsWith('.ts') && !f.endsWith('.d.ts')))
assert.equal(new Set(onDisk).size, onDisk.length)

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
// exactly is built from the baseline itself, so these cases do not depend on what the baseline holds today. Every run
// reads and (with --write) rewrites a COPY of the baseline in the temp directory (TESTS_RATCHET_BASELINE): the
// committed tools/eslint/tests-baseline.json is never the target, even when a case (or a mutant of the script) writes.
const ratchetScript = fileURLToPath(new URL('./tests-ratchet.mjs', import.meta.url))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tests-ratchet-selftest-'))
try {
  const baselineCopy = path.join(tmp, 'tests-baseline.json')
  const committedBefore = readFileSync(BASELINE_PATH, 'utf8')
  const resetBaseline = () => writeFileSync(baselineCopy, committedBefore)
  resetBaseline()
  const run = (reportOrNull, flags = [], env = {}) => {
    const args = [ratchetScript]
    if (reportOrNull !== null) {
      const f = path.join(tmp, 'report.json')
      writeFileSync(f, JSON.stringify(reportOrNull))
      args.push(f)
    }
    return spawnSync(process.execPath, [...args, ...flags], { encoding: 'utf8', env: { ...process.env, TESTS_RATCHET_BASELINE: baselineCopy, TESTS_RATCHET_MIN_SHARE: '', ...env } })
  }
  const clean = { filePath: abs('src/__tests__/zz-selftest-clean.test.ts'), messages: [] }
  const baselineEntries = Object.entries(JSON.parse(committedBefore)).map(([file, rules]) => ({
    filePath: abs(file),
    messages: Object.entries(rules).flatMap(([rule, n]) => Array.from({ length: n }, () => finding(rule))),
  }))
  // every test file on disk is in the report, the ones in the baseline with their findings: a complete lint run
  const inBaseline = new Set(baselineEntries.map((e) => path.relative(root, e.filePath).split(path.sep).join('/')))
  const cleanOnDisk = onDisk.filter((f) => !inBaseline.has(f)).map((f) => ({ filePath: abs(f), messages: [] }))
  const atBaseline = [...baselineEntries, ...cleanOnDisk, clean]

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
  assert.equal(run([], ['--write']).status, 1, '--write on an empty report fails')
  assert.equal(readFileSync(baselineCopy, 'utf8'), committedBefore, 'the baseline is untouched')
  // a __tests__ directory elsewhere is not the tests of src
  const otherDir = run([{ filePath: abs('scripts/__tests__/x.test.ts'), messages: [] }])
  assert.equal(otherDir.status, 1, 'a test file outside src/__tests__ does not count')
  assert.match(otherDir.stderr, /no file under src\/__tests__/)

  // a partial lint (a few test files, or a third of them) is not "zero findings" for the rest
  const partial = run([clean, ...cleanOnDisk.slice(0, 2)])
  assert.equal(partial.status, 1, 'a report with 3 test files fails')
  assert.match(partial.stderr, /holds 3 of the \d+ test files/)
  const need = minTestFiles(onDisk.length, DEFAULT_MIN_SHARE)
  const firstN = (n) => onDisk.slice(0, n).map((f) => ({ filePath: abs(f), messages: [] }))
  assert.equal(run(firstN(need)).status, 0, 'exactly the required number of test files passes')
  const oneShort = run(firstN(need - 1))
  assert.equal(oneShort.status, 1, 'one test file short fails')
  assert.match(oneShort.stderr, new RegExp(`holds ${need - 1} of the ${onDisk.length} test files`))
  // a partial report must not drop the rest from the baseline either
  assert.equal(run([clean, ...cleanOnDisk.slice(0, 2)], ['--write']).status, 1, '--write on a partial report fails')
  assert.equal(readFileSync(baselineCopy, 'utf8'), committedBefore, 'the baseline is untouched by a partial --write')
  // deleting or renaming a test (one file fewer than the disk) passes
  assert.equal(run(atBaseline.slice(0, -2)).status, 0, 'one test file fewer than on disk passes')

  // the threshold from the environment
  assert.equal(run([clean], [], { TESTS_RATCHET_MIN_SHARE: '0' }).status, 0, 'share 0 turns the check off')
  assert.equal(run(firstN(onDisk.length - 1), [], { TESTS_RATCHET_MIN_SHARE: '1' }).status, 1, 'share 1 wants every file')
  assert.equal(run(firstN(onDisk.length), [], { TESTS_RATCHET_MIN_SHARE: '1' }).status, 0, 'share 1 passes with every file')
  assert.equal(run(atBaseline, [], { TESTS_RATCHET_MIN_SHARE: 'half' }).status, 2, 'a share that is not a number is a usage error')
  assert.equal(run(atBaseline, [], { TESTS_RATCHET_MIN_SHARE: '2' }).status, 2, 'a share above 1 is a usage error')

  // --write: rewrites the baseline file named by TESTS_RATCHET_BASELINE, never the committed one
  writeFileSync(baselineCopy, '{}\n')
  const written = run(atBaseline, ['--write'])
  assert.equal(written.status, 0, '--write on a complete report succeeds')
  assert.equal(JSON.stringify(JSON.parse(readFileSync(baselineCopy, 'utf8'))), JSON.stringify(JSON.parse(committedBefore)), '--write wrote the findings of the report into the named file')
  assert.equal(readFileSync(BASELINE_PATH, 'utf8'), committedBefore, 'the committed baseline is untouched by --write')
  // the file named by the environment is the one that is read: an empty baseline makes every finding a regression
  writeFileSync(baselineCopy, '{}\n')
  assert.equal(run(atBaseline).status, 1, 'the baseline is read from the named file')
  resetBaseline()
  assert.equal(readFileSync(BASELINE_PATH, 'utf8'), committedBefore, 'the committed baseline is untouched')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('tests-ratchet selftest: ok')
