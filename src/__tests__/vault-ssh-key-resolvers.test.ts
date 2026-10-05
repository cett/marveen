// An SSH private key is consumed only in-process by the SSH feature. The generic value route and the
// binding writer refuse it (vault-read-audit.test.ts); the three runtime scripts that call getSecret
// carry the same one-line check as a second layer. They run as real child processes against a stubbed
// dist/web/vault.js, because each derives its project root from its own file path (__dirname/..).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-ssh-resolvers-'))
const SECRET_VALUE = 'sv-3f6f1e2b-not-a-real-secret'
const SSH_ID = 'ssh-key-abc123'
const SSH_MARKER = 'SSH-PRIVATE-MARKER-do-not-serve-7c1e'

function run(script: string, args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [join(ROOT, 'scripts', script), ...args], (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0
      resolve({ code, stdout, stderr })
    })
    child.stdin!.end(stdin)
  })
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  for (const f of ['vault-resolve.mjs', 'vault-materialize.mjs', 'vault-inject-http-mcp.mjs']) {
    copyFileSync(join(process.cwd(), 'scripts', f), join(ROOT, 'scripts', f))
  }
  writeFileSync(
    join(ROOT, 'dist', 'web', 'vault.js'),
    `export function getSecret(id) { return id === 'KNOWN-LABEL' ? '${SECRET_VALUE}' : id === '${SSH_ID}' ? '${SSH_MARKER}' : null }\nexport function setSecret() {}\n`,
  )
  writeFileSync(
    join(ROOT, 'dist', 'web', 'atomic-write.js'),
    `import { writeFileSync } from 'node:fs'\nexport function atomicWriteFileSync(path, data) { writeFileSync(path, data) }\n`,
  )
})
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('vault-resolve', () => {
  it('an ordinary label still resolves, silently, exit 0', async () => {
    const r = await run('vault-resolve.mjs', [], 'PAT=KNOWN-LABEL\n')
    expect(r).toEqual({ code: 0, stdout: `PAT=${SECRET_VALUE}\n`, stderr: '' })
  })
  it('an ssh-key id: exit 4, nothing on stdout, the refusal on stderr, no value anywhere', async () => {
    const r = await run('vault-resolve.mjs', [], `DEPLOY=${SSH_ID}\n`)
    expect(r.code).toBe(4)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain(`refused, SSH private keys are not resolvable here: ${SSH_ID}`)
    expect(r.stderr).not.toContain(SSH_MARKER)
  })
  it('a mixed batch still resolves the ordinary line and refuses the ssh-key line', async () => {
    const r = await run('vault-resolve.mjs', [], `PAT=KNOWN-LABEL\nDEPLOY=${SSH_ID}\n`)
    expect(r.code).toBe(4)
    expect(r.stdout).toBe(`PAT=${SECRET_VALUE}\n`)
  })
})

describe('vault-materialize get', () => {
  it('an ordinary label is written, an ssh-key id is refused with exit 4 and no value', async () => {
    expect(await run('vault-materialize.mjs', ['get', 'KNOWN-LABEL'])).toMatchObject({ code: 0, stdout: SECRET_VALUE })
    const r = await run('vault-materialize.mjs', ['get', SSH_ID])
    expect(r.code).toBe(4)
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toContain(SSH_MARKER)
  })
})

describe('vault-inject-http-mcp inject', () => {
  const cfg = (id: string) => JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://example.org/mcp', headers: { Authorization: `Bearer vault:${id}` } } } })
  it('an ordinary reference is injected; an ssh-key reference leaves the file untouched and no value is written', async () => {
    const ok = join(ROOT, 'ok.json'); writeFileSync(ok, cfg('KNOWN-LABEL'))
    expect((await run('vault-inject-http-mcp.mjs', ['inject', ok])).code).toBe(0)
    expect(readFileSync(ok, 'utf-8')).toContain(SECRET_VALUE)
    const bad = join(ROOT, 'bad.json'); writeFileSync(bad, cfg(SSH_ID))
    const r = await run('vault-inject-http-mcp.mjs', ['inject', bad])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('SSH private keys are not injectable')
    expect(readFileSync(bad, 'utf-8')).toBe(cfg(SSH_ID))
    expect(readFileSync(bad, 'utf-8')).not.toContain(SSH_MARKER)
    expect(r.stderr).not.toContain(SSH_MARKER)
  })
})
