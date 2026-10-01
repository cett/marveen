// The starter pack template is shipped to every install: it must name no person, no fleet agent,
// no host path and no chat, must scope its data to the tenant, and must stay quiet unless the
// runner hands it a delivery instruction. Plus the memory scoping the prompt relies on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { renderStarterPrompt } from '../web/tenant-starter-pack.js'
import { BOT_NAME, MAIN_AGENT_ID, OWNER_NAME } from '../config.js'
import { listAgentNames } from '../web/agent-config.js'

const DIR = join(__dirname, '..', '..', 'templates', 'tenant-starter-pack', 'daily-summary')
const body = readFileSync(join(DIR, 'SKILL.md'), 'utf-8')
const config = JSON.parse(readFileSync(join(DIR, 'task-config.json'), 'utf-8')) as Record<string, unknown>
const rendered = renderStarterPrompt(body, { tenantId: 'acme', agentId: 'acme-lead', installDir: '/opt/install', webPort: 3420 })

describe('template content', () => {
  it('uses only the four placeholders, and none survives rendering', () => {
    const used = new Set([...body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]))
    expect([...used].sort()).toEqual(['AGENT_ID', 'INSTALL_DIR', 'TENANT_ID', 'WEB_PORT'])
    expect(rendered).not.toContain('{{')
  })

  it('carries no owner, bot or agent name of this install, host path, chat id or email', () => {
    // The roster is read from this install, not spelled out here: the repo carries no fleet names.
    const forbidden = [OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, ...listAgentNames()].filter(w => w && w.length >= 3)
    for (const word of forbidden) {
      const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(body.toLowerCase(), `template mentions ${word}`).not.toMatch(new RegExp(`\\b${escaped}\\b`))
    }
    expect(body).not.toMatch(/\/(Users|home)\//)
    expect(body).not.toMatch(/chat_id["':\s]+-?\d{5,}/i)
    expect(body).not.toMatch(/@[a-z0-9-]+\.[a-z]+/i)
    expect(body).not.toContain('—')
  })

  it('reads only the tenant\'s memories (tenant scope in the query) and says never to use anything else', () => {
    expect(body).toContain('/api/memories?agent={{AGENT_ID}}&tenant={{TENANT_ID}}')
    expect(body).toContain('SOHA ne dolgozz')
    const memoryGets = [...body.matchAll(/\/api\/memories[^"\s]*/g)].map(m => m[0])
    expect(memoryGets.every(u => u.includes('tenant={{TENANT_ID}}'))).toBe(true)
  })

  it('writes the summary only to the agent\'s daily log and keeps the dedupe header', () => {
    expect(body).toContain('## Napi összefoglaló')
    expect(body).toContain('/api/daily-log')
    expect(body).toContain('Ismétlés elleni védelem')
  })

  it('stays silent unless the runner gave a delivery instruction', () => {
    expect(body).toContain('Ha nincs ilyen utasítás, ne küldj üzenetet')
    expect(body).toContain('legfeljebb 1500 karakter')
  })

  it('ships one daily, owner-facing task that is not sent while busy-skippable', () => {
    expect(config).toMatchObject({ schedule: '30 21 * * *', type: 'task', skipIfBusy: false, forceSend: false })
  })
})

describe('memory scoping the prompt depends on', () => {
  let tmp: string
  let prevHome: string | undefined
  let dbMod: typeof import('../db.js')
  let memories: typeof import('../web/routes/memories.js')

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'starter-mem-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = tmp
    process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
    vi.resetModules()
    dbMod = await import('../db.js')
    dbMod.initDatabase(':memory:')
    memories = await import('../web/routes/memories.js')
    dbMod.createTenant('acme', 'Acme')
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
    delete process.env['MARVEEN_STORE_DIR']
    rmSync(tmp, { recursive: true, force: true })
  })

  async function call(method: string, path: string, body: object | undefined, principal: object) {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
    req.method = method; req.headers = {}; req.destroy = () => {}
    setImmediate(() => { req.emit('data', buf); req.emit('end') })
    const out: { status: number; body: unknown } = { status: 200, body: {} }
    const res = {
      writeHead(s: number) { out.status = s },
      setHeader() {},
      end(b?: string | Buffer) { if (b) { try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* ignore */ } } },
    }
    const url = new URL(`http://localhost:3420${path}`)
    const ctx = { req, res, path: url.pathname, method, url, ...principal } as unknown as RouteContext
    await memories.tryHandleMemories(ctx)
    return out as { status: number; body: Record<string, unknown> }
  }

  const sharedToken = { role: 'admin', tenantId: null, auth: { kind: 'token' } }
  const tenantUser = { role: 'agent', tenantId: 'acme', auth: { kind: 'session', user: 'acme-user' } }
  const tenantOf = (id: number) => (dbMod.getDb().prepare('SELECT tenant_id FROM memories WHERE id = ?').get(id) as { tenant_id: string }).tenant_id

  it('the shared token writes into the tenant named by ?tenant=, and into default without it', async () => {
    const scoped = await call('POST', '/api/memories?tenant=acme', { agent_id: 'acme-lead', content: 'scoped note' }, sharedToken)
    const bare = await call('POST', '/api/memories', { agent_id: 'acme-lead', content: 'bare note' }, sharedToken)
    expect(tenantOf(scoped.body['id'] as number)).toBe('acme')
    expect(tenantOf(bare.body['id'] as number)).toBe('default')
  })

  it('the query the prompt sends returns the tenant rows only, not the same agent\'s default rows', async () => {
    await call('POST', '/api/memories?tenant=acme', { agent_id: 'acme-lead', content: 'acme row' }, sharedToken)
    await call('POST', '/api/memories', { agent_id: 'acme-lead', content: 'default row' }, sharedToken)
    const r = await call('GET', '/api/memories?agent=acme-lead&tenant=acme&limit=50&include_docs=0', undefined, sharedToken)
    const list = (Array.isArray(r.body) ? r.body : (r.body['memories'] ?? r.body['items'] ?? [])) as { content: string }[]
    expect(list.map(m => m.content)).toEqual(['acme row'])
  })

  it('a tenant user\'s own write lands in the user\'s tenant whatever ?tenant= says', async () => {
    const r = await call('POST', '/api/memories?tenant=default', { agent_id: 'acme-lead', content: 'mine' }, tenantUser)
    expect(tenantOf(r.body['id'] as number)).toBe('acme')
  })
})
