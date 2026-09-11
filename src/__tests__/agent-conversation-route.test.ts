// #751 step 7: src/web/routes/agent-conversation.ts was at 0%. Read-only
// transcript-to-timeline route; the interesting logic (parsing a Claude Code
// .jsonl transcript into a chat-style timeline, pagination, "pick the newest
// transcript file") is exercised against real temp-dir .jsonl files rather
// than mocked line-by-line, since that is closer to what actually goes wrong
// in practice. The upstream agent-resolution helpers (main-agent/agent-config/
// claude-plans/active-model) are mocked to point deterministically at our temp
// dir -- they have their own coverage elsewhere and are not this route's job.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { TRANSCRIPTS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'agent-conversation-route-'))
  const dir = join(root, 'projects', 'fake')
  mkdirSync(dir, { recursive: true })
  return { TRANSCRIPTS_DIR: dir }
})

vi.mock('../web/main-agent.js', () => ({ isMainChannelsAgent: (name: string) => name === 'marveen' }))
vi.mock('../web/agent-config.js', () => ({ agentDir: (name: string) => `/fake/agents/${name}` }))
vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDir: () => ({ configDir: null, planUnresolved: false }) }))
vi.mock('../web/active-model.js', () => ({ projectsDirFor: () => TRANSCRIPTS_DIR }))

import { tryHandleAgentConversation } from '../web/routes/agent-conversation.js'

function makeCtx(opts: { method: string; path: string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => em.emit('end'))
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

function writeTranscript(name: string, lines: unknown[], mtimeOffsetSec = 0): string {
  const file = join(TRANSCRIPTS_DIR, name)
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'))
  if (mtimeOffsetSec) {
    const t = new Date(Date.now() + mtimeOffsetSec * 1000)
    utimesSync(file, t, t)
  }
  return file
}

function cleanTranscriptsDir(): void {
  for (const f of require('node:fs').readdirSync(TRANSCRIPTS_DIR)) {
    rmSync(join(TRANSCRIPTS_DIR, f), { recursive: true, force: true })
  }
}

afterAll(() => { rmSync(TRANSCRIPTS_DIR, { recursive: true, force: true }) })

describe('tryHandleAgentConversation', () => {
  it('returns false for a non-matching path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/agents/foo/other' })
    expect(await tryHandleAgentConversation(ctx)).toBe(false)
  })

  it('returns false for a non-GET method on a matching path', async () => {
    const { ctx } = makeCtx({ method: 'POST', path: '/api/agents/foo/conversation' })
    expect(await tryHandleAgentConversation(ctx)).toBe(false)
  })

  it('returns an empty timeline with a note when no transcript exists', async () => {
    cleanTranscriptsDir()
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/agents/nobody/conversation' })
    expect(await tryHandleAgentConversation(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ agent: 'nobody', entries: [], total: 0, offset: 0, hasOlder: false })
  })

  it('picks the newest of several transcript files by mtime', async () => {
    cleanTranscriptsDir()
    writeTranscript('older.jsonl', [{ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: 'old note' }] } }], -60)
    writeTranscript('newer.jsonl', [{ type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'new note' }] } }], 0)
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    const b = body() as any
    expect(b.sessionId).toBe('newer')
    expect(b.entries).toEqual([{ ts: 't2', kind: 'note', text: 'new note' }])
  })

  it('parses inbound <channel> messages, including multiple matches on one line, and skips channel-less user lines', async () => {
    cleanTranscriptsDir()
    writeTranscript('session.jsonl', [
      { type: 'user', timestamp: 't1', message: { content: '<channel source="telegram">hello</channel> some text <channel source="telegram">world</channel>' } },
      { type: 'user', timestamp: 't2', message: { content: 'a tool result, not a channel message' } },
    ])
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    const b = body() as any
    expect(b.entries).toEqual([
      { ts: 't1', kind: 'in', text: 'hello' },
      { ts: 't1', kind: 'in', text: 'world' },
    ])
  })

  it('parses assistant tool_use into reply/react/edit_message and generic action labels', async () => {
    cleanTranscriptsDir()
    writeTranscript('session.jsonl', [
      {
        type: 'assistant', timestamp: 't1', message: {
          content: [
            { type: 'tool_use', name: 'mcp__plugin_telegram_telegram__reply', input: { text: 'a reply' } },
            { type: 'tool_use', name: 'mcp__plugin_telegram_telegram__react', input: { emoji: '👍' } },
            { type: 'tool_use', name: 'mcp__plugin_telegram_telegram__edit_message', input: { text: 'edited' } },
            { type: 'tool_use', name: 'Bash', input: { description: 'list files' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'a very long command '.repeat(10) } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x.txt' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/y.txt' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/z.txt' } },
            { type: 'tool_use', name: 'mcp__gmail__search_gmail', input: { query: 'invoices' } },
            { type: 'tool_use', name: 'mcp__gmail__draft_gmail', input: { subject: 'draft subj' } },
            { type: 'tool_use', name: 'mcp__gmail__send_gmail', input: { subject: 'sent subj' } },
            { type: 'tool_use', name: 'mcp__drive__import_to_google_doc', input: { file_name: 'doc.md' } },
            { type: 'tool_use', name: 'mcp__drive__import_to_google_slides', input: { file_name: 'deck.md' } },
            { type: 'tool_use', name: 'WebSearch', input: { query: 'weather' } },
            { type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } },
            { type: 'tool_use', name: 'mcp__telegram__download_attachment', input: {} },
            { type: 'tool_use', name: 'SomeUnknownTool', input: {} },
            { type: 'tool_use', name: 'mcp__scoped__SomeUnknownTool', input: {} },
          ],
        },
      },
    ])
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    const entries = (body() as any).entries
    expect(entries[0]).toEqual({ ts: 't1', kind: 'out', text: 'a reply', label: 'válasz' })
    expect(entries[1]).toEqual({ ts: 't1', kind: 'out', text: '👍', label: 'reakció' })
    expect(entries[2]).toEqual({ ts: 't1', kind: 'out', text: 'edited', label: 'szerkesztés' })
    expect(entries[3]).toEqual({ ts: 't1', kind: 'action', text: 'Bash: list files' })
    expect(entries[4].text).toMatch(/^Bash: a very long command( a very long command){0,}/)
    expect(entries[4].text.length).toBeLessThanOrEqual('Bash: '.length + 80)
    expect(entries[5]).toEqual({ ts: 't1', kind: 'action', text: 'Read: /tmp/x.txt' })
    expect(entries[6]).toEqual({ ts: 't1', kind: 'action', text: 'Write: /tmp/y.txt' })
    expect(entries[7]).toEqual({ ts: 't1', kind: 'action', text: 'Edit: /tmp/z.txt' })
    expect(entries[8]).toEqual({ ts: 't1', kind: 'action', text: 'Gmail keresés: invoices' })
    expect(entries[9]).toEqual({ ts: 't1', kind: 'action', text: 'Gmail draft: draft subj' })
    expect(entries[10]).toEqual({ ts: 't1', kind: 'action', text: 'Email küldés: sent subj' })
    expect(entries[11]).toEqual({ ts: 't1', kind: 'action', text: 'Google Doc: doc.md' })
    expect(entries[12]).toEqual({ ts: 't1', kind: 'action', text: 'Google Slides: deck.md' })
    expect(entries[13]).toEqual({ ts: 't1', kind: 'action', text: 'Web keresés: weather' })
    expect(entries[14]).toEqual({ ts: 't1', kind: 'action', text: 'Web lekérés: https://example.com' })
    expect(entries[15]).toEqual({ ts: 't1', kind: 'action', text: 'Csatolmány letöltés' })
    expect(entries[16]).toEqual({ ts: 't1', kind: 'action', text: 'SomeUnknownTool' })
    expect(entries[17]).toEqual({ ts: 't1', kind: 'action', text: 'SomeUnknownTool' })
  })

  it('skips empty-text assistant note and reply blocks, and non-array assistant content', async () => {
    cleanTranscriptsDir()
    writeTranscript('session.jsonl', [
      { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: '   ' }] } },
      { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'tool_use', name: 'mcp__x__reply', input: {} }] } },
      { type: 'assistant', timestamp: 't3', message: { content: 'not an array' } },
      { type: 'other', timestamp: 't4', message: { content: 'ignored type' } },
      { type: 'assistant', timestamp: 't5' },
    ])
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    expect((body() as any).entries).toEqual([])
  })

  it('skips malformed JSON lines and blank lines without crashing', async () => {
    cleanTranscriptsDir()
    writeTranscript('session.jsonl', [
      'not json at all {{{',
      '',
      { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: 'ok note' }] } },
    ])
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    expect((body() as any).entries).toEqual([{ ts: 't1', kind: 'note', text: 'ok note' }])
  })

  it('clips text longer than 6000 characters', async () => {
    cleanTranscriptsDir()
    const long = 'x'.repeat(6100)
    writeTranscript('session.jsonl', [
      { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: long }] } },
    ])
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    const text = (body() as any).entries[0].text as string
    expect(text.endsWith(' …')).toBe(true)
    expect(text.length).toBe(6000 + 2)
  })

  it('paginates: default limit/offset, custom limit capped at 2000, and hasOlder', async () => {
    cleanTranscriptsDir()
    const lines = Array.from({ length: 10 }, (_, i) => ({
      type: 'assistant', timestamp: `t${i}`, message: { content: [{ type: 'text', text: `note ${i}` }] },
    }))
    writeTranscript('session.jsonl', lines)

    const first = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation?limit=3' })
    await tryHandleAgentConversation(first.ctx)
    const firstBody = first.body() as any
    expect(firstBody.total).toBe(10)
    expect(firstBody.count).toBe(3)
    expect(firstBody.hasOlder).toBe(true)
    expect(firstBody.entries.map((e: any) => e.text)).toEqual(['note 7', 'note 8', 'note 9'])

    const second = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation?limit=3&offset=3' })
    await tryHandleAgentConversation(second.ctx)
    const secondBody = second.body() as any
    expect(secondBody.entries.map((e: any) => e.text)).toEqual(['note 4', 'note 5', 'note 6'])

    const uncapped = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation?limit=999999' })
    await tryHandleAgentConversation(uncapped.ctx)
    expect((uncapped.body() as any).hasOlder).toBe(false)
    expect((uncapped.body() as any).count).toBe(10)

    const invalidParams = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation?limit=abc&offset=-5' })
    await tryHandleAgentConversation(invalidParams.ctx)
    expect((invalidParams.body() as any).count).toBe(10)
  })

  it('returns 500 when the newest "transcript" is actually unreadable (e.g. a directory)', async () => {
    cleanTranscriptsDir()
    mkdirSync(join(TRANSCRIPTS_DIR, 'broken.jsonl'))
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/agents/foo/conversation' })
    await tryHandleAgentConversation(ctx)
    expect(status()).toBe(500)
    expect(body()).toMatchObject({ error: 'internal_error' })
  })
})
