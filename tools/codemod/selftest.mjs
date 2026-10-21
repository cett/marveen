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
check(/\[dry-run\] functions converted: 10/.test(dry), 'dry-run summary counts the converted functions', dry.split('\n')[0])

const first = run([])
for (const f of files(fixtureOut)) check(read(work, f) === read(fixtureOut, f), `${f} matches the expected output`)
for (const f of files(fixtureIn).filter((f) => !files(fixtureOut).includes(f))) check(read(work, f) === read(fixtureIn, f), `${f} stays byte for byte`)

for (const kind of ['callback-boundary', 'function-value', 'boot-synchronous', 'unsupported-db-use']) {
  check(first.includes(`MANUAL ${kind}`), `reports ${kind}`)
}

const second = run([])
check(/functions converted: 0, awaits added: 0, files edited: 0, edits: 0/.test(second), 'a second run changes nothing (idempotent)', second.split('\n')[0])

console.log(failures === 0 ? 'codemod self-test OK' : `codemod self-test FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
