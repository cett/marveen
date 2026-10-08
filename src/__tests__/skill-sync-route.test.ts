// Route tests for POST /api/skill-sync, the DB half of skill-sql-sync.py.
// Real in-memory SQLite, no mocks.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  initDatabase, db, createSkill, getSkill, getSkillFile, createTenant,
  grantSkillAccess, setTenantAgentAvailability,
} from '../db.js'
import { tryHandleSkillSync } from '../web/routes/skill-sync.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', buf)
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL('http://localhost:3420/api/skill-sync')
  const ctx = { req, res, path: url.pathname, method: 'POST', url, role: 'admin', tenantId: null } as unknown as RouteContext
  expect(await tryHandleSkillSync(ctx)).toBe(true)
  return out
}

const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('kind: skill', () => {
  it('creates a fleet row for an unknown file-backed id, global flag from the prefix', async () => {
    const res = await post({ kind: 'skill', skill_id: 'global/my-skill', content: '---\nname: my-skill\n---\nbody' })
    expect(res.body).toEqual({ ok: true, message: 'upserted global/my-skill' })
    expect(getSkill('global/my-skill')).toMatchObject({ name: 'my-skill', tenant_id: 'fleet', is_global: 1, content: '---\nname: my-skill\n---\nbody' })

    await post({ kind: 'skill', skill_id: 'agent/zed/other', content: 'x' })
    expect(getSkill('agent/zed/other')).toMatchObject({ is_global: 0, tenant_id: 'fleet' })
  })

  it('updates only content and updated_at of an existing row, and strips the generated header', async () => {
    createSkill({ id: 'global/s', name: 's', description: 'keep me', content: 'old', tenant_id: 'fleet', is_global: true })
    db.prepare('UPDATE skills SET updated_at = 1 WHERE id = ?').run('global/s')
    await post({ kind: 'skill', skill_id: 'global/s', content: '---\nname: s\n---\n<!-- GENERATED from the skills DB (skill global/s) -->\nnew' })
    const row = getSkill('global/s')!
    expect(row.description).toBe('keep me')
    expect(row.content).toBe('---\nname: s\n---\nnew')
    expect(row.updated_at).toBeGreaterThan(1)
  })

  it('rejects an id that is not file-backed', async () => {
    const res = await post({ kind: 'skill', skill_id: 'global/../etc', content: 'x' })
    expect(res.status).toBe(400)
    expect((await post({ kind: 'skill', skill_id: 'fleet-thing', content: 'x' })).status).toBe(400)
  })
})

describe('kind: tenant', () => {
  beforeEach(() => {
    createTenant('co-x', 'Co X')
    createSkill({ id: 'co-x-helper', name: 'helper', content: 'old', tenant_id: 'co-x' })
  })

  it('updates the tenant row for an agent available to that tenant', async () => {
    setTenantAgentAvailability('co-x', 'agent-a', true)
    const res = await post({ kind: 'tenant', header_id: 'co-x-helper', agent_id: 'agent-a', dir_name: 'co-x-helper', content: 'edited' })
    expect(res.body).toEqual({ ok: true, message: 'updated tenant skill co-x-helper' })
    expect(getSkill('co-x-helper')!.content).toBe('edited')
  })

  it('also accepts an agent available only to a tenant the skill is granted to', async () => {
    createTenant('co-y', 'Co Y')
    grantSkillAccess('co-x-helper', 'co-y')
    setTenantAgentAvailability('co-y', 'agent-b', true)
    const res = await post({ kind: 'tenant', header_id: 'co-x-helper', agent_id: 'agent-b', dir_name: 'co-x-helper', content: 'edited by grantee' })
    expect(res.body.ignored).toBeUndefined()
    expect(getSkill('co-x-helper')!.content).toBe('edited by grantee')
  })

  it('ignores a forged header: unqualified agent, wrong directory, fleet or missing row', async () => {
    setTenantAgentAvailability('co-x', 'agent-a', false)
    const noAccess = await post({ kind: 'tenant', header_id: 'co-x-helper', agent_id: 'agent-a', dir_name: 'co-x-helper', content: 'evil' })
    expect(noAccess.body).toMatchObject({ ok: true, ignored: true })
    setTenantAgentAvailability('co-x', 'agent-a', true)
    const wrongDir = await post({ kind: 'tenant', header_id: 'co-x-helper', agent_id: 'agent-a', dir_name: 'something-else', content: 'evil' })
    expect(wrongDir.body.ignored).toBe(true)
    createSkill({ id: 'global/f', name: 'f', content: 'old', tenant_id: 'fleet', is_global: true })
    expect((await post({ kind: 'tenant', header_id: 'global/f', agent_id: 'agent-a', dir_name: 'global-f', content: 'evil' })).body.ignored).toBe(true)
    expect((await post({ kind: 'tenant', header_id: 'nope', agent_id: 'agent-a', dir_name: 'nope', content: 'evil' })).body.ignored).toBe(true)
    expect(getSkill('co-x-helper')!.content).toBe('old')
    expect(getSkill('global/f')!.content).toBe('old')
  })
})

describe('kind: companion', () => {
  beforeEach(() => {
    createSkill({ id: 'global/s', name: 's', content: 'c', tenant_id: 'fleet', is_global: true })
  })

  it('stores a file for an existing skill, normalising the mode, and overwrites on the second edit', async () => {
    const first = await post({ kind: 'companion', skill_id: 'global/s', rel_path: 'scripts/run.sh', content_base64: b64('#!/bin/sh\n'), mode: 0o755 })
    expect(first.body).toEqual({ ok: true, message: 'stored companion scripts/run.sh of global/s' })
    expect(getSkillFile('global/s', 'scripts/run.sh')).toMatchObject({ mode: 0o755 })
    await post({ kind: 'companion', skill_id: 'global/s', rel_path: 'scripts/run.sh', content_base64: b64('v2'), mode: 0o600 })
    const f = getSkillFile('global/s', 'scripts/run.sh')!
    expect(f.content.toString()).toBe('v2')
    expect(f.mode).toBe(0o644)
  })

  it('does not create a skill row for a companion', async () => {
    const res = await post({ kind: 'companion', skill_id: 'global/ghost', rel_path: 'a.txt', content_base64: b64('x') })
    expect(res.body).toMatchObject({ ok: true, ignored: true })
    expect(getSkill('global/ghost')).toBeUndefined()
  })

  it('refuses a bad rel path (and SKILL.md itself) without an error status', async () => {
    for (const rel of ['../x', '/abs', 'SKILL.md', 'a//b']) {
      const res = await post({ kind: 'companion', skill_id: 'global/s', rel_path: rel, content_base64: b64('x') })
      expect(res.body.ignored, rel).toBe(true)
    }
  })

  it('caps the number of files per skill but still overwrites an existing one', async () => {
    const ins = db.prepare('INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at) VALUES (?, ?, ?, 420, 0, 0)')
    for (let i = 0; i < 200; i++) ins.run('global/s', `f${i}.txt`, Buffer.from('x'))
    const over = await post({ kind: 'companion', skill_id: 'global/s', rel_path: 'one-too-many.txt', content_base64: b64('x') })
    expect(over.body.ignored).toBe(true)
    const again = await post({ kind: 'companion', skill_id: 'global/s', rel_path: 'f0.txt', content_base64: b64('new') })
    expect(again.body.ignored).toBeUndefined()
    expect(getSkillFile('global/s', 'f0.txt')!.content.toString()).toBe('new')
  })

  it('applies the tenant qualification check to a generated tenant copy', async () => {
    createTenant('co-x', 'Co X')
    createSkill({ id: 'co-x-helper', name: 'helper', content: 'c', tenant_id: 'co-x' })
    const denied = await post({ kind: 'companion', skill_id: 'co-x-helper', rel_path: 'a.txt', content_base64: b64('x'), tenant_agent: 'agent-a' })
    expect(denied.body.ignored).toBe(true)
    setTenantAgentAvailability('co-x', 'agent-a', true)
    const ok = await post({ kind: 'companion', skill_id: 'co-x-helper', rel_path: 'a.txt', content_base64: b64('x'), tenant_agent: 'agent-a' })
    expect(ok.body.ignored).toBeUndefined()
    expect(getSkillFile('co-x-helper', 'a.txt')).toBeDefined()
    // a fleet skill never takes a tenant-agent write
    expect((await post({ kind: 'companion', skill_id: 'global/s', rel_path: 'b.txt', content_base64: b64('x'), tenant_agent: 'agent-a' })).body.ignored).toBe(true)
  })
})

describe('request validation', () => {
  it('rejects unknown kinds, missing fields, bad base64 and non-JSON bodies', async () => {
    expect((await post({ kind: 'bogus' })).status).toBe(400)
    expect((await post({ kind: 'skill', content: 'x' })).status).toBe(400)
    expect((await post({ kind: 'companion', skill_id: 'global/s', rel_path: 'a', content_base64: '***' })).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
  })
})
