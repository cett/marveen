// Which `${NAME}` placeholders in an http MCP server's headers can be fed from a vault reference at launch, and
// the two shell fragments the launch command gets from that. Files are real (a temp dir); the vault is a stub
// that answers only "is this id there". Every secret value is an invented fixture.
//
// Privacy: neutral fixtures only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE_VALUE = 'fixture-secret-value-0123456789'
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => (id === 'fixture-secret-a' ? FIXTURE_VALUE : null) }))
vi.mock('../web/agent-process-session.js', () => ({
  shSingleQuote: (v: string) => `'${v.replace(/'/g, `'\\''`)}'`,
}))

import { collectHttpHeaderEnv, buildHttpHeaderLaunch } from '../web/http-mcp-header-env.js'

let dir = ''
const exists = (id: string) => id === 'fixture-secret-a' || id === 'fixture-secret-b'

function cfg(name: string, content: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
  return p
}
function http(headers: Record<string, unknown>, env?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'http', url: 'https://mcp.example.test/x', headers, ...(env ? { env } : {}), ...extra }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'http-header-env-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('collectHttpHeaderEnv: what is exported', () => {
  it('a placeholder with a vault reference in the same server env is exported by name and id', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ Authorization: 'Bearer ${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [{ name: 'FIXTURE_TOKEN', id: 'fixture-secret-a' }], skipped: [] })
  })

  it('the ${NAME:-default} form names the same variable', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ 'X-Key': '${FIXTURE_TOKEN:-none}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } })
    expect(collectHttpHeaderEnv([f], exists).exports).toEqual([{ name: 'FIXTURE_TOKEN', id: 'fixture-secret-a' }])
  })

  it('several placeholders in one value and in several headers each export once', () => {
    const f = cfg('a.json', { mcpServers: { s: http(
      { Authorization: 'Bearer ${FIXTURE_A}', 'X-Both': '${FIXTURE_A}-${FIXTURE_B}' },
      { FIXTURE_A: 'vault:fixture-secret-a', FIXTURE_B: 'vault:fixture-secret-b' },
    ) } })
    const names = collectHttpHeaderEnv([f], exists).exports.map(e => e.name).sort()
    expect(names).toEqual(['FIXTURE_A', 'FIXTURE_B'])
  })

  it('a vault reference with no placeholder using it exports nothing', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ Authorization: 'Bearer literal' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [] })
  })

  it('a name that is not a valid variable name is not a placeholder', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${1BAD}', B: '${}', C: '${A-B}' }, { '1BAD': 'vault:fixture-secret-a' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [] })
  })

  it('stdio servers and servers without headers are not this module\'s business', () => {
    const f = cfg('a.json', { mcpServers: {
      stdio: { command: 'node', args: [], env: { FIXTURE_TOKEN: 'vault:fixture-secret-a' }, headers: { A: '${FIXTURE_TOKEN}' } },
      bare: { type: 'http', url: 'https://mcp.example.test/y', env: { FIXTURE_TOKEN: 'vault:fixture-secret-a' } },
    } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [] })
  })

  it('a server with both a url and a command is ambiguous and left alone (fail closed)', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }, { command: 'node' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [] })
  })

  it('non-string header values are ignored', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: 5, B: null, C: ['${FIXTURE_TOKEN}'] }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [] })
  })

  it('the same variable bound to the same id in two files is one export', () => {
    const s = http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' })
    const f1 = cfg('a.json', { mcpServers: { s } })
    const f2 = cfg('b.json', { mcpServers: { t: s } })
    expect(collectHttpHeaderEnv([f1, f2], exists).exports).toEqual([{ name: 'FIXTURE_TOKEN', id: 'fixture-secret-a' }])
  })
})

describe('collectHttpHeaderEnv: what is refused (fail closed, by name and id, never a value)', () => {
  it('a placeholder with no vault reference is not exported', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: 'Bearer ${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'a-literal-value' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [{ name: 'FIXTURE_TOKEN', reason: 'no-vault-binding' }] })
  })

  it('a placeholder with no env entry at all is not exported', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: 'Bearer ${FIXTURE_TOKEN}' }) } })
    expect(collectHttpHeaderEnv([f], exists).skipped).toEqual([{ name: 'FIXTURE_TOKEN', reason: 'no-vault-binding' }])
  })

  it.each([
    ['empty id', 'vault:'],
    ['a space', 'vault:fixture secret'],
    ['a path', 'vault:../fixture-secret-a'],
    ['a quote that would end the shell string', "vault:x';touch-pwned;'"],
    ['a command substitution', 'vault:$(id)'],
    ['a newline', 'vault:fixture-secret-a\nFOO=bar'],
    ['129 characters', `vault:${'a'.repeat(129)}`],
  ])('a malformed id (%s) is not exported', (_label, ref) => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: ref }) } })
    expect(collectHttpHeaderEnv([f], () => true)).toEqual({ exports: [], skipped: [{ name: 'FIXTURE_TOKEN', reason: 'bad-id' }] })
  })

  it('128 characters is still a valid id', () => {
    const id = 'a'.repeat(128)
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: `vault:${id}` }) } })
    expect(collectHttpHeaderEnv([f], () => true).exports).toEqual([{ name: 'FIXTURE_TOKEN', id }])
  })

  it('an SSH private key is never put into a header', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:ssh-key-fixture' }) } })
    expect(collectHttpHeaderEnv([f], () => true)).toEqual({ exports: [], skipped: [{ name: 'FIXTURE_TOKEN', id: 'ssh-key-fixture', reason: 'ssh-key' }] })
  })

  it('an id that is not in the vault is skipped and reported with the id', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-missing' }) } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [{ name: 'FIXTURE_TOKEN', id: 'fixture-secret-missing', reason: 'unresolved' }] })
  })

  it('two servers binding one variable to different secrets export neither', () => {
    const f = cfg('a.json', { mcpServers: {
      s1: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }),
      s2: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-b' }),
    } })
    expect(collectHttpHeaderEnv([f], exists)).toEqual({ exports: [], skipped: [{ name: 'FIXTURE_TOKEN', reason: 'conflict' }] })
  })

  it('one refused variable does not take the others down', () => {
    const f = cfg('a.json', { mcpServers: { s: http(
      { A: '${FIXTURE_GOOD}', B: '${FIXTURE_BAD}' },
      { FIXTURE_GOOD: 'vault:fixture-secret-a', FIXTURE_BAD: 'vault:fixture-secret-missing' },
    ) } })
    const r = collectHttpHeaderEnv([f], exists)
    expect(r.exports).toEqual([{ name: 'FIXTURE_GOOD', id: 'fixture-secret-a' }])
    expect(r.skipped).toHaveLength(1)
  })

  it('a missing file is nothing; unreadable JSON is reported and does not throw', () => {
    const bad = cfg('bad.json', '{ not json')
    const r = collectHttpHeaderEnv([join(dir, 'absent.json'), bad], exists)
    expect(r).toEqual({ exports: [], skipped: [{ name: '*', reason: 'unreadable' }] })
  })

  it('a config that is not an object, or whose mcpServers is not, yields nothing', () => {
    expect(collectHttpHeaderEnv([cfg('a.json', '[]'), cfg('b.json', { mcpServers: [] }), cfg('c.json', { mcpServers: 'x' })], exists)).toEqual({ exports: [], skipped: [] })
  })
})

describe('buildHttpHeaderLaunch: the shell fragments', () => {
  it('nothing to export: both fragments empty, so the launch command is unchanged', () => {
    const f = cfg('a.json', { mcpServers: {} })
    expect(buildHttpHeaderLaunch([f], exists)).toEqual({ envPrefix: '', execPrefix: '', skipped: [] })
  })

  it('exports the reference (single-quoted) and starts the process through the env wrapper', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: 'Bearer ${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } })
    const r = buildHttpHeaderLaunch([f], exists)
    expect(r.envPrefix).toBe("export FIXTURE_TOKEN='vault:fixture-secret-a' && ")
    expect(r.execPrefix).toMatch(/^'.*\/scripts\/vault-env-wrapper\.sh' $/)
  })

  it('a refused variable gives no wrapper at all', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-missing' }) } })
    const r = buildHttpHeaderLaunch([f], exists)
    expect(r.envPrefix).toBe('')
    expect(r.execPrefix).toBe('')
    expect(r.skipped).toHaveLength(1)
  })

  it('the default existence check asks the vault, and no value reaches the result', () => {
    const f = cfg('a.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } })
    const r = buildHttpHeaderLaunch([f])
    expect(r.envPrefix).toContain('vault:fixture-secret-a')
    expect(JSON.stringify(r)).not.toContain(FIXTURE_VALUE)
    const missing = buildHttpHeaderLaunch([cfg('b.json', { mcpServers: { s: http({ A: '${FIXTURE_TOKEN}' }, { FIXTURE_TOKEN: 'vault:fixture-secret-zz' }) } })])
    expect(missing.skipped).toEqual([{ name: 'FIXTURE_TOKEN', id: 'fixture-secret-zz', reason: 'unresolved' }])
  })
})
