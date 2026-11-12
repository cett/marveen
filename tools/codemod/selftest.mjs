#!/usr/bin/env node
// Self-test of the db codemod: runs it on tools/codemod/fixture/in (a copy in the OS temp dir) and compares the
// result with fixture/out. Also checks --dry-run (writes nothing), idempotence (a second run changes nothing) and the
// manual list. Run: node tools/codemod/selftest.mjs   (needs `npm ci --prefix tools/codemod` once)

import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const codemod = path.join(here, 'codemod.mjs')
const fixtureIn = path.join(here, 'fixture', 'in')
const fixtureOut = path.join(here, 'fixture', 'out')
const work = mkdtempSync(path.join(tmpdir(), 'db-codemod-selftest-'))
cpSync(fixtureIn, work, { recursive: true })

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok: ${label}`)
  else { failures += 1; console.log(`  FAIL: ${label} ${detail}`) }
}
const run = (extra) => execFileSync('node', [codemod, '--root', work, ...extra, 'src/db/widgets.ts', 'src/db/gadgets.ts'], { encoding: 'utf8' })
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8')
const files = (dir, base = dir) => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n)
  return statSync(p).isDirectory() ? files(p, base) : [path.relative(base, p)]
})

console.log('db codemod self-test')

const dry = run(['--dry-run'])
check(files(fixtureIn).every((f) => read(work, f) === read(fixtureIn, f)), '--dry-run writes nothing')
check(/\[dry-run\] functions converted: 12/.test(dry), 'dry-run summary counts the converted functions', dry.split('\n')[0])

const first = run([])
// the files of src/__tests__ belong to the --tests section below: the module run must leave them alone
const isTest = (f) => f.includes('__tests__')
for (const f of files(fixtureOut).filter((f) => !isTest(f))) check(read(work, f) === read(fixtureOut, f), `${f} matches the expected output`)
for (const f of files(fixtureIn).filter((f) => isTest(f) || !files(fixtureOut).includes(f))) check(read(work, f) === read(fixtureIn, f), `${f} stays byte for byte`)

for (const kind of ['callback-boundary', 'function-value', 'boot-synchronous', 'unsupported-db-use', 'skipped-blocked-function', 'unsupported-transaction-shape']) {
  check(first.includes(`MANUAL ${kind}`), `reports ${kind}`)
}
// The callback-safety rules: each of these callers must be reported and left untouched (the expected output keeps them).
// Without the rule a callback that expects a synchronous value would silently become async (a Promise array, a floating Promise).
for (const [line, why] of [['src/caller.ts:13', 'callback of forEach'], ['src/caller.ts:20', 'callback of map'], ['src/caller.ts:24', 'callback of setInterval'], ['src/caller.ts:29', 'callback expecting void'], ['src/caller.ts:33', 'callback of expect']]) {
  check(first.includes(`MANUAL callback-boundary: ${line}  ${why}`), `a ${why} is reported, not rewritten`)
}
check(first.includes('MANUAL unsupported-transaction-shape: src/db/widgets.ts'), 'an already-async transaction body is left alone')
check(first.includes('MANUAL skipped-blocked-function: src/db/widgets.ts'), 'a function with a stored statement is skipped as a whole')

const second = run([])
check(/functions converted: 0, awaits added: 0, files edited: 0, edits: 0/.test(second), 'a second run changes nothing (idempotent)', second.split('\n')[0])

// ---- --tests: the raw handle in the TEST files ------------------------------------------------------------------
console.log('--tests mode')
const workTests = mkdtempSync(path.join(tmpdir(), 'db-codemod-selftest-tests-'))
cpSync(fixtureIn, workTests, { recursive: true })
const testFiles = ['src/__tests__/sample.test.ts', 'src/__tests__/only-getdb.test.ts']
const runTests = (extra) => execFileSync('node', [codemod, '--root', workTests, '--tests', ...extra, ...testFiles], { encoding: 'utf8' })
const tdry = runTests(['--dry-run'])
check(testFiles.every((f) => read(workTests, f) === read(fixtureIn, f)), '--tests --dry-run writes nothing')
const tfirst = runTests([])
for (const f of testFiles) check(read(workTests, f) === read(fixtureOut, f), `${f} matches the expected output`)
check(tdry.split('\n')[0].replace('[dry-run] ', '') === tfirst.split('\n')[0], 'the dry-run counts equal the real run', tdry.split('\n')[0])
// each of these is left as it is and reported: the transaction shape is a manual decision, a thrown-error assertion on a
// converted call can never fail once it is async, and a describe body must stay synchronous
for (const [kind, line] of [['unsupported-db-use', 'sample.test.ts:29'], ['callback-boundary', 'sample.test.ts:33  callback of expect'], ['callback-boundary', 'sample.test.ts:38  callback of forEach'], ['unsupported-db-use', 'sample.test.ts:42'], ['callback-boundary', 'sample.test.ts:49  callback of describe']]) {
  check(tfirst.includes(`MANUAL ${kind}: src/__tests__/${line}`), `reports ${kind} at ${line}`)
}
const tsecond = runTests([])
check(/functions converted: 0, awaits added: 0, files edited: 0, edits: 0/.test(tsecond), 'a second --tests run changes nothing (idempotent)', tsecond.split('\n')[0])

console.log(failures === 0 ? 'codemod self-test OK' : `codemod self-test FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
