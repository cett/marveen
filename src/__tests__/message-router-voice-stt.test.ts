// message-router.ts: the inbound voice branch of runMessageRouterTick(). A channel-inbound voice message is
// transcribed in-process (callVoiceSTT -> transcribeVoiceFile) and the transcript replaces the voice block.
//
// callVoiceSTT ends in `return await transcribeVoiceFile(...)` INSIDE its try/catch. That await is what lets the
// catch see a rejection: without it the rejected promise leaves the function untouched, the catch never runs and
// the rejection reaches the tick. A resolving transcriber cannot tell the two apart, so the failure case here is
// the one that pins the await: a throwing transcriber must still deliver the raw voice block and log the failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => undefined)
const mockTranscribe = vi.fn()
const mockLoggerWarn = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-x',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : mockGetPendingMessages()),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  markMessageNoSession: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

// responseMode is anything but 'text': the STT branch only runs for the voice-capable modes.
vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'auto' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `session-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: vi.fn(() => true),
  capturePane: vi.fn(() => ''),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'main-x-channels',
}))

// A channel-inbound message passes its content through unchanged, so the prompt the session receives is
// exactly deliveryContent: the transcript-injected text on success, the raw voice block on failure.
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'channel-inbound', safeFrom: 'channel-user' }),
  wrapAgentMessageForDelivery: (_category: string, _safeFrom: string, _from: string, content: string) => ({ prefix: '', wrapped: content }),
}))

vi.mock('../web/delivery-intent.js', () => ({
  recordDelivery: vi.fn(),
}))

// callVoiceSTT loads the transcriber with a dynamic import; the mock replaces that module.
vi.mock('../web/routes/voice.js', () => ({
  transcribeVoiceFile: (...a: unknown[]) => mockTranscribe(...a),
}))

import { runMessageRouterTick } from '../web/message-router.js'

const VOICE_BLOCK = '<channel source="telegram" chat_id="100" message_id="7" attachment_kind="voice" attachment_file_id="file-1">\n(voice message)\n</channel>'

function pendingVoiceMessage() {
  return [{
    id: 501,
    from_agent: 'channel-user',
    to_agent: 'agent-a',
    content: VOICE_BLOCK,
    created_at: Math.floor(Date.now() / 1000),
  }]
}

/** The prompt text the router handed to the agent's session. */
function deliveredPrompt(): string {
  expect(mockSendPrompt).toHaveBeenCalledTimes(1)
  return String(mockSendPrompt.mock.calls[0][1])
}

describe('message router: inbound voice transcription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPendingMessages.mockReturnValue(pendingVoiceMessage())
    mockMarkDelivered.mockReturnValue(true)
  })

  it('a transcript replaces the voice block and the transcriber gets the file id and the receiving agent', async () => {
    mockTranscribe.mockResolvedValue('hello from the voice note')

    await runMessageRouterTick()

    expect(mockTranscribe).toHaveBeenCalledTimes(1)
    expect(mockTranscribe).toHaveBeenCalledWith('file-1', 'agent-a')
    const prompt = deliveredPrompt()
    expect(prompt).toContain('[Hang átirat]: hello from the voice note')
    expect(prompt).not.toContain('attachment_file_id')
    expect(prompt).not.toContain('attachment_kind')
    expect(mockMarkDelivered).toHaveBeenCalledWith(501)
  })

  it('a transcriber that THROWS is caught in callVoiceSTT: raw voice block delivered, failure logged, tick survives', async () => {
    mockTranscribe.mockRejectedValue(new Error('whisper exploded'))

    // The tick must not reject: a single bad voice file cannot take the whole delivery pass down.
    await expect(runMessageRouterTick()).resolves.toBeUndefined()

    // The failure was handled INSIDE callVoiceSTT (its own catch), not by something further up.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'whisper exploded' }) }),
      'message-router: callVoiceSTT error',
    )
    // Fall-through: the agent still gets the voice message, untouched, and the row is marked delivered.
    const prompt = deliveredPrompt()
    expect(prompt).toContain('attachment_file_id="file-1"')
    expect(prompt).not.toContain('[Hang átirat]')
    expect(mockMarkDelivered).toHaveBeenCalledWith(501)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('a transcriber that returns null (STT failed softly) also delivers the raw voice block', async () => {
    mockTranscribe.mockResolvedValue(null)

    await runMessageRouterTick()

    expect(deliveredPrompt()).toContain('attachment_file_id="file-1"')
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 501, agent: 'agent-a' }),
      'message-router: STT failed, delivering raw voice block',
    )
  })
})
