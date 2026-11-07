// The contract of scripts/vault-http-header-helper.mjs as Claude Code sees it: stdout is the JSON and nothing
// else, a failure leaves stdout EMPTY and exits 1, and every outcome is appended to store/http-header-helper.log
// (Claude Code shows a helper's stderr nowhere) as a JSON line with the outcome and the secret id, never a value.
//
// The script is copied into a throwaway tree whose dist/web/http-mcp-header-helper.js is a STUB, so no vault is
// opened: the real vault shares one Keychain master key and must not be touched from a test.
//
// Privacy: neutral fixtures only; every secret value is invented.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/vault-http-header-helper.mjs', import.meta.url))
const VALUE = 'fixture-secret-value-0123456789'
let tree = ''

function stubCore(body: string) {
  mkdirSync(join(tree, 'dist', 'web'), { recursive: true })
  writeFileSync(join(tree, 'dist', 'web', 'http-mcp-header-helper.js'), body)
}
function run(args: string[]) {
  return spawnSync(process.execPath, [join(tree, 'scripts', 'vault-http-header-helper.mjs'), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: tree },
    encoding: 'utf-8',
  })
}
const logPath = () => join(tree, 'store', 'http-header-helper.log')
const logLines = () => (existsSync(logPath()) ? readFileSync(logPath(), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

const OK_CORE = `export function runHeaderHelper(argv) {
  return { code: 0, stdout: JSON.stringify({ Authorization: 'Bearer ${VALUE}', Loud: process.env.LOG_TO_STDERR }) + '\\n', event: { outcome: 'ok', secretId: 'fixture-secret-a' } }
}`
const FAIL_CORE = `export function runHeaderHelper() {
  return { code: 1, stdout: '', event: { outcome: 'unresolved', secretId: 'fixture-secret-a' } }
}`
const THROW_CORE = `export function runHeaderHelper() { throw new TypeError('boom ${VALUE}') }`

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), 'header-helper-script-'))
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'store'), { recursive: true })
  copyFileSync(SCRIPT, join(tree, 'scripts', 'vault-http-header-helper.mjs'))
})
afterEach(() => { rmSync(tree, { recursive: true, force: true }) })

describe('success', () => {
  it('stdout is exactly the core\'s JSON, exit 0, and the app logger is told to use stderr', () => {
    stubCore(OK_CORE)
    const r = run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${VALUE}`, Loud: '1' })
  })

  it('audits the read: one line with the outcome and the id, mode 0600, no value', () => {
    stubCore(OK_CORE)
    run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    const lines = logLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ outcome: 'ok', secretId: 'fixture-secret-a' })
    expect(typeof lines[0].ts).toBe('string')
    expect(readFileSync(logPath(), 'utf-8')).not.toContain(VALUE)
    expect(statSync(logPath()).mode & 0o777).toBe(0o600)
  })

  it('a log that cannot be written does not change the result', () => {
    stubCore(OK_CORE)
    rmSync(join(tree, 'store'), { recursive: true, force: true })
    const r = run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).Authorization).toBe(`Bearer ${VALUE}`)
  })

  it('a log over 512 KB is rotated once, the new one starts small', () => {
    stubCore(OK_CORE)
    writeFileSync(logPath(), 'x'.repeat(600 * 1024))
    run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    expect(existsSync(`${logPath()}.1`)).toBe(true)
    expect(statSync(logPath()).size).toBeLessThan(1024)
  })
})

describe('fail closed', () => {
  it('a failing core: exit 1, stdout EMPTY, the outcome is logged', () => {
    stubCore(FAIL_CORE)
    const r = run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'unresolved', secretId: 'fixture-secret-a' })])
  })

  it('a core that throws: exit 1, stdout empty, logged as helper-error with the error NAME only', () => {
    stubCore(THROW_CORE)
    const r = run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'helper-error', secretId: 'fixture-secret-a', error: 'TypeError' })])
    expect(readFileSync(logPath(), 'utf-8')).not.toContain(VALUE)
  })

  it('no dist/ at all: exit 1, stdout empty, logged as dist-missing with the id', () => {
    const r = run(['--secret', 'fixture-secret-a', '--header', 'Authorization'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'dist-missing', secretId: 'fixture-secret-a' })])
  })

  it('no dist/ and a malformed id: logged, but the malformed text is not written', () => {
    const r = run(['--secret', 'x"; rm -rf /', '--header', 'Authorization'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    const [line] = logLines()
    expect(line.outcome).toBe('dist-missing')
    expect(line).not.toHaveProperty('secretId')
    expect(readFileSync(logPath(), 'utf-8')).not.toContain('rm -rf')
  })
})
