// End to end through POST /api/voice/tts with the REAL server-side record (DB + channel-credentials),
// where the agent forges the files it can write. Before the server-side record the route read the
// pairing from <state_dir>/access.json and the token from <state_dir>/.env, so each test below that
// expects a refusal or the vault token would have been a send on the forged value.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

// The directory is a real agents base: the old route accepted only a state_dir under AGENTS_BASE_DIR,
// so the same layout lets this file run against the old code as a negative control.
const TMP = vi.hoisted(() => ({
  dir: (require('node:fs') as typeof import('node:fs')).mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'voice-forged-')),
}))
const vault = vi.hoisted(() => new Map<string, string>())

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => vault.get(id) ?? null,
  setSecret: (id: string, _label: string, value: string) => { vault.set(id, value) },
  deleteSecret: (id: string) => vault.delete(id),
}))
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...actual, channelStateDir: (_p: string, agentDir?: string) => (agentDir ? join(agentDir, '.claude', 'channels', 'telegram') : join(TMP.dir, 'MAIN-AGENT', 'channels', 'telegram')) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, AGENTS_BASE_DIR: TMP.dir, agentDir: (name: string) => join(TMP.dir, name), listAgentNames: () => ['zed'] }
})
// The toolkit is "installed" and the voice model exists; everything else is the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: unknown) => {
      const s = String(p)
      return s.includes('venv/bin/python') || s.endsWith('_vtools.py') || s.endsWith('.onnx') ? true : actual.existsSync(p as string)
    },
  }
})
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { initDatabase } from '../db.js'
import { tryHandleVoice } from '../web/routes/voice.js'
import { adoptChannel } from '../web/channel-credentials.js'

const TOKEN_ZED = '111111111:ZED-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FOREIGN = '999999999:FOREIGN-token-ccccccccccccccccccccccc'

function chanDir(): string { return join(TMP.dir, 'zed', '.claude', 'channels', 'telegram') }
function writeChannel(token: string, access: object): void {
  mkdirSync(chanDir(), { recursive: true })
  writeFileSync(join(chanDir(), '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  writeFileSync(join(chanDir(), 'access.json'), JSON.stringify(access))
}

function fakeChild(stdout: string) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: () => void; end: () => void }; kill: () => void }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { write: () => {}, end: () => {} }
  proc.kill = () => {}
  setImmediate(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', 0) })
  return proc
}

async function tts(body: object, role: 'fleet_agent' | 'admin' = 'fleet_agent') {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: object }).headers = {}
  setImmediate(() => { (req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body))); (req as unknown as EventEmitter).emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) { try { out.body = JSON.parse(String(b ?? '')) as Record<string, unknown> } catch { /* ignore */ } },
  }
  const url = new URL('http://localhost:3420/api/voice/tts')
  const ctx = { req, res, path: url.pathname, method: 'POST', url, role, tokenAgentId: 'zed' } as unknown as RouteContext
  await tryHandleVoice(ctx)
  return out
}

const spoken = () => vi.mocked(spawn).mock.calls.map((c) => ({ args: c[1] as string[], env: (c[2] as { env?: Record<string, string> }).env ?? {} }))

beforeAll(() => {
  initDatabase(':memory:')
})
afterAll(() => { rmSync(TMP.dir, { recursive: true, force: true }) })
beforeEach(() => {
  vault.clear()
  vi.mocked(spawn).mockReset()
  vi.mocked(spawn).mockImplementation(() => fakeChild('ok=True id=5\n') as never)
  rmSync(TMP.dir, { recursive: true, force: true })
  mkdirSync(TMP.dir, { recursive: true })
})

describe('POST /api/voice/tts with forged channel files', () => {
  it('a forged access.json does not widen the chats: the extra chat is refused, nothing is spawned', async () => {
    writeChannel(TOKEN_ZED, { allowFrom: ['42'] })
    expect(adoptChannel('zed', 'owner').ok).toBe(true)
    writeChannel(TOKEN_ZED, { allowFrom: ['42', '666'] }) // the agent writes its own file

    // an old client still sends its state_dir; it is ignored
    const refused = await tts({ text: 'hi', chat_id: '666', state_dir: chanDir() })
    expect(refused.status).toBe(403)
    expect(refused.body.field).toBe('chat_id')
    expect(spoken()).toHaveLength(0)

    const allowed = await tts({ text: 'hi', chat_id: '42', state_dir: chanDir() })
    expect(allowed.status).toBe(200)
    expect(spoken()).toHaveLength(1)
  })

  it('a foreign token in .env is not the one the server sends with', async () => {
    writeChannel(TOKEN_ZED, { allowFrom: ['42'] })
    adoptChannel('zed', 'owner')
    writeChannel(FOREIGN, { allowFrom: ['42'] })

    const out = await tts({ text: 'hi', chat_id: '42', state_dir: chanDir() })
    expect(out.status).toBe(200)
    const [call] = spoken()
    expect(call.env.MARVEEN_CHANNEL_BOT_TOKEN).toBe(TOKEN_ZED)
    expect(call.args.join(' ')).not.toContain(FOREIGN)
    expect(JSON.stringify(call.env)).not.toContain(FOREIGN)
  })

  it('a channel nobody adopted sends nothing, even with a perfectly valid-looking pairing on disk', async () => {
    writeChannel(TOKEN_ZED, { allowFrom: ['42'] })
    const out = await tts({ text: 'hi', chat_id: '42', state_dir: chanDir() })
    expect(out.status).toBe(409)
    expect(spoken()).toHaveLength(0)
  })

  it('an agent token cannot speak as another agent by naming it', async () => {
    writeChannel(TOKEN_ZED, { allowFrom: ['42'] })
    adoptChannel('zed', 'owner')
    const out = await tts({ text: 'hi', chat_id: '42', agent_id: 'amy' })
    expect(out.status).toBe(403)
    expect(spoken()).toHaveLength(0)
  })
})
