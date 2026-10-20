// /api/voice/* -- central STT and TTS service for the agent fleet.
//
// All endpoints require Bearer auth (enforced by src/web.ts before routing).
// STT: POST /api/voice/stt     -- transcribe a Telegram voice file_id
// TTS: POST /api/voice/tts     -- synthesize text to ogg/opus, send via Telegram sendVoice
// Config: GET/PUT /api/agents/:id/voice-config  (handled in agents.ts; see there)
// Modality: GET /api/voice/modality?agent=X&chat=Y
//           POST /api/voice/modality/set -- set last inbound modality (future plugin hook use)
// Directive: GET /api/voice/directive?agent=X&chat=Y  -- TTS curl string for UserPromptSubmit hook
//
// Security:
//   - voiceModel is whitelisted against KNOWN_VOICE_MODELS (no path traversal)
//   - spawn uses arg-array, shell:false (no shell injection)
//   - file_id validated to Telegram's safe character set before use
//   - the bot token is the server-side record (vault, keyed by the agent id), never a file the
//     caller can name or write; the chat a TTS goes to must be on the owner-adopted list
//     (channel-credentials.ts). No state_dir crosses this API.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { KNOWN_VOICE_MODELS, readAgentVoiceConfig } from '../agent-config.js'
import { getLastInboundModality, setLastInboundModality } from '../voice-modality.js'
import { buildTtsDirective, inboundIsAudio } from '../voice-directive.js'
import { getChannelBotToken, isValidChannelAgentId, serverMaySendTo } from '../channel-credentials.js'
import { PROJECT_ROOT } from '../../config.js'
import type { RouteContext } from './types.js'

const VOICE_DIR = join(homedir(), '.local', 'share', 'marveen-voice')
// The toolkit script runs from the repo, not from the copy install-voice.sh left in VOICE_DIR: the
// server and the script change together (the script takes its token from the environment), and a stale
// installed copy would otherwise stay in use after an update. The venv still lives in VOICE_DIR.
const VTOOLS_PY = join(PROJECT_ROOT, 'scripts', 'voice', '_vtools.py')
const VENV_PY = join(VOICE_DIR, 'venv', 'bin', 'python')
// Where _vtools.py finds the bot token. The server sets it per spawn; the toolkit never looks in a
// channel directory when it is set.
const TOKEN_ENV = 'MARVEEN_CHANNEL_BOT_TOKEN'
// _vtools.py's positional state_dir slot, unused on the server path (the token comes from TOKEN_ENV).
const NO_STATE_DIR = '-'

/**
 * Pure: the manual step that installs the system packages the voice toolkit
 * needs (ffmpeg with libopus, python3 with venv). The dashboard has no root,
 * so it hands the user the command. `needsSudo` is the flag the UI keys on to
 * show "run this in a terminal", so it stays true on macOS too, where the
 * command (Homebrew) simply has no sudo in it. Anything that is not macOS gets
 * the apt line, as before. Exported for tests.
 */
export function voiceSystemDepsHint(platform: NodeJS.Platform = process.platform): { needsSudo: true; sudoCommand: string } {
  if (platform === 'darwin') {
    return { needsSudo: true, sudoCommand: 'brew install ffmpeg' }
  }
  return {
    needsSudo: true,
    sudoCommand: 'sudo apt-get install -y --no-install-recommends ffmpeg python3-venv python3',
  }
}

// Telegram file_ids are base64url + some punctuation; reject anything else.
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_\-]{10,200}$/

function voiceOnnxPath(model: string): string | null {
  if (!KNOWN_VOICE_MODELS.has(model)) return null
  const p = join(VOICE_DIR, 'voices', `${model}.onnx`)
  return existsSync(p) ? p : null
}

function isVoiceInstalled(): boolean {
  return existsSync(VENV_PY) && existsSync(VTOOLS_PY)
}

function runProc(
  cmd: string,
  args: string[],
  opts: { stdinData?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false, ...(opts.env ? { env: { ...process.env, ...opts.env, VOICE_VENV_PY: VENV_PY } } : {}) })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => { proc.kill('SIGKILL') }, opts.timeoutMs)
      : null
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}

// Concurrency guard: prevents parallel installs racing on the same venv/DEST.
let _installInProgress = false

// Transcribe a Telegram voice file via the local whisper toolkit. This is the
// single in-process entry point for STT -- both the /api/voice/stt route AND
// the message-router tick call it DIRECTLY. The router must never self-HTTP to
// /api/voice/stt: a process HTTP-calling its own dashboard from the 5s tick
// coupled message delivery to the HTTP server and, under sustained voice
// traffic, threw the event loop (progressive /api/agents latency 73ms -> 12s ->
// timeout). Returns the transcript, or null on any failure (toolkit missing,
// invalid input, whisper non-zero). The whisper subprocess keeps its own 60s
// timeout inside runProc, so a slow transcription can never hang the caller.
export async function transcribeVoiceFile(fileId: string, agentId: string): Promise<string | null> {
  if (!isVoiceInstalled()) return null
  if (!SAFE_FILE_ID_RE.test(fileId)) return null
  if (!isValidChannelAgentId(agentId)) return null
  const token = getChannelBotToken(agentId)
  if (!token) {
    logger.warn({ agent: agentId }, 'transcribeVoiceFile: channel not adopted (no server-side bot token)')
    return null
  }
  const result = await runProc(VENV_PY, [VTOOLS_PY, 'transcribe', fileId, NO_STATE_DIR], { timeoutMs: 60_000, env: { [TOKEN_ENV]: token } })
  if (result.code !== 0) {
    logger.warn({ fileId, stderr: result.stderr.slice(0, 200) }, 'transcribeVoiceFile: whisper failed')
    return null
  }
  return result.stdout.trim()
}

export async function tryHandleVoice(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/voice/directive?agent=X&chat=Y[&file=FILE_ID]
  // Returns { directive: string|null, transcript: string|null }.
  // directive semantics by responseMode:
  //   text  -> null (never speaks)
  //   voice -> always buildTtsDirective (speaks even for plain-text input)
  //   auto  -> buildTtsDirective only when the inbound attachment kind is audio
  //            (voice/audio/video_note). A document or photo attachment does NOT speak.
  // transcript: STT result when the attachment is audio and the id is valid (mode-independent --
  //   even text-mode agents benefit from knowing what a voice message said). Non-audio
  //   attachments are never pushed through speech-to-text.
  // fail-safe: STT errors set transcript=null; directive is always attempted independently.
  if (path === '/api/voice/directive' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    const fileParam = ctx.url.searchParams.get('file') ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'invalid_value', field: 'agent', hint: 'Invalid agent' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'invalid_value', field: 'chat_id', hint: 'Invalid chat_id' }, 400); return true }
    // The directive path transcribes with the named agent's bot token (server-side record), so a
    // fleet_agent token may name only itself.
    if (ctx.role === 'fleet_agent' && agentId !== ctx.tokenAgentId) {
      json(res, { error: 'forbidden', field: 'agent', hint: 'A fleet agent token may only ask for its own voice directive' }, 403)
      return true
    }
    const voiceCfg = readAgentVoiceConfig(agentId)
    const kindParam = ctx.url.searchParams.get('kind') ?? ''
    const fileIdOk = !!fileParam && SAFE_FILE_ID_RE.test(fileParam)
    // Audio is decided by the declared attachment kind, never by the mere
    // presence of a file id -- a document attachment is not a voice message.
    const inboundWasAudio = fileIdOk && inboundIsAudio(kindParam, fileParam)
    const ttsParams = { chatId, voiceModel: voiceCfg.voiceModel ?? 'hu_HU-imre-medium', agentId }
    const directive = voiceCfg.responseMode === 'text' ? null
      : voiceCfg.responseMode === 'voice' ? buildTtsDirective(ttsParams)
      : inboundWasAudio ? buildTtsDirective(ttsParams)  // auto: only when inbound was audio
      : null

    let transcript: string | null = null
    if (inboundWasAudio && isVoiceInstalled()) {
      transcript = (await transcribeVoiceFile(fileParam, agentId)) || null
    }

    json(res, { directive, transcript })
    return true
  }

  // GET /api/voice/modality?agent=X&chat=Y
  // Returns the last inbound modality for this agent+chat (for the channel plugin).
  if (path === '/api/voice/modality' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    if (!agentId || !chatId) { json(res, { error: 'required', hint: 'agent and chat required' }, 400); return true }
    const modality = getLastInboundModality(agentId, chatId)
    json(res, { modality })
    return true
  }

  // POST /api/voice/modality/set
  // Body: { agent_id: string, chat_id: string, modality: 'voice'|'text' }
  // TODO: currently unused -- message-router sets modality in-process via setLastInboundModality().
  // Kept for future use if a channel plugin fork needs to set modality over HTTP.
  if (path === '/api/voice/modality/set' && method === 'POST') {
    const body = await readBody(req)
    let data: { agent_id?: string; chat_id?: string; modality?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const agentId = data.agent_id?.trim() ?? ''
    const chatId = data.chat_id?.trim() ?? ''
    const modality = data.modality?.trim() ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'invalid_value', field: 'agent_id', hint: 'Invalid agent_id' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'invalid_value', field: 'chat_id', hint: 'Invalid chat_id' }, 400); return true }
    if (modality !== 'voice' && modality !== 'text') { json(res, { error: 'invalid_value', field: 'modality', hint: 'modality must be voice or text' }, 400); return true }
    setLastInboundModality(agentId, chatId, modality as 'voice' | 'text')
    json(res, { ok: true })
    return true
  }

  // GET /api/voice/status -- is the voice toolkit installed?
  if (path === '/api/voice/status' && method === 'GET') {
    const installed = isVoiceInstalled()
    const voices = installed
      ? Array.from(KNOWN_VOICE_MODELS).filter((m) => existsSync(join(VOICE_DIR, 'voices', `${m}.onnx`)))
      : []
    json(res, { installed, voices, voiceDir: VOICE_DIR })
    return true
  }

  // POST /api/voice/stt
  // Body: { file_id: string, agent_id: string }  (the agent whose bot the file belongs to)
  // Returns: { transcript: string }
  if (path === '/api/voice/stt' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'not_supported', hint: 'Voice toolkit not installed' }, 400); return true }
    const body = await readBody(req)
    let data: { file_id?: string; agent_id?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const fileId = data.file_id?.trim() ?? ''
    const agentId = data.agent_id?.trim() ?? ''
    if (!SAFE_FILE_ID_RE.test(fileId)) { json(res, { error: 'invalid_value', field: 'file_id', hint: 'Invalid file_id' }, 400); return true }
    if (!isValidChannelAgentId(agentId)) { json(res, { error: 'invalid_value', field: 'agent_id', hint: 'Invalid agent_id' }, 400); return true }
    if (!getChannelBotToken(agentId)) { json(res, { error: 'conflict', field: 'agent_id', hint: 'Channel not adopted: the owner records it with POST /api/channel-credentials/adopt' }, 409); return true }

    const transcript = await transcribeVoiceFile(fileId, agentId)
    if (transcript === null) {
      logger.warn({ fileId }, '/api/voice/stt: whisper failed')
      json(res, { error: 'internal_error', hint: 'STT failed' }, 500)
      return true
    }
    json(res, { transcript })
    return true
  }

  // POST /api/voice/tts
  // Body: { text: string, voice_model: string, chat_id: string, agent_id?: string }
  // A fleet_agent token speaks as ITSELF (agent_id, when given, must be its own); an admin names the agent.
  // Returns: { ok: boolean, message_id?: number }
  if (path === '/api/voice/tts' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'not_supported', hint: 'Voice toolkit not installed' }, 400); return true }
    const body = await readBody(req)
    let data: { text?: string; voice_model?: string; chat_id?: string | number; agent_id?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const text = data.text?.trim() ?? ''
    const voiceModel = data.voice_model?.trim() ?? 'hu_HU-imre-medium'
    const chatId = String(data.chat_id ?? '').trim()
    const claimedAgent = data.agent_id?.trim() ?? ''

    if (!text) { json(res, { error: 'required', field: 'text', hint: 'text required' }, 400); return true }
    if (!/^\d+$/.test(chatId)) { json(res, { error: 'invalid_value', field: 'chat_id', hint: 'Invalid chat_id' }, 400); return true }

    // Whose bot speaks. A fleet_agent token speaks only as the agent the token belongs to; the body
    // cannot name another one. The caller never names a directory or a token.
    let agentId: string
    if (ctx.role === 'fleet_agent') {
      agentId = ctx.tokenAgentId ?? ''
      if (!agentId || (claimedAgent && claimedAgent !== agentId)) {
        json(res, { error: 'forbidden', field: 'agent_id', hint: 'A fleet agent token may only speak on its own channel' }, 403)
        return true
      }
    } else {
      agentId = claimedAgent
    }
    if (!isValidChannelAgentId(agentId)) { json(res, { error: 'invalid_value', field: 'agent_id', hint: 'Invalid agent_id' }, 400); return true }

    // The bot token and the paired chats are the server-side record (vault / DB), written only by the
    // owner's adopt. A forged access.json or a foreign token in .env changes neither.
    const botToken = getChannelBotToken(agentId)
    if (!botToken) {
      json(res, { error: 'conflict', field: 'agent_id', hint: 'Channel not adopted: the owner records it with POST /api/channel-credentials/adopt' }, 409)
      return true
    }
    if (!serverMaySendTo(agentId, chatId)) {
      json(res, { error: 'forbidden', field: 'chat_id', hint: 'chat_id is not on this agent\'s adopted chat list' }, 403)
      return true
    }

    const onnxPath = voiceOnnxPath(voiceModel)
    if (!onnxPath) {
      json(res, { error: 'invalid_value', field: 'voice_model', hint: `Unknown or missing voice model: ${voiceModel}` }, 400)
      return true
    }

    const result = await runProc(
      VENV_PY,
      [VTOOLS_PY, 'speak', onnxPath, NO_STATE_DIR, chatId, text],
      { timeoutMs: 90_000, env: { [TOKEN_ENV]: botToken } },
    )
    if (result.code !== 0) {
      logger.warn({ voiceModel, chatId, stderr: result.stderr }, '/api/voice/tts: piper/sendVoice failed')
      json(res, { error: 'internal_error', hint: 'TTS failed', detail: result.stderr.slice(0, 200) }, 500)
      return true
    }
    // _vtools.py prints "ok=True id=12345" or "ok=False id=None"
    const okMatch = result.stdout.match(/ok=(\w+)/)
    const idMatch = result.stdout.match(/id=(\d+)/)
    json(res, {
      ok: okMatch?.[1]?.toLowerCase() === 'true',
      message_id: idMatch ? parseInt(idMatch[1], 10) : null,
    })
    return true
  }

  // POST /api/voice/install
  // Checks system dependencies (ffmpeg + python3-venv). If missing: returns
  // { needsSudo: true, sudoCommand } so the user can run it manually. If deps
  // are present, spawns install-voice.sh with SKIP_SYSTEM_DEPS=1 (no root
  // needed) and returns immediately; the client polls /api/voice/status.
  if (path === '/api/voice/install' && method === 'POST') {
    if (isVoiceInstalled()) {
      json(res, { ok: true, alreadyInstalled: true })
      return true
    }

    // Check system deps without root
    const depCheck = await runProc('bash', ['-c',
      'command -v ffmpeg >/dev/null 2>&1' +
      ' && ffmpeg -encoders 2>&1 | grep -q libopus' +
      ' && python3 -m venv --help >/dev/null 2>&1' +
      ' && echo OK || echo MISSING',
    ], { timeoutMs: 8000 })
    const depsMissing = !depCheck.stdout.trim().endsWith('OK')

    if (depsMissing) {
      json(res, voiceSystemDepsHint())
      return true
    }

    if (_installInProgress) {
      json(res, { ok: true, started: true, alreadyRunning: true })
      return true
    }

    // Deps present -- fire-and-forget the install (no root needed from here).
    // detached:true + unref() keeps the child alive even if the dashboard
    // restarts mid-install (pip + ~126 MB download can take several minutes).
    _installInProgress = true
    const scriptPath = join(PROJECT_ROOT, 'scripts', 'install-voice.sh')
    const child = spawn('bash', [scriptPath], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SKIP_SYSTEM_DEPS: '1' },
    })
    child.unref()
    child.on('error', (err) => { _installInProgress = false; logger.warn({ err }, '/api/voice/install: spawn error') })
    child.on('close', (code) => {
      _installInProgress = false
      if (code !== 0) logger.warn({ code }, '/api/voice/install: install-voice.sh exited non-zero')
      else logger.info('/api/voice/install: install-voice.sh completed successfully')
    })

    json(res, { ok: true, started: true })
    return true
  }

  return false
}
