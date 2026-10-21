// Route-level tests for voice.ts (#751 step 13). The existing
// voice-error-shapes.test.ts only covers early-return validation branches
// (parse_error, invalid_value, not_supported) -- every success path and every
// branch that reaches runProc()/spawn() was untested.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
}))

vi.mock('../web/agent-config.js', () => ({
  KNOWN_VOICE_MODELS: new Set(['hu_HU-imre-medium', 'en_US-test-voice']),
  AGENTS_BASE_DIR: '/tmp/mock-agents',
  readAgentVoiceConfig: vi.fn().mockReturnValue({ responseMode: 'text', voiceModel: null }),
}))

vi.mock('../web/voice-modality.js', () => ({
  getLastInboundModality: vi.fn().mockReturnValue('text'),
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/voice-directive.js', () => ({
  buildTtsDirective: vi.fn().mockReturnValue('TTS_DIRECTIVE'),
  resolveAgentChannelStateDir: vi.fn().mockReturnValue('/tmp/mock-state'),
  inboundIsAudio: vi.fn().mockReturnValue(false),
}))

// isVoiceInstalled() and voiceOnnxPath() both go through existsSync -- keyed
// by path suffix so a single mock can drive "installed" and "which voices
// exist" independently.
let mockVoiceInstalled = true
const mockExistingOnnx = new Set<string>()
vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: unknown) => {
    const s = String(p)
    if (s.endsWith('.onnx')) return mockExistingOnnx.has(s)
    if (s.endsWith('.env')) return true
    if (s.includes('venv/bin/python') || s.endsWith('_vtools.py')) return mockVoiceInstalled
    return false
  }),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

// The server-side record (vault token, adopted chat list) is tested on its own
// (channel-credentials.test.ts); here only the wiring.
vi.mock('../web/channel-credentials.js', () => ({
  getChannelBotToken: vi.fn(),
  serverMaySendTo: vi.fn(),
  isValidChannelAgentId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
}))

import { tryHandleVoice, voiceSystemDepsHint } from '../web/routes/voice.js'
import { spawn } from 'node:child_process'
import { logger } from '../logger.js'
import { buildTtsDirective, inboundIsAudio } from '../web/voice-directive.js'
import { readAgentVoiceConfig } from '../web/agent-config.js'
import { getChannelBotToken, serverMaySendTo } from '../web/channel-credentials.js'

// A fake ChildProcess good enough for runProc(): stdout/stderr emitters plus
// a 'close' event carrying the exit code, fired on the next tick so runProc's
// event listeners are attached first.
function fakeChild(opts: { stdout?: string; stderr?: string; code?: number } = {}) {
  const proc = new EventEmitter() as unknown as {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (...a: unknown[]) => void; end: () => void }
    kill: (...a: unknown[]) => void
  } & EventEmitter
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.kill = vi.fn()
  ;(proc as unknown as { unref: () => void }).unref = vi.fn()
  setImmediate(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout))
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr))
    proc.emit('close', opts.code ?? 0)
  })
  return proc
}
function queueSpawn(opts: { stdout?: string; stderr?: string; code?: number } = {}) {
  vi.mocked(spawn).mockImplementationOnce(() => fakeChild(opts) as never)
}

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(method: string, path: string, bodyOrRaw?: object | string | null): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> }
} {
  const buf = bodyOrRaw == null
    ? Buffer.alloc(0)
    : typeof bodyOrRaw === 'string'
      ? Buffer.from(bodyOrRaw)
      : Buffer.from(JSON.stringify(bodyOrRaw))
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { method: string; headers: Record<string, string> }).method = method
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  setImmediate(() => {
    ;(req as unknown as EventEmitter).emit('data', buf)
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      const str = b ? (Buffer.isBuffer(b) ? b.toString('utf-8') : b) : ''
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    out,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVoiceInstalled = true
  mockExistingOnnx.clear()
  vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'text', voiceModel: null } as never)
  vi.mocked(inboundIsAudio).mockReturnValue(false)
  vi.mocked(getChannelBotToken).mockReturnValue('123456:DEFAULT-TEST-TOKEN-cccccccccccc')
  vi.mocked(serverMaySendTo).mockReturnValue(true)
  vi.mocked(buildTtsDirective).mockReturnValue('TTS_DIRECTIVE' as never)
})

// ── GET /api/voice/directive ────────────────────────────────────────────────────

describe('GET /api/voice/directive', () => {
  it('requires a valid agent id', async () => {
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=bad!&chat=1')
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('agent')
  })

  it('requires a numeric chat id', async () => {
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=abc')
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('chat_id')
  })

  it('responseMode text never speaks, even with an audio attachment (transcript is still fetched)', async () => {
    vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'text', voiceModel: null } as never)
    vi.mocked(inboundIsAudio).mockReturnValue(true)
    queueSpawn({ stdout: 'transcribed anyway\n', code: 0 })
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=1&file=AgACAgQAAxkBAAI&kind=voice')
    await tryHandleVoice(ctx)
    expect(out.body.directive).toBeNull()
    expect(out.body.transcript).toBe('transcribed anyway')
  })

  it('responseMode voice always speaks, even for a non-audio inbound', async () => {
    vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'voice', voiceModel: null } as never)
    vi.mocked(inboundIsAudio).mockReturnValue(false)
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=1')
    await tryHandleVoice(ctx)
    expect(out.body.directive).toBe('TTS_DIRECTIVE')
  })

  it('responseMode auto speaks and transcribes only when the inbound was audio', async () => {
    vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'auto', voiceModel: null } as never)
    vi.mocked(inboundIsAudio).mockReturnValue(true)
    queueSpawn({ stdout: 'hello from stt\n', code: 0 })
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=1&file=AgACAgQAAxkBAAI&kind=voice')
    await tryHandleVoice(ctx)
    expect(out.body.directive).toBe('TTS_DIRECTIVE')
    expect(out.body.transcript).toBe('hello from stt')
  })

  it('responseMode auto stays silent and never transcribes for a non-audio inbound', async () => {
    vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'auto', voiceModel: null } as never)
    vi.mocked(inboundIsAudio).mockReturnValue(false)
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=1&file=AgACAgQAAxkBAAI&kind=document')
    await tryHandleVoice(ctx)
    expect(out.body.directive).toBeNull()
    expect(out.body.transcript).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a failed STT is non-fatal: transcript is null but the directive still resolves', async () => {
    vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'auto', voiceModel: null } as never)
    vi.mocked(inboundIsAudio).mockReturnValue(true)
    queueSpawn({ stderr: 'whisper crashed', code: 1 })
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=1&file=AgACAgQAAxkBAAI&kind=voice')
    await tryHandleVoice(ctx)
    expect(out.body.directive).toBe('TTS_DIRECTIVE')
    expect(out.body.transcript).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('skips STT entirely when the voice toolkit is not installed', async () => {
    mockVoiceInstalled = false
    vi.mocked(readAgentVoiceConfig).mockReturnValue({ responseMode: 'auto', voiceModel: null } as never)
    vi.mocked(inboundIsAudio).mockReturnValue(true)
    const { ctx, out } = makeCtx('GET', '/api/voice/directive?agent=a&chat=1&file=AgACAgQAAxkBAAI&kind=voice')
    await tryHandleVoice(ctx)
    expect(out.body.transcript).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })
})

// ── Modality ─────────────────────────────────────────────────────────────────

describe('GET /api/voice/modality', () => {
  it('requires agent and chat', async () => {
    const { ctx, out } = makeCtx('GET', '/api/voice/modality?agent=a')
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('returns the last inbound modality', async () => {
    const { ctx, out } = makeCtx('GET', '/api/voice/modality?agent=a&chat=1')
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ modality: 'text' })
  })
})

describe('POST /api/voice/modality/set -- success', () => {
  it('sets the modality and returns ok:true', async () => {
    const { setLastInboundModality } = await import('../web/voice-modality.js')
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', { agent_id: 'a', chat_id: '1', modality: 'voice' })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(setLastInboundModality).toHaveBeenCalledWith('a', '1', 'voice')
  })
})

// ── Status ───────────────────────────────────────────────────────────────────

describe('GET /api/voice/status', () => {
  it('reports not installed with an empty voice list', async () => {
    mockVoiceInstalled = false
    const { ctx, out } = makeCtx('GET', '/api/voice/status')
    await tryHandleVoice(ctx)
    expect(out.body.installed).toBe(false)
    expect(out.body.voices).toEqual([])
  })

  it('reports installed and lists only the voice models whose .onnx file exists', async () => {
    mockVoiceInstalled = true
    mockExistingOnnx.add(require('node:path').join(require('node:os').homedir(), '.local', 'share', 'marveen-voice', 'voices', 'hu_HU-imre-medium.onnx'))
    const { ctx, out } = makeCtx('GET', '/api/voice/status')
    await tryHandleVoice(ctx)
    expect(out.body.installed).toBe(true)
    expect(out.body.voices).toEqual(['hu_HU-imre-medium'])
  })
})

// ── STT ──────────────────────────────────────────────────────────────────────

describe('POST /api/voice/stt -- success and failure', () => {
  it('returns the trimmed transcript on success', async () => {
    queueSpawn({ stdout: '  szia vilag  \n', code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', agent_id: 'a' })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ transcript: 'szia vilag' })
  })

  it('returns internal_error when whisper exits non-zero', async () => {
    queueSpawn({ stderr: 'boom', code: 1 })
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', agent_id: 'a' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })

  it('takes the bot token from the server-side record and hands it over by environment, never by argv', async () => {
    vi.mocked(getChannelBotToken).mockReturnValue('111111:SERVER-SIDE-TOKEN-aaaaaaaaaaaa')
    queueSpawn({ stdout: 'x\n', code: 0 })
    const { ctx } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', agent_id: 'a' })
    await tryHandleVoice(ctx)
    expect(getChannelBotToken).toHaveBeenCalledWith('a')
    const [, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(opts.env.MARVEEN_CHANNEL_BOT_TOKEN).toBe('111111:SERVER-SIDE-TOKEN-aaaaaaaaaaaa')
    expect(args.join(' ')).not.toContain('SERVER-SIDE-TOKEN')
  })

  it('refuses a channel that is not adopted, and nothing is spawned', async () => {
    vi.mocked(getChannelBotToken).mockReturnValue(null)
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', agent_id: 'a' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('has no state_dir: a caller-supplied directory is ignored, the agent id decides', async () => {
    queueSpawn({ stdout: 'x\n', code: 0 })
    const { ctx } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', agent_id: 'a', state_dir: '/tmp/mock-agents/other/.claude/channels/telegram' })
    await tryHandleVoice(ctx)
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args.join(' ')).not.toContain('/other/')
    expect(getChannelBotToken).toHaveBeenCalledWith('a')
  })
})

// ── TTS ──────────────────────────────────────────────────────────────────────

const ONNX = () => require('node:path').join(require('node:os').homedir(), '.local', 'share', 'marveen-voice', 'voices', 'en_US-test-voice.onnx')

describe('POST /api/voice/tts', () => {
  it('requires text', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: '  ', chat_id: '1', agent_id: 'a' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('requires a numeric chat_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: 'hi', chat_id: 'abc', agent_id: 'a' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('chat_id')
  })

  it('requires a valid agent_id from an admin principal', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: 'hi', chat_id: '1', agent_id: '../etc' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('agent_id')
  })

  it('rejects an unknown voice model', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', agent_id: 'a', voice_model: 'not-a-real-model',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('voice_model')
  })

  it('rejects a known voice model whose .onnx file is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', agent_id: 'a', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('voice_model')
  })

  it('returns internal_error when piper/sendVoice fails', async () => {
    mockExistingOnnx.add(ONNX())
    queueSpawn({ stderr: 'piper crashed', code: 1 })
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', agent_id: 'a', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })

  it('parses ok/message_id from the vtools stdout on success', async () => {
    mockExistingOnnx.add(ONNX())
    queueSpawn({ stdout: 'ok=True id=12345\n', code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', agent_id: 'a', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: true, message_id: 12345 })
  })

  it('reports ok:false with a null message_id when vtools reports failure', async () => {
    mockExistingOnnx.add(ONNX())
    queueSpawn({ stdout: 'ok=False id=None\n', code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', agent_id: 'a', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: false, message_id: null })
  })

  it('is refused for a channel that is not adopted (no server-side token), and nothing is spawned', async () => {
    mockExistingOnnx.add(ONNX())
    vi.mocked(getChannelBotToken).mockReturnValue(null)
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: 'hi', chat_id: '1', agent_id: 'a', voice_model: 'en_US-test-voice' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('applies the adopted chat list to an admin principal too', async () => {
    mockExistingOnnx.add(ONNX())
    vi.mocked(serverMaySendTo).mockReturnValue(false)
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: 'hi', chat_id: '999', agent_id: 'a', voice_model: 'en_US-test-voice' })
    Object.assign(ctx, { role: 'admin' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(403)
    expect(out.body.field).toBe('chat_id')
    expect(serverMaySendTo).toHaveBeenCalledWith('a', '999')
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('POST /api/voice/tts as a fleet_agent', () => {
  const body = { text: 'hi', chat_id: '4242', voice_model: 'en_US-test-voice' }
  const asFleetAgent = (b: object = body, tokenAgentId = 'zed') => {
    mockExistingOnnx.add(ONNX())
    const made = makeCtx('POST', '/api/voice/tts', b)
    Object.assign(made.ctx, { role: 'fleet_agent', tokenAgentId })
    return made
  }

  it('speaks as the agent its token belongs to, with the server-side token, and nothing else is spoken on', async () => {
    vi.mocked(getChannelBotToken).mockReturnValue('222222:ZED-VAULT-TOKEN-bbbbbbbbbbbbbbb')
    queueSpawn({ stdout: 'ok=True id=77\n', code: 0 })
    const { ctx, out } = asFleetAgent()
    await tryHandleVoice(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, message_id: 77 })
    expect(getChannelBotToken).toHaveBeenCalledWith('zed')
    expect(serverMaySendTo).toHaveBeenCalledWith('zed', '4242')
    const [, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect(args).toContain('4242')
    expect(opts.env.MARVEEN_CHANNEL_BOT_TOKEN).toBe('222222:ZED-VAULT-TOKEN-bbbbbbbbbbbbbbb')
    expect(args.join(' ')).not.toContain('ZED-VAULT-TOKEN')
  })

  it('is refused when the body names another agent, and nothing is spawned', async () => {
    const { ctx, out } = asFleetAgent({ ...body, agent_id: 'other' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(403)
    expect(out.body.field).toBe('agent_id')
    expect(getChannelBotToken).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('is refused on a chat that is not on the adopted list, and nothing is spawned', async () => {
    vi.mocked(serverMaySendTo).mockReturnValue(false)
    const { ctx, out } = asFleetAgent()
    await tryHandleVoice(ctx)
    expect(out.status).toBe(403)
    expect(out.body.field).toBe('chat_id')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('is refused when its token names no agent', async () => {
    const { ctx, out } = asFleetAgent(body, '')
    await tryHandleVoice(ctx)
    expect(out.status).toBe(403)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a state_dir in the body changes nothing: the files an agent can write are not an input', async () => {
    queueSpawn({ stdout: 'ok=True id=1\n', code: 0 })
    const { ctx } = asFleetAgent({ ...body, state_dir: '/tmp/mock-agents/other/.claude/channels/telegram' })
    await tryHandleVoice(ctx)
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args.join(' ')).not.toContain('/other/')
    expect(getChannelBotToken).toHaveBeenCalledWith('zed')
  })
})

// ── Install ──────────────────────────────────────────────────────────────────

describe('POST /api/voice/install', () => {
  it('reports alreadyInstalled when the toolkit is already present', async () => {
    mockVoiceInstalled = true
    const { ctx, out } = makeCtx('POST', '/api/voice/install')
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: true, alreadyInstalled: true })
    expect(spawn).not.toHaveBeenCalled()
  })

  // The hint depends on the host, so each case pins the platform it asserts.
  async function installHintOn(platform: NodeJS.Platform) {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      mockVoiceInstalled = false
      queueSpawn({ stdout: 'MISSING\n', code: 0 })
      const { ctx, out } = makeCtx('POST', '/api/voice/install')
      await tryHandleVoice(ctx)
      return out.body
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
  }

  it('offers the sudo command when system deps are missing (Linux)', async () => {
    const body = await installHintOn('linux')
    expect(body.needsSudo).toBe(true)
    expect(body.sudoCommand).toMatch(/apt-get install/)
  })

  it('offers a Homebrew command without sudo on macOS when system deps are missing', async () => {
    const body = await installHintOn('darwin')
    expect(body.needsSudo).toBe(true)
    expect(body.sudoCommand).toBe('brew install ffmpeg')
    expect(body.sudoCommand).not.toMatch(/sudo|apt-get/)
  })

  it('starts the background install when deps are present', async () => {
    mockVoiceInstalled = false
    queueSpawn({ stdout: 'OK\n', code: 0 })
    queueSpawn({ code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/install')
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: true, started: true })
    expect(spawn).toHaveBeenCalledTimes(2)
    // Let the fake install-voice.sh child's 'close' handler run so the
    // module-level _installInProgress flag resets before the next test.
    await new Promise((r) => setImmediate(r))
  })
})

describe('tryHandleVoice -- unrelated paths', () => {
  it('returns false for a path it does not own', async () => {
    const { ctx } = makeCtx('GET', '/api/something-else')
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(false)
  })
})

describe('voiceSystemDepsHint', () => {
  it('darwin -> Homebrew, no sudo, no apt', () => {
    expect(voiceSystemDepsHint('darwin')).toEqual({ needsSudo: true, sudoCommand: 'brew install ffmpeg' })
  })

  it.each(['linux', 'freebsd', 'win32'] as const)('%s -> the apt line, as before', (p) => {
    const h = voiceSystemDepsHint(p)
    expect(h.needsSudo).toBe(true)
    expect(h.sudoCommand).toBe('sudo apt-get install -y --no-install-recommends ffmpeg python3-venv python3')
  })

  it('defaults to the host platform', () => {
    const expected = process.platform === 'darwin' ? /^brew install/ : /^sudo apt-get install/
    expect(voiceSystemDepsHint().sudoCommand).toMatch(expected)
  })
})
