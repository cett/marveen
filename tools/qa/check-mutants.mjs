#!/usr/bin/env node
// Self-test of the await-mutants mutant list (fails the build): builds a throwaway git repository with two
// commits and checks that the list holds exactly the awaits the second commit ADDED to a source file, and that
// applying a mutant removes that one `await` and nothing else. No vitest run, so it is fast.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadTypeScript } from './lib/common.mjs'
import { applyMutant, listAwaitMutants } from './lib/mutants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(process.argv[2] ?? path.join(here, '..', '..'))
const ts = loadTypeScript(repoRoot)

const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-check-mutants-'))
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
try {
  mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'qa@example.invalid')
  git('config', 'user.name', 'qa')
  const before = 'export async function a() {\n  const old = await load()\n  return old\n}\n'
  writeFileSync(path.join(dir, 'src/a.ts'), before)
  writeFileSync(path.join(dir, 'src/__tests__/a.test.ts'), 'export const t = 1\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')

  const after = before +
    'export async function b() {\n' +
    '  const x = await load()\n' +
    '  const y = (await load()).value\n' +
    '  for await (const z of stream()) { void z }\n' +
    '  return [x, y, await Promise.all([load()])]\n' +
    '}\n'
  writeFileSync(path.join(dir, 'src/a.ts'), after)
  writeFileSync(path.join(dir, 'src/__tests__/a.test.ts'), 'export const t = async () => { await load() }\n')
  git('add', '.')
  git('commit', '-qm', 'add awaits')

  const mutants = listAwaitMutants(ts, dir, base)
  const got = mutants.map((m) => `${m.file}:${m.line}:${m.snippet}`)
  const want = [
    'src/a.ts:6:await load()',
    'src/a.ts:7:await load()',
    'src/a.ts:9:await Promise.all([load()])',
  ]
  let failed = false
  const same = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${same ? 'OK  ' : 'FAIL'} mutant list: ${got.length} mutant(s), ${want.length} expected (the old await, the for-await and the test file are not mutants)`)
  if (!same) { console.log('  got:', got); console.log('  want:', want); failed = true }

  const second = mutants[1]
  const mutated = applyMutant(readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), second)
  const expected = after.replace('(await load()).value', '(load()).value')
  const applied = mutated === expected
  console.log(`${applied ? 'OK  ' : 'FAIL'} applyMutant removes exactly one await`)
  if (!applied) failed = true
  process.exit(failed ? 1 : 0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
