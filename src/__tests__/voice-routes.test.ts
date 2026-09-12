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

import { tryHandleVoice } from '../web/routes/voice.js'
import { spawn } from 'node:child_process'
import { logger } from '../logger.js'
import { buildTtsDirective, inboundIsAudio } from '../web/voice-directive.js'
import { readAgentVoiceConfig } from '../web/agent-config.js'

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
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram' })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ transcript: 'szia vilag' })
  })

  it('returns internal_error when whisper exits non-zero', async () => {
    queueSpawn({ stderr: 'boom', code: 1 })
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

// ── TTS ──────────────────────────────────────────────────────────────────────

describe('POST /api/voice/tts', () => {
  it('requires text', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: '  ', chat_id: '1', state_dir: '/x' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('requires a numeric chat_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: 'hi', chat_id: 'abc', state_dir: '/x' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('chat_id')
  })

  it('requires a safe state_dir', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', { text: 'hi', chat_id: '1', state_dir: '/etc/passwd' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('state_dir')
  })

  it('rejects an unknown voice model', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram', voice_model: 'not-a-real-model',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('voice_model')
  })

  it('rejects a known voice model whose .onnx file is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('voice_model')
  })

  it('returns internal_error when piper/sendVoice fails', async () => {
    mockExistingOnnx.add(require('node:path').join(require('node:os').homedir(), '.local', 'share', 'marveen-voice', 'voices', 'en_US-test-voice.onnx'))
    queueSpawn({ stderr: 'piper crashed', code: 1 })
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })

  it('parses ok/message_id from the vtools stdout on success', async () => {
    mockExistingOnnx.add(require('node:path').join(require('node:os').homedir(), '.local', 'share', 'marveen-voice', 'voices', 'en_US-test-voice.onnx'))
    queueSpawn({ stdout: 'ok=True id=12345\n', code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: true, message_id: 12345 })
  })

  it('reports ok:false with a null message_id when vtools reports failure', async () => {
    mockExistingOnnx.add(require('node:path').join(require('node:os').homedir(), '.local', 'share', 'marveen-voice', 'voices', 'en_US-test-voice.onnx'))
    queueSpawn({ stdout: 'ok=False id=None\n', code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/tts', {
      text: 'hi', chat_id: '1', state_dir: '/tmp/mock-agents/a/.claude/channels/telegram', voice_model: 'en_US-test-voice',
    })
    await tryHandleVoice(ctx)
    expect(out.body).toEqual({ ok: false, message_id: null })
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

  it('offers the sudo command when system deps are missing', async () => {
    mockVoiceInstalled = false
    queueSpawn({ stdout: 'MISSING\n', code: 0 })
    const { ctx, out } = makeCtx('POST', '/api/voice/install')
    await tryHandleVoice(ctx)
    expect(out.body.needsSudo).toBe(true)
    expect(out.body.sudoCommand).toMatch(/apt-get install/)
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
