// Ratchet for the async-lint findings of the test files (ESLINT_ASYNC_TESTS=1).
//
// Why: a test that loses an `await` on the function under test stays green when its assertion is negative
// ("the main agent is not launched" holds on a run that has not got that far), so a dropped `await` only shows up as a
// no-floating-promises finding. The production code is linted in error mode; the tests were report-only and a new
// floating promise in a test went unnoticed. This ratchet fails the build when a (file, rule) pair has MORE findings
// than the baseline, or a file that is not in the baseline has any. It never fails on fewer: tighten the baseline with
// --write after a cleanup, so the improvement cannot be undone later.
//
//   node tools/eslint/tests-ratchet.mjs <eslint-json-file>           check (exit 1 on a regression)
//   node tools/eslint/tests-ratchet.mjs <eslint-json-file> --write   rewrite tools/eslint/tests-baseline.json
//
// The baseline holds findings only for no-misused-promises and require-await (style findings of the older tests).
// no-floating-promises and await-thenable are at ZERO in the tests and stay there: they are the dropped-`await` rules.
//
// The report must also cover the tests: it fails when it holds fewer than half of the .ts files under src/__tests__
// (a lint of one or two files would pass as "zero findings" and, with --write, drop the rest from the baseline).
// Half, not all: a deleted or renamed test must not fail the build.
//
// Environment (the self-test uses all three, so it never touches the committed baseline):
//   TESTS_RATCHET_BASELINE   baseline file to read and (with --write) rewrite; default tools/eslint/tests-baseline.json
//   TESTS_RATCHET_MIN_SHARE  share of the test files the report must hold, 0..1; default 0.5; 0 turns the check off;
//                            anything else is a usage error (exit 2), so a typo cannot switch the check off

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
export const BASELINE_PATH = path.join(here, 'tests-baseline.json')
export const DEFAULT_MIN_SHARE = 0.5
const TESTS_DIR = 'src/__tests__'

/** repo-relative paths of the .ts files under src/__tests__ (what the async lint covers there; .d.ts is ignored by it) */
export function listTestFiles(dir = path.join(root, TESTS_DIR)) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
    out.push(path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  }
  return out.sort()
}

/** the fewest test files a report must hold for `onDisk` files on disk and the required `share` (0..1) */
export function minTestFiles(onDisk, share) {
  return Math.ceil(onDisk * share)
}

/** @returns {number | null} the share from the environment value; null when it is not a number in 0..1 */
export function parseMinShare(raw) {
  if (raw === undefined || raw === '') return DEFAULT_MIN_SHARE
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}

/**
 * @returns {{ counts: Map<string, number>, fatal: string[], testFiles: number }} key = "<repo-relative file>|<rule>";
 * `testFiles` is the number of entries of the report that are files under src/__tests__ (with or without findings).
 */
export function countFindings(report) {
  const counts = new Map()
  const fatal = []
  let testFiles = 0
  for (const file of report) {
    const rel = path.relative(root, file.filePath).split(path.sep).join('/')
    if (rel.startsWith(`${TESTS_DIR}/`)) testFiles++
    for (const m of file.messages) {
      if (m.fatal) fatal.push(`${rel}: ${m.message}`)
      if (!m.ruleId) continue
      const key = `${rel}|${m.ruleId.replace('@typescript-eslint/', '')}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return { counts, fatal, testFiles }
}

/** baseline: { "<file>": { "<rule>": n } } -> Map in the same key shape as countFindings */
export function baselineToMap(baseline) {
  const map = new Map()
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, n] of Object.entries(rules)) map.set(`${file}|${rule}`, n)
  }
  return map
}

export function mapToBaseline(counts) {
  const out = {}
  for (const key of [...counts.keys()].sort()) {
    const [file, rule] = key.split('|')
    out[file] ??= {}
    out[file][rule] = counts.get(key)
  }
  return out
}

/** @returns {{ regressions: string[], improvements: string[] }} */
export function compare(counts, baselineMap) {
  const regressions = []
  const improvements = []
  for (const [key, n] of counts) {
    const was = baselineMap.get(key) ?? 0
    if (n > was) regressions.push(`${key.replace('|', '  ')}: ${n} (baseline ${was})`)
  }
  for (const [key, was] of baselineMap) {
    const n = counts.get(key) ?? 0
    if (n < was) improvements.push(`${key.replace('|', '  ')}: ${n} (baseline ${was})`)
  }
  return { regressions: regressions.sort(), improvements: improvements.sort() }
}

function main() {
  const [file, flag] = process.argv.slice(2)
  if (!file) {
    console.error('usage: node tests-ratchet.mjs <eslint-json-file> [--write]')
    process.exit(2)
  }
  const { counts, fatal, testFiles } = countFindings(JSON.parse(readFileSync(file, 'utf8')))
  if (fatal.length > 0) {
    console.error(`async lint ratchet: ${fatal.length} file(s) could not be linted (a type the linter cannot resolve hides findings):`)
    for (const line of fatal) console.error(`  ${line}`)
    process.exit(1)
  }
  // Fail closed: a report with no test file at all (an empty list, or only non-test files) proves nothing. It is what
  // a lint step that did not run over the tests produces, and it would pass as "zero findings" and, with --write,
  // wipe the baseline. A deleted or renamed test does not trip this: the other test files are still in the report.
  if (testFiles === 0) {
    console.error('async lint ratchet FAILED: the report holds no file under src/__tests__, so it says nothing about the tests (is the lint step linting src with ESLINT_ASYNC_TESTS=1?).')
    process.exit(1)
  }
  // A partial lint (a few test files) is not "zero findings" for the rest either. Checked before --write, so a
  // partial report cannot drop the other files from the baseline.
  const share = parseMinShare(process.env.TESTS_RATCHET_MIN_SHARE)
  if (share === null) {
    console.error(`async lint ratchet: TESTS_RATCHET_MIN_SHARE must be a number from 0 to 1, got "${process.env.TESTS_RATCHET_MIN_SHARE}".`)
    process.exit(2)
  }
  const onDisk = listTestFiles().length
  const needed = minTestFiles(onDisk, share)
  if (testFiles < needed) {
    console.error(`async lint ratchet FAILED: the report holds ${testFiles} of the ${onDisk} test files under ${TESTS_DIR} (at least ${needed} required, ${Math.round(share * 100)}%): a partial lint says nothing about the rest.`)
    process.exit(1)
  }
  const baselinePath = process.env.TESTS_RATCHET_BASELINE || BASELINE_PATH
  if (flag === '--write') {
    writeFileSync(baselinePath, JSON.stringify(mapToBaseline(counts), null, 2) + '\n')
    console.log(`async lint ratchet: baseline written (${counts.size} file/rule pairs, ${[...counts.values()].reduce((a, b) => a + b, 0)} findings)`)
    return
  }
  const { regressions, improvements } = compare(counts, baselineToMap(JSON.parse(readFileSync(baselinePath, 'utf8'))))
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  console.log(`async lint ratchet: ${total} finding(s) in ${new Set([...counts.keys()].map((k) => k.split('|')[0])).size} file(s), baseline ${baselinePath.replace(`${root}/`, '')}`)
  if (improvements.length > 0) {
    console.log(`${improvements.length} pair(s) below the baseline: run "node tools/eslint/tests-ratchet.mjs <report> --write" and commit the tighter baseline:`)
    for (const line of improvements) console.log(`  ${line}`)
  }
  if (regressions.length > 0) {
    console.error(`async lint ratchet FAILED: ${regressions.length} file/rule pair(s) above the baseline.`)
    console.error('A no-floating-promises finding in a test is a dropped `await`: add it. Do not raise the baseline for it.')
    for (const line of regressions) console.error(`  ${line}`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
