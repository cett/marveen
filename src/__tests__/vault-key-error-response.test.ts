import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// A vault whose master key cannot be established SAFELY throws VaultKeyError. The top-level request handler used to
// answer that as the generic 500 internal_error ("Szerver hiba"), so the client could not tell "operator must restore
// the vault key" from a bug. It is now 503 vault_key_unavailable with a FIXED hint. These tests drive the REAL vault
// module into each of its VaultKeyError sites and read the answer over a real HTTP socket, so the status, the token
// and the "no path / count / snippet / secret in the body" property are observed, not assumed.

const here = dirname(fileURLToPath(import.meta.url))

const tmpRoot = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return mkdtempSync(join(tmpdir(), 'vaultkeyresp-test-'))
})

const keychainMock = vi.hoisted(() => ({
  available: true,
  readResult: { status: 'empty' as 'ok' | 'empty' | 'unavailable', value: null as string | null },
}))

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, STORE_DIR: `${tmpRoot}/store` }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => keychainMock.available,
  keychainRetrieveStatus: () => ({ ...keychainMock.readResult }),
  keychainRetrieve: () => keychainMock.readResult.value,
  keychainStore: () => undefined,
  keychainDelete: () => true,
}))

const storeDir = join(tmpRoot, 'store')
const vaultPath = join(storeDir, 'vault.json')
const keyPath = join(storeDir, '.vault-key')

const SECRET_VALUE = 'probe-value-42'
// Goes into vault.json as junk; JSON.parse errors can quote a piece of the source, which must never reach a client.
const JUNK_MARKER = 'JUNKSNIPPET-do-not-leak'

type Mods = {
  vault: typeof import('../web/vault.js')
  resp: typeof import('../web/vault-error-response.js')
  helpers: typeof import('../web/http-helpers.js')
}

// One module graph per call: vi.resetModules() makes a fresh VaultKeyError class, so the helper under test and the
// vault must come from the SAME graph or instanceof would compare two different classes.
async function freshModules(): Promise<Mods> {
  vi.resetModules()
  const vault = await import('../web/vault.js')
  const resp = await import('../web/vault-error-response.js')
  const helpers = await import('../web/http-helpers.js')
  return { vault, resp, helpers }
}

let server: http.Server | null = null

async function serve(mods: Mods, op: () => unknown): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  // The same shape as the catch in web.ts: the vault helper first, then the generic 500.
  server = http.createServer((_req, res) => {
    void (async () => {
      try {
        await op()
        mods.helpers.json(res, { ok: true })
      } catch (err) {
        if (mods.resp.answerVaultKeyError(err, res)) return
        mods.helpers.json(res, { error: 'internal_error', hint: 'Szerver hiba' }, 500)
      }
    })()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const r = await fetch(`http://127.0.0.1:${port}/`)
  const text = await r.text()
  return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> }
}

function resetStore() {
  rmSync(storeDir, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })
  keychainMock.available = true
  keychainMock.readResult = { status: 'empty', value: null }
  loggerMock.error.mockClear()
  loggerMock.warn.mockClear()
}

beforeEach(resetStore)
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
  rmSync(storeDir, { recursive: true, force: true })
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

// A real encrypted vault with one entry, made in file-key mode; returns the good key.
async function seedVault(): Promise<string> {
  keychainMock.available = false
  const m = await freshModules()
  m.vault.setSecret('probe', 'Probe secret', SECRET_VALUE)
  return readFileSync(keyPath, 'utf-8').trim()
}

// What a client must never learn from the answer.
function expectNothingLeaks(text: string, extra: string[] = []) {
  for (const needle of [SECRET_VALUE, JUNK_MARKER, 'vault-key', 'vault.json', 'store/', tmpRoot, 'entr(y/ies)', 'Keychain', ...extra]) {
    expect(text, `response leaks "${needle}"`).not.toContain(needle)
  }
}

function expectVaultKeyAnswer(r: { status: number; text: string; body: Record<string, unknown> }, hint: string) {
  expect(r.status).toBe(503)
  expect(r.body.error).toBe('vault_key_unavailable')
  expect(r.body.hint).toBe(hint)
  // Exactly the two fields: nothing added later by accident (no detail/message/path).
  expect(Object.keys(r.body).sort()).toEqual(['error', 'hint'])
}

describe('VaultKeyError -> 503 vault_key_unavailable (every real throw site)', () => {
  it('existing entries, key file missing (file mode) on a WRITE: setSecret', async () => {
    await seedVault()
    rmSync(keyPath, { force: true })
    const m = await freshModules()
    const r = await serve(m, () => m.vault.setSecret('other', 'Other', 'second-value-7'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text, ['second-value-7'])
  })

  it('existing entries, key file missing on a READ: getSecret', async () => {
    await seedVault()
    rmSync(keyPath, { force: true })
    keychainMock.available = false
    const m = await freshModules()
    const r = await serve(m, () => m.vault.getSecret('probe'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text)
  })

  it('Keychain did not answer (locked) with existing entries', async () => {
    await seedVault()
    rmSync(keyPath, { force: true })
    keychainMock.available = true
    keychainMock.readResult = { status: 'unavailable', value: null }
    const m = await freshModules()
    const r = await serve(m, () => m.vault.getSecret('probe'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text)
  })

  it('Keychain answered "no item" with existing entries (the isolated-instance-with-live-vault-copy case)', async () => {
    await seedVault()
    rmSync(keyPath, { force: true })
    keychainMock.available = true
    keychainMock.readResult = { status: 'empty', value: null }
    const m = await freshModules()
    const r = await serve(m, () => m.vault.listSecrets().length && m.vault.getSecret('probe'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text)
  })

  it('a wrong .vault-key that does not open vault.json', async () => {
    await seedVault()
    writeFileSync(keyPath, Buffer.from('not-the-real-master-key-material').toString('base64'))
    keychainMock.available = true
    const m = await freshModules()
    const r = await serve(m, () => m.vault.getSecret('probe'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text)
  })

  it('vault.json exists but cannot be parsed: the parser snippet stays out of the body', async () => {
    writeFileSync(vaultPath, `{ "entries": [ ${JUNK_MARKER} ] `)
    keychainMock.available = false
    const m = await freshModules()
    // A write: getSecret reads the file leniently (unreadable = no such secret), the key decision is strict.
    const r = await serve(m, () => m.vault.setSecret('other', 'Other', 'second-value-7'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text, ['second-value-7'])
    // ...but the operator still gets the cause in the log.
    const logged = loggerMock.error.mock.calls.map((c) => String((c[0] as { err?: Error }).err?.message ?? '')).join('\n')
    expect(logged).toContain('cannot be read or parsed')
  })

  it('a corrupt (too short) vault entry', async () => {
    const goodKey = await seedVault()
    const store = JSON.parse(readFileSync(vaultPath, 'utf-8')) as { entries: Array<{ encrypted: string }> }
    store.entries[0].encrypted = Buffer.from('tiny').toString('base64')
    writeFileSync(vaultPath, JSON.stringify(store))
    keychainMock.available = false
    const m = await freshModules()
    const r = await serve(m, () => m.vault.getSecret('probe'))
    expectVaultKeyAnswer(r, m.resp.VAULT_KEY_UNAVAILABLE_HINT)
    expectNothingLeaks(r.text, [goodKey])
  })

  it('the full error (paths, counts) is logged server-side, with a stable event name', async () => {
    await seedVault()
    rmSync(keyPath, { force: true })
    keychainMock.available = false
    const m = await freshModules()
    await serve(m, () => m.vault.getSecret('probe'))
    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    const [fields] = loggerMock.error.mock.calls[0] as [{ err: Error; event: string }]
    expect(fields.event).toBe('vault-key-unavailable')
    expect(fields.err.name).toBe('VaultKeyError')
    expect(fields.err.message).toContain('.vault-key')
  })
})

describe('everything else stays what it was', () => {
  it('control: with the good key the same call succeeds (the 503 is not unconditional)', async () => {
    await seedVault()
    keychainMock.available = false
    const m = await freshModules()
    const r = await serve(m, () => {
      expect(m.vault.getSecret('probe')).toBe(SECRET_VALUE)
    })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(loggerMock.error).not.toHaveBeenCalled()
  })

  it.each([
    ['a plain Error', () => new Error('boom')],
    ['a TypeError', () => new TypeError('x is undefined')],
    ['a SyntaxError', () => new SyntaxError('bad json')],
    // A lookalike must not be promoted: only the real class is a vault key failure.
    ['an object that only claims the name', () => Object.assign(new Error('fake'), { name: 'VaultKeyError' })],
    ['a plain object', () => ({ name: 'VaultKeyError', message: 'fake' })],
    ['a string', () => 'VaultKeyError'],
    ['undefined', () => undefined],
  ])('%s is NOT answered as vault_key_unavailable (stays 500 internal_error)', async (_label, make) => {
    const m = await freshModules()
    const r = await serve(m, () => { throw make() })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('internal_error')
    expect(loggerMock.error).not.toHaveBeenCalled()
  })

  it('answerVaultKeyError returns false and writes nothing for a non-vault error', async () => {
    const m = await freshModules()
    const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn(), headersSent: false } as unknown as http.ServerResponse
    expect(m.resp.answerVaultKeyError(new Error('x'), res)).toBe(false)
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('the hint is a fixed text with no path, no count, no key name (a regression pin on the constant itself)', async () => {
    const m = await freshModules()
    const hint = m.resp.VAULT_KEY_UNAVAILABLE_HINT
    expect(hint.length).toBeGreaterThan(20)
    expect(hint.length).toBeLessThan(200)
    expectNothingLeaks(hint)
    expect(hint).not.toMatch(/[/\\]/)
    expect(hint).not.toMatch(/\d/)
  })
})

describe('web.ts wiring (the helper is useless unless the top-level catch calls it)', () => {
  const src = readFileSync(join(here, '..', 'web.ts'), 'utf-8')

  it('imports the helper', () => {
    expect(src).toMatch(/import \{ answerVaultKeyError \} from '\.\/web\/vault-error-response\.js'/)
  })

  it('calls it in the top-level catch, after the JSON-body answer and BEFORE the generic internal_error', () => {
    const jsonBody = src.indexOf("if (isInvalidJsonBodyError(err, req))")
    const vault = src.indexOf('if (answerVaultKeyError(err, res)) return')
    const generic = src.indexOf("logger.error({ err }, 'Web szerver hiba')")
    expect(jsonBody).toBeGreaterThan(-1)
    expect(vault).toBeGreaterThan(jsonBody)
    expect(generic).toBeGreaterThan(vault)
  })
})
