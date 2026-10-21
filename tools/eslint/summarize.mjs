// Prints the findings of an ESLint JSON report per rule and the files with the most findings, so the
// numbers (the input of the 1017 Phase 1 base wave) are in the CI log of every run.
//
//   node tools/eslint/summarize.mjs <eslint-json-file> [top-n]
//
// Exit code is always 0 (report mode). Messages without a rule id (the "inline config is ignored"
// notices of noInlineConfig) are not findings and are not counted.

import { readFileSync } from 'node:fs'

const [file, topArg] = process.argv.slice(2)
if (!file) {
  console.error('usage: node summarize.mjs <eslint-json-file> [top-n]')
  process.exit(2)
}
const top = Number(topArg) || 10
const report = JSON.parse(readFileSync(file, 'utf8'))

const perRule = new Map()
const perFile = new Map()
let fatal = 0
for (const f of report) {
  const rel = f.filePath.replace(/^.*?\/(src\/)/, '$1')
  for (const m of f.messages) {
    if (m.fatal) fatal += 1
    if (!m.ruleId) continue
    const rule = m.ruleId.replace('@typescript-eslint/', '')
    perRule.set(rule, (perRule.get(rule) ?? 0) + 1)
    const row = perFile.get(rel) ?? new Map()
    row.set(rule, (row.get(rule) ?? 0) + 1)
    perFile.set(rel, row)
  }
}

const total = [...perRule.values()].reduce((a, b) => a + b, 0)
console.log(`async lint report: ${total} finding(s) in ${perFile.size} of ${report.length} file(s)` + (fatal ? `, ${fatal} FATAL (parse/config error)` : ''))
for (const [rule, n] of [...perRule].sort((a, b) => b[1] - a[1])) console.log(`  ${rule.padEnd(24)} ${n}`)
const sum = (row) => [...row.values()].reduce((a, b) => a + b, 0)
console.log(`top ${top} files:`)
for (const [rel, row] of [...perFile].sort((a, b) => sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0])).slice(0, top)) {
  console.log(`  ${String(sum(row)).padStart(3)}  ${rel}  ${[...row].map(([r, n]) => `${r}=${n}`).join(' ')}`)
}
