#!/usr/bin/env node
// Self-test of the tools/qa scanners (fails the build): runs them over tools/qa/fixture and fails unless
// they report exactly the lines marked `// expect: <kind>` in the fixture, no more and no fewer. A scanner
// that silently stops seeing a construct (a TypeScript upgrade, a refactor) is caught here, not in review.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(process.argv[2] ?? path.join(here, '..', '..'))
const fixtureRel = path.relative(root, path.join(here, 'fixture'))

function listTs(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : []
  })
}

function expected(kindFilter) {
  const out = []
  for (const f of listTs(path.join(here, 'fixture', 'src'))) {
    readFileSync(f, 'utf8').split('\n').forEach((text, i) => {
      const m = /\/\/ expect: ([\w-]+)\s*$/.exec(text)
      if (m && kindFilter(f, m[1])) out.push(`${path.relative(root, f)}:${i + 1} ${m[1]}`)
    })
  }
  return out.sort()
}

function run(script, extra) {
  const out = execFileSync('node', [path.join(here, script), '--root', root, '--all', '--tsconfig', path.join(fixtureRel, 'tsconfig.json'), ...extra],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out).findings.map((f) => `${f.file}:${f.line} ${f.kind}`).sort()
}

const checks = [
  { name: 'promise-misuse-scan', actual: run('promise-misuse-scan.mjs', ['--src', path.join(fixtureRel, 'src')]), want: expected((f) => !f.includes('__tests__')) },
  { name: 'vacuous-notthrow-scan', actual: run('vacuous-notthrow-scan.mjs', []), want: expected((f) => f.includes('__tests__')) },
]

let failed = false
for (const c of checks) {
  const missing = c.want.filter((x) => !c.actual.includes(x))
  const extra = c.actual.filter((x) => !c.want.includes(x))
  const same = missing.length === 0 && extra.length === 0 && c.actual.length === c.want.length
  console.log(`${same ? 'OK  ' : 'FAIL'} ${c.name}: ${c.actual.length} finding(s), ${c.want.length} expected`)
  for (const m of missing) console.log(`  missing: ${m}`)
  for (const e of extra) console.log(`  unexpected: ${e}`)
  if (!same) failed = true
}
process.exit(failed ? 1 : 0)
