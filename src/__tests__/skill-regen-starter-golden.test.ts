// Golden output of the skill file writers and the tenant starter pack: the files they put on disk for one fixed
// fixture are byte-identical to what the synchronous-db version wrote (the golden file was produced by running
// this same test on the commit before the tasks facade conversion, with GOLDEN_WRITE=1). A change to the
// golden file is a change of what lands on disk and has to be deliberate.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const GOLDEN = join(__dirname, 'golden', 'skill-regen-starter.golden.json')

const { state } = vi.hoisted(() => ({ state: { home: '', project: '' } }))

// The home directory is pinned to the test's own temp dir for the whole file, not through process.env: a write that
// runs after a test ended (a dropped await) lands in the leftover temp dir, never in the real ~/.claude.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => state.home || '/nonexistent-golden-test-home' }
})
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get PROJECT_ROOT() { return state.project },
  MAIN_AGENT_ID: 'main-agent',
  SKILL_SQL_REGEN: true,
  currentBotName: () => 'Main',
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  get AGENTS_BASE_DIR() { return join(state.project, 'agents') },
  listAgentNames: vi.fn().mockReturnValue(['acme-lead', 'acme-aux']),
  isKnownAgent: (n: string) => ['acme-lead', 'acme-aux'].includes(n),
}))
vi.mock('../web/mcp-risk-policy.js', () => ({ getHighRiskMcpServersForAgent: () => [] }))

let prevHome: string | undefined
const human = () => ({ role: 'admin', auth: { kind: 'session', user: 'root' } }) as unknown as RouteContext

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'skill-golden-'))
  state.home = tmp
  state.project = join(tmp, 'project')
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  for (const a of ['acme-lead', 'acme-aux']) mkdirSync(join(state.project, 'agents', a), { recursive: true })
  // The starter task template is read from <project>/templates: use the real one.
  cpSync(join(__dirname, '..', '..', 'templates', 'tenant-starter-pack'), join(state.project, 'templates', 'tenant-starter-pack'), { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(state.home, { recursive: true, force: true })
})

// state.home keeps pointing at the (removed) temp dir, so a late write recreates files there; clean those up too.
afterAll(() => { rmSync(state.home, { recursive: true, force: true }) })

/** Every file under the roots, as relative path -> mode + content (base64, so binary bytes count too). */
function snapshot(roots: string[]): Record<string, { mode: string; content: string }> {
  const out: Record<string, { mode: string; content: string }> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      let content = readFileSync(p)
      // The temp project path is baked into generated text (the starter task's agent-api.sh commands).
      if (content.includes(state.project)) content = Buffer.from(content.toString('utf-8').split(state.project).join('<PROJECT>'))
      if (name === 'task-config.json') {
        // Row timestamps differ per run; everything else in the mirror is part of the golden.
        const j = JSON.parse(content.toString('utf-8')) as Record<string, unknown>
        for (const k of ['created_at', 'updated_at', 'createdAt', 'updatedAt']) delete j[k]
        content = Buffer.from(JSON.stringify(j, null, 2))
      }
      out[relative(state.home, p).split('\\').join('/').replace(/^project\//, 'PROJECT/')] = { mode: (st.mode & 0o777).toString(8), content: content.toString('base64') }
    }
  }
  for (const r of roots) if (existsSync(r)) walk(r)
  return out
}

describe('skill-regen and tenant-starter-pack output', () => {
  it('writes the same bytes as the synchronous version', async () => {
    const db = await import('../db.js')
    db.initDatabase(':memory:')
    const regen = await import('../web/skill-regen.js')
    const pack = await import('../web/tenant-starter-pack.js')

    db.createTenant('acme', 'Acme')
    db.updateTenant('acme', { main_agent_id: 'acme-lead' })
    await db.setTenantAgentAvailability('acme', 'acme-lead', true)
    await db.setTenantAgentAvailability('acme', 'acme-aux', true)

    await db.createSkill({ id: 'global/golden-fleet', name: 'golden-fleet', description: 'fleet skill', content: '---\nname: golden-fleet\ndescription: fleet skill\n---\n# Fleet\nbody line\n', tenant_id: 'fleet', is_global: true })
    await db.putSkillFile('global/golden-fleet', 'scripts/run.sh', Buffer.from('#!/bin/sh\necho golden\n'), 0o755)
    await db.putSkillFile('global/golden-fleet', 'references/notes.md', Buffer.from('# notes\n'))
    await db.putSkillFile('global/golden-fleet', 'assets/blob.bin', Buffer.from([0, 1, 2, 250, 251, 255]))
    await db.createSkill({ id: 'agent/acme-lead/golden-local', name: 'golden-local', description: 'agent skill', content: '---\nname: golden-local\ndescription: agent skill\n---\nlocal body\n', tenant_id: 'fleet', is_global: false })
    await db.createSkill({ id: 'acme-golden-tenant', name: 'golden-tenant', description: 'tenant skill', content: '---\nname: golden-tenant\ndescription: tenant skill\n---\ntenant body\n', tenant_id: 'acme', is_global: false })
    await db.putSkillFile('acme-golden-tenant', 'extra.txt', Buffer.from('tenant companion\n'))

    await regen.regenSkillFilesFromSQL(false, true)
    await regen.regenTenantSkillFiles('acme')
    await regen.regenSingleSkillFile('global/golden-fleet', true)
    const created = await pack.createStarterPack(human(), 'acme')
    expect(created.ok).toBe(true)

    const actual = snapshot([join(state.home, '.claude'), join(state.project, 'agents')])
    // The fixture really produced the files the golden is meant to pin.
    const keys = Object.keys(actual)
    expect(keys.some((k) => k.endsWith('skills/golden-fleet/SKILL.md'))).toBe(true)
    expect(keys.some((k) => k.endsWith('skills/golden-fleet/scripts/run.sh'))).toBe(true)
    expect(keys.some((k) => k.endsWith('skills/golden-fleet/assets/blob.bin'))).toBe(true)
    expect(keys.some((k) => k.includes('acme-golden-tenant') && k.endsWith('SKILL.md'))).toBe(true)
    expect(keys.some((k) => k.endsWith('acme-starter-daily-summary/task-config.json'))).toBe(true)

    if (process.env['GOLDEN_WRITE'] === '1') {
      mkdirSync(join(__dirname, 'golden'), { recursive: true })
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n')
      return
    }
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf-8')))
  })
})
