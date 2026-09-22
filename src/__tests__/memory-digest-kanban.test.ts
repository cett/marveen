// Unit tests for the parts of src/memory.ts NOT already covered by
// memory-hybrid-recall.test.ts (which owns buildMemoryContext): the kanban
// context renderer, the auto-save-a-turn heuristics, the decay sweep
// orchestration, and the daily digest sub-agent pipeline.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../db.js', () => ({
  hybridSearch: vi.fn(),
  searchMemories: vi.fn(),
  recentMemories: vi.fn(),
  touchMemory: vi.fn(),
  saveMemory: vi.fn(),
  decayMemories: vi.fn().mockReturnValue(undefined),
  pruneAuditLogs: vi.fn().mockReturnValue(undefined),
  pruneTokenUsage: vi.fn().mockReturnValue({ pruned: 0 }),
  pruneBlackboardHistory: vi.fn().mockReturnValue(0),
  pruneConversationLog: vi.fn().mockReturnValue(0),
  pruneAgentMessages: vi.fn().mockReturnValue(0),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  listKanbanCardsSummary: vi.fn().mockReturnValue([]),
}))

vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'agent-a' }))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn().mockResolvedValue({ text: null }),
}))

const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()
const mockLoggerDebug = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    warn: vi.fn(),
  },
}))

vi.mock('../prompt-safety.js', () => ({
  wrapUntrusted: vi.fn((_tag: string, s: string) => s),
  UNTRUSTED_PREAMBLE: 'UNTRUSTED-PREAMBLE',
}))

const mockMkdirSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn()
vi.mock('node:fs', () => ({
  mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
}))

import {
  buildKanbanContext,
  saveConversationTurn,
  runDecaySweep,
  runDailyDigest,
} from '../memory.js'
import * as db from '../db.js'
import { runAgent } from '../agent.js'

const mockListKanbanCardsSummary = vi.mocked(db.listKanbanCardsSummary)
const mockSaveMemory = vi.mocked(db.saveMemory)
const mockGetMemoriesForChat = vi.mocked(db.getMemoriesForChat)
const mockRunAgent = vi.mocked(runAgent)

beforeEach(() => {
  vi.clearAllMocks()
  mockMkdirSync.mockReturnValue(undefined)
  mockExistsSync.mockReturnValue(false)
})

describe('buildKanbanContext', () => {
  it('returns an empty string when there are no cards', () => {
    mockListKanbanCardsSummary.mockReturnValue([])
    expect(buildKanbanContext()).toBe('')
  })

  it('groups cards by their Hungarian status label, with priority emoji and assignee', () => {
    mockListKanbanCardsSummary.mockReturnValue([
      { id: 'c1', title: 'Fix the thing', status: 'in_progress', priority: 'urgent', assignee: 'agent-a' },
      { id: 'c2', title: 'Write docs', status: 'planned', priority: 'low', assignee: null },
    ] as unknown as ReturnType<typeof db.listKanbanCardsSummary>)

    const out = buildKanbanContext()

    expect(out).toContain('[Kanban tabla]')
    expect(out).toContain('Folyamatban:')
    expect(out).toContain('🔴 Fix the thing (agent-a) [c1]')
    expect(out).toContain('Tervezett:')
    expect(out).toContain('🔵 Write docs [c2]')
  })

  it('falls back to the raw status string and a neutral priority dot for unknown values', () => {
    mockListKanbanCardsSummary.mockReturnValue([
      { id: 'c3', title: 'Mystery card', status: 'archived', priority: 'weird', assignee: null },
    ] as unknown as ReturnType<typeof db.listKanbanCardsSummary>)

    const out = buildKanbanContext()

    expect(out).toContain('archived:')
    expect(out).toContain('⚪ Mystery card [c3]')
  })
})

describe('saveConversationTurn', () => {
  it('skips a short message (<=20 chars)', async () => {
    await saveConversationTurn('chat-1', 'remember this', 'ok')
    expect(mockSaveMemory).not.toHaveBeenCalled()
  })

  it('skips a slash-command message regardless of length', async () => {
    await saveConversationTurn('chat-1', '/status a very long slash command message', 'ok')
    expect(mockSaveMemory).not.toHaveBeenCalled()
  })

  it('skips a trivial acknowledgement even when padded past 20 chars by whitespace', async () => {
    await saveConversationTurn('chat-1', '   koszi                ', 'ok')
    expect(mockSaveMemory).not.toHaveBeenCalled()
  })

  it('saves a semantic memory for a long message matching the preference/fact pattern', async () => {
    const userMsg = 'Fontos, hogy mindig magyarul valaszolj nekem mostantol kezdve'
    await saveConversationTurn('chat-1', userMsg, 'Rendben, magyarul valaszolok.')

    expect(mockSaveMemory).toHaveBeenCalledTimes(1)
    const [chatId, content, sector] = mockSaveMemory.mock.calls[0]
    expect(chatId).toBe('chat-1')
    expect(sector).toBe('semantic')
    expect(content).toContain(userMsg)
    expect(content).toContain('Rendben, magyarul valaszolok.')
  })

  it('does not save a long message that matches neither the semantic nor the skip pattern', async () => {
    const userMsg = 'Milyen idő lesz holnap Budapesten, kell-e esernyő?'
    await saveConversationTurn('chat-1', userMsg, 'Napos lesz.')
    expect(mockSaveMemory).not.toHaveBeenCalled()
  })
})

describe('runDecaySweep', () => {
  it('runs every prune/decay step and logs a combined summary', () => {
    vi.mocked(db.pruneTokenUsage).mockReturnValue({ pruned: 3 } as unknown as ReturnType<typeof db.pruneTokenUsage>)
    vi.mocked(db.pruneBlackboardHistory).mockReturnValue(2 as unknown as ReturnType<typeof db.pruneBlackboardHistory>)
    vi.mocked(db.pruneConversationLog).mockReturnValue(1 as unknown as ReturnType<typeof db.pruneConversationLog>)
    vi.mocked(db.pruneAgentMessages).mockReturnValue(4 as unknown as ReturnType<typeof db.pruneAgentMessages>)

    runDecaySweep()

    expect(db.decayMemories).toHaveBeenCalledTimes(1)
    expect(db.pruneAuditLogs).toHaveBeenCalledTimes(1)
    expect(db.pruneTokenUsage).toHaveBeenCalledTimes(1)
    expect(db.pruneBlackboardHistory).toHaveBeenCalledTimes(1)
    expect(db.pruneConversationLog).toHaveBeenCalledTimes(1)
    expect(db.pruneAgentMessages).toHaveBeenCalledTimes(1)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ pruned: 3, blackboardHistoryPruned: 2, conversationLogPruned: 1, agentMessagesPruned: 4 }),
      expect.stringContaining('sopres'),
    )
  })
})

describe('runDailyDigest', () => {
  const now = Math.floor(Date.now() / 1000)

  function memory(id: number, content: string, ageSeconds: number) {
    return { id, content, created_at: now - ageSeconds } as unknown as ReturnType<typeof db.getMemoriesForChat>[number]
  }

  it('skips digest generation when fewer than 2 memories were recorded today', async () => {
    mockGetMemoriesForChat.mockReturnValue([memory(1, 'only one thing happened', 3600)])

    const result = await runDailyDigest('chat-1')

    expect(result).toBeNull()
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(mockSaveMemory).not.toHaveBeenCalled()
  })

  it('ignores memories older than 24h when counting today\'s activity', async () => {
    mockGetMemoriesForChat.mockReturnValue([
      memory(1, 'today A', 3600),
      memory(2, 'yesterday B', 2 * 86400),
      memory(3, 'yesterday C', 3 * 86400),
    ])

    const result = await runDailyDigest('chat-1')

    expect(result).toBeNull()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('generates and saves a digest as an episodic memory when there is enough activity', async () => {
    mockGetMemoriesForChat.mockReturnValue([
      memory(1, 'worked on the coverage series', 3600),
      memory(2, 'opened a pull request', 7200),
    ])
    mockRunAgent.mockResolvedValue({ text: '  Ma a coverage sorozaton dolgoztunk.  ' } as unknown as Awaited<ReturnType<typeof runAgent>>)

    const result = await runDailyDigest('chat-1')

    expect(result).toBe('Ma a coverage sorozaton dolgoztunk.')
    expect(mockSaveMemory).toHaveBeenCalledTimes(1)
    const [chatId, content, sector] = mockSaveMemory.mock.calls[0]
    expect(chatId).toBe('chat-1')
    expect(sector).toBe('episodic')
    expect(content).toContain('Ma a coverage sorozaton dolgoztunk.')
    expect(content).toContain('[Napi naplo')
  })

  it('returns null without saving when the sub-agent produces no text', async () => {
    mockGetMemoriesForChat.mockReturnValue([
      memory(1, 'worked on A', 3600),
      memory(2, 'worked on B', 7200),
    ])
    mockRunAgent.mockResolvedValue({ text: null } as unknown as Awaited<ReturnType<typeof runAgent>>)

    const result = await runDailyDigest('chat-1')

    expect(result).toBeNull()
    expect(mockSaveMemory).not.toHaveBeenCalled()
  })

  it('returns null and logs an error when the sub-agent invocation throws', async () => {
    mockGetMemoriesForChat.mockReturnValue([
      memory(1, 'worked on A', 3600),
      memory(2, 'worked on B', 7200),
    ])
    mockRunAgent.mockRejectedValue(new Error('sub-agent spawn failed'))

    const result = await runDailyDigest('chat-1')

    expect(result).toBeNull()
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('napl'))
  })
})
