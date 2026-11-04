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

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
export const BASELINE_PATH = path.join(here, 'tests-baseline.json')

/** @returns {{ counts: Map<string, number>, fatal: string[] }} key = "<repo-relative file>|<rule>" */
export function countFindings(report) {
  const counts = new Map()
  const fatal = []
  for (const file of report) {
    const rel = path.relative(root, file.filePath).split(path.sep).join('/')
    for (const m of file.messages) {
      if (m.fatal) fatal.push(`${rel}: ${m.message}`)
      if (!m.ruleId) continue
      const key = `${rel}|${m.ruleId.replace('@typescript-eslint/', '')}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return { counts, fatal }
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
  const { counts, fatal } = countFindings(JSON.parse(readFileSync(file, 'utf8')))
  if (fatal.length > 0) {
    console.error(`async lint ratchet: ${fatal.length} file(s) could not be linted (a type the linter cannot resolve hides findings):`)
    for (const line of fatal) console.error(`  ${line}`)
    process.exit(1)
  }
  if (flag === '--write') {
    writeFileSync(BASELINE_PATH, JSON.stringify(mapToBaseline(counts), null, 2) + '\n')
    console.log(`async lint ratchet: baseline written (${counts.size} file/rule pairs, ${[...counts.values()].reduce((a, b) => a + b, 0)} findings)`)
    return
  }
  const { regressions, improvements } = compare(counts, baselineToMap(JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))))
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  console.log(`async lint ratchet: ${total} finding(s) in ${new Set([...counts.keys()].map((k) => k.split('|')[0])).size} file(s), baseline ${BASELINE_PATH.replace(`${root}/`, '')}`)
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
