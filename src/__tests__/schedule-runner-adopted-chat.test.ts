// resolveBoundChatId / buildTaskDeliveryPrefix once the owner has adopted the channel: the chat a
// scheduled task reports to comes from the DB list, not from the access.json the agent can write.
// Until adoption the file stays the (legacy) source.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TMP = vi.hoisted(() => ({
  dir: (require('node:fs') as typeof import('node:fs')).mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sched-adopted-')),
}))
const vault = vi.hoisted(() => new Map<string, string>())

vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => vault.get(id) ?? null,
  setSecret: (id: string, _label: string, value: string) => { vault.set(id, value) },
  deleteSecret: (id: string) => vault.delete(id),
}))
// both the schedule runner and the adopt step ask for the same directory (the real layout, under a temp base)
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...actual, channelStateDir: (_p: string, agentDir?: string) => (agentDir ? join(agentDir, '.claude', 'channels', 'telegram') : join(TMP.dir, 'MAIN-AGENT', 'channels', 'telegram')) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(TMP.dir, name) }
})

import { initDatabase, getDb } from '../db.js'
import { adoptChannel } from '../web/channel-credentials.js'
import { buildTaskDeliveryPrefix, resolveBoundChatId } from '../web/schedule-runner.js'

const TOKEN = '111111111:ZED-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa'

function writeChannel(access: object): void {
  const dir = join(TMP.dir, 'zed', '.claude', 'channels', 'telegram')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(TMP.dir, { recursive: true, force: true }) })
beforeEach(() => {
  vault.clear()
  getDb().exec('DELETE FROM channel_allowed_chats; DELETE FROM channel_credential_baseline')
  rmSync(TMP.dir, { recursive: true, force: true })
})

describe('the chat a scheduled task reports to', () => {
  it('before adoption it is still the first entry of access.json (legacy source)', async () => {
    writeChannel({ allowFrom: ['42'] })
    expect(await resolveBoundChatId('zed')).toBe('42')
  })

  it('after adoption a forged access.json cannot redirect the result', async () => {
    writeChannel({ allowFrom: ['42'] })
    expect((await adoptChannel('zed', 'owner')).ok).toBe(true)
    writeChannel({ allowFrom: ['666', '42'] }) // the agent reorders / extends its own file

    expect(await resolveBoundChatId('zed')).toBe('42')
    expect(await buildTaskDeliveryPrefix({ name: 'daily', tenantId: 'default' }, 'zed')).toContain('chat_id: 42,')
    expect(await buildTaskDeliveryPrefix({ name: 'daily', tenantId: 'default' }, 'zed')).not.toContain('666')
  })

  it('an adopted channel with no chats delivers nowhere, even if the file names one', async () => {
    writeChannel({ allowFrom: [] })
    expect((await adoptChannel('zed', 'owner')).ok).toBe(true)
    writeChannel({ allowFrom: ['666'] })

    expect(await resolveBoundChatId('zed')).toBeNull()
    expect(await buildTaskDeliveryPrefix({ name: 'daily', tenantId: 'default' }, 'zed')).not.toContain('chat_id')
  })
})
