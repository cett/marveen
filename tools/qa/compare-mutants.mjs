#!/usr/bin/env node
// Validation of the parallel sweep: two await-mutants reports of the same base..HEAD (for example --workers 1
// and --workers 4) must classify every mutant the same way. Exit 1 on any difference.
//   node tools/qa/compare-mutants.mjs serial.json parallel.json
import { readFileSync } from 'node:fs'
import process from 'node:process'

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')))
if (!a || !b) {
  process.stderr.write('usage: compare-mutants.mjs <report-a.json> <report-b.json>\n')
  process.exit(2)
}
const key = (m) => `${m.file}:${m.line} ${m.snippet}`
const mapB = new Map(b.mutants.map((m) => [key(m), m]))
let diffs = 0
for (const m of a.mutants) {
  const o = mapB.get(key(m))
  if (!o) { console.log(`only in A: ${key(m)}`); diffs++; continue }
  if (o.status !== m.status) { console.log(`DIFF ${key(m)}: A=${m.status} B=${o.status}`); diffs++ }
  mapB.delete(key(m))
}
for (const k of mapB.keys()) { console.log(`only in B: ${k}`); diffs++ }
console.log(`A: ${a.workers} worker(s), ${a.wallSeconds}s, ${JSON.stringify(a.summary)}`)
console.log(`B: ${b.workers} worker(s), ${b.wallSeconds}s, ${JSON.stringify(b.summary)}`)
console.log(diffs === 0 ? 'SAME: every mutant has the same status' : `DIFFERENT: ${diffs} difference(s)`)
process.exit(diffs === 0 ? 0 : 1)
