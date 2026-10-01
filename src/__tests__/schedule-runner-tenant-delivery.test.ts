// Delivery prefix of a scheduled task: a non-default tenant's result goes only
// to the telegram DM bindings of (tenant, agent) that the agent's allowlist
// also carries. It never falls back to access.json allowFrom[0], which can be
// the fleet owner. The `default` tenant keeps the existing bound-chat lookup.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface FakeBinding { agent_id: string; channel: string; external_id: string; tenant_id: string }

const mockChannelStateDir = vi.hoisted(() => vi.fn())
const fakeBindings = vi.hoisted(() => ({ rows: [] as FakeBinding[] }))
const listSpy = vi.hoisted(() => vi.fn())

vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...actual, channelStateDir: mockChannelStateDir }
})
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    listChannelBindings: (filter: { tenantId?: string; agentId?: string } = {}) => {
      listSpy(filter)
      return fakeBindings.rows.filter(r =>
        (!filter.tenantId || r.tenant_id === filter.tenantId) && (!filter.agentId || r.agent_id === filter.agentId))
    },
  }
})

import { cronPrevOccurrence } from '../web/cron.js'
import {
  buildTaskDeliveryPrefix,
  resolveTenantDeliveryChats,
  selectTenantDeliveryChats,
  MAX_TENANT_DELIVERY_CHATS,
} from '../web/schedule-runner.js'

const bind = (agent: string, tenant: string, id: string, channel = 'telegram'): FakeBinding =>
  ({ agent_id: agent, channel, external_id: id, tenant_id: tenant })

describe('selectTenantDeliveryChats', () => {
  const access = { allowFrom: ['111', '222', '333', '444', '555'] }

  it('keeps telegram DM bindings that are on the allowlist, in binding order', () => {
    expect(selectTenantDeliveryChats([
      { channel: 'telegram', external_id: '222' },
      { channel: 'telegram', external_id: '111' },
    ], access)).toEqual(['222', '111'])
  })

  it('drops a binding that is not on the allowlist', () => {
    expect(selectTenantDeliveryChats([{ channel: 'telegram', external_id: '999' }], access)).toEqual([])
  })

  it('drops group chats (negative ids) even when allowlisted', () => {
    expect(selectTenantDeliveryChats(
      [{ channel: 'telegram', external_id: '-100123' }],
      { allowFrom: ['-100123'] },
    )).toEqual([])
  })

  it('drops non-telegram channels', () => {
    expect(selectTenantDeliveryChats([
      { channel: 'inter-agent', external_id: '111' },
      { channel: 'dashboard', external_id: '222' },
    ], access)).toEqual([])
  })

  it('caps the recipients and removes duplicates', () => {
    const many = ['111', '111', '222', '333', '444', '555'].map(id => ({ channel: 'telegram', external_id: id }))
    const out = selectTenantDeliveryChats(many, access)
    expect(out).toEqual(['111', '222', '333'])
    expect(out).toHaveLength(MAX_TENANT_DELIVERY_CHATS)
  })

  it('accepts numeric allowlist entries and tolerates a malformed config', () => {
    expect(selectTenantDeliveryChats([{ channel: 'telegram', external_id: '111' }], { allowFrom: [111] })).toEqual(['111'])
    expect(selectTenantDeliveryChats([{ channel: 'telegram', external_id: '111' }], null)).toEqual([])
    expect(selectTenantDeliveryChats([{ channel: 'telegram', external_id: '111' }], { allowFrom: 'x' })).toEqual([])
  })
})

describe('resolveTenantDeliveryChats / buildTaskDeliveryPrefix', () => {
  let dir: string
  const writeAccess = (content: unknown) => writeFileSync(join(dir, 'access.json'), JSON.stringify(content))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tenant-delivery-'))
    mockChannelStateDir.mockReturnValue(dir)
    fakeBindings.rows = []
    listSpy.mockClear()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('no binding: no instruction, although access.json has an entry (no allowFrom[0] fallback)', () => {
    writeAccess({ allowFrom: ['900100'] })
    expect(resolveTenantDeliveryChats('worker', 'acme')).toEqual([])
    const prefix = buildTaskDeliveryPrefix({ name: 'acme-daily', tenantId: 'acme' }, 'worker')
    expect(prefix).toBe('[Utemezett feladat: acme-daily] ')
    expect(prefix).not.toContain('900100')
    expect(prefix).not.toContain('chat_id')
  })

  it('never uses a binding of another tenant, for the same agent', () => {
    writeAccess({ allowFrom: ['111', '222'] })
    fakeBindings.rows = [bind('worker', 'other', '111'), bind('worker', 'default', '222')]
    expect(resolveTenantDeliveryChats('worker', 'acme')).toEqual([])
    expect(listSpy).toHaveBeenCalledWith({ tenantId: 'acme', agentId: 'worker' })
  })

  it('never uses a binding of another agent, for the same tenant', () => {
    writeAccess({ allowFrom: ['111'] })
    fakeBindings.rows = [bind('someone-else', 'acme', '111')]
    expect(resolveTenantDeliveryChats('worker', 'acme')).toEqual([])
  })

  it('a binding that is not on the allowlist is excluded', () => {
    writeAccess({ allowFrom: ['900100'] })
    fakeBindings.rows = [bind('worker', 'acme', '111')]
    expect(resolveTenantDeliveryChats('worker', 'acme')).toEqual([])
  })

  it('binding plus allowlist: the prefix carries exactly the bound chat ids', () => {
    writeAccess({ allowFrom: ['900100', '111', '222'] })
    fakeBindings.rows = [bind('worker', 'acme', '111'), bind('worker', 'acme', '222'), bind('worker', 'acme', '-100777')]
    expect(buildTaskDeliveryPrefix({ name: 'acme-daily', tenantId: 'acme' }, 'worker'))
      .toBe('[Utemezett feladat: acme-daily] Az eredmenyt kuldd el Telegramon (chat_id: 111, 222, reply tool). ')
  })

  it('a missing access.json yields no recipients', () => {
    fakeBindings.rows = [bind('worker', 'acme', '111')]
    expect(resolveTenantDeliveryChats('worker', 'acme')).toEqual([])
  })

  it('the default tenant keeps the bound-chat lookup and never reads the bindings table', () => {
    writeAccess({ allowFrom: ['900100', '111'] })
    fakeBindings.rows = [bind('worker', 'default', '111')]
    expect(buildTaskDeliveryPrefix({ name: 'daily', tenantId: 'default' }, 'worker'))
      .toBe('[Utemezett feladat: daily] Az eredmenyt kuldd el Telegramon (chat_id: 900100, reply tool). ')
    expect(buildTaskDeliveryPrefix({ name: 'daily' }, 'worker'))
      .toBe('[Utemezett feladat: daily] Az eredmenyt kuldd el Telegramon (chat_id: 900100, reply tool). ')
    expect(listSpy).not.toHaveBeenCalled()
  })
})

describe('daily 21:30 schedule', () => {
  it('is due exactly once across 24 hours of contiguous ticks', () => {
    const TICK = 15_000
    const start = Date.UTC(2026, 9, 1, 0, 0, 0)
    let due = 0
    for (let t = start; t < start + 24 * 3600_000; t += TICK) {
      if (cronPrevOccurrence('30 21 * * *', t, t + TICK, 'UTC') != null) due++
    }
    expect(due).toBe(1)
  })
})
