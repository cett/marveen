// The server's own token names that the admin API refuses to hand out. The list is pinned twice: as a table of
// look-alikes, and against the names the server really gives (issue, operator, the dashboard enrolment), so a
// rename in agent-tokens.ts cannot leave a name the check looks up by unprotected.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get STORE_DIR() { return join(state.root, 'store') },
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  agentConfigRoot: (name: string) => (name === 'main-agent' ? state.root : join(state.root, 'agents', name)),
}))

import { initDatabase, listApiTokenRows, enrollDashboardApiToken } from '../db.js'
import { issueAgentToken, issueOperatorToken } from '../agent-tokens.js'
import { isReservedTokenName } from '../reserved-token-names.js'
import { deviceTokenName } from '../remote-enroll-device-key.js'

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'reserved-token-names-'))
  mkdirSync(join(state.root, 'agents', 'alpha'), { recursive: true })
  mkdirSync(join(state.root, 'store'), { recursive: true })
  initDatabase(':memory:')
})
afterEach(() => { rmSync(state.root, { recursive: true, force: true }) })

describe('isReservedTokenName', () => {
  it.each([
    'operator', 'dashboard', 'main-agent:x', 'fleet-agent:x',
    'OPERATOR', 'Dashboard', 'Fleet-Agent:X', '  operator', 'oper\tator', 'main-agent :x', 'ｏｐｅｒａｔｏｒ', 'op​erator',
  ])('%j is reserved', (name) => { expect(isReservedTokenName(name)).toBe(true) })

  // Written as escapes so the invisible characters stay visible in the source.
  it.each([
    // A mark with a precomposed form (r + U+0301) becomes a visible letter under NFKC and is a different name.
    ['combining mark without a precomposed form', 'oper\u20D2ator'],
    ['combining grapheme joiner', 'oper\u034Fator'],
    ['Hangul filler U+3164', 'oper\u3164ator'],
    ['Hangul choseong filler U+115F', 'oper\u115Fator'],
    ['Hangul jungseong filler U+1160', 'oper\u1160ator'],
    ['halfwidth Hangul filler U+FFA0', 'oper\uFFA0ator'],
    ['braille blank U+2800', 'oper\u2800ator'],
    ['variation selector U+FE0F', 'oper\uFE0Fator'],
    ['Mongolian variation selector U+180B', 'oper\u180Bator'],
    ['en dash in a prefix', 'main\u2013agent:x'],
    ['em dash in a prefix', 'main\u2014agent:x'],
    ['minus sign in a prefix', 'fleet\u2212agent:x'],
    ['hyphen U+2010 in a prefix', 'fleet\u2010agent:x'],
    ['non-breaking hyphen U+2011 in a prefix', 'main\u2011agent:x'],
    ['ratio U+2236 as the colon', 'main-agent\u2236x'],
    ['modifier colon U+A789 as the colon', 'fleet-agent\uA789x'],
    ['Armenian full stop U+0589 as the colon', 'main-agent\u0589x'],
    ['several tricks at once', 'Main\u2014Agent\u3164\u2236 x'],
  ])('%s is reserved', (_label, name) => { expect(isReservedTokenName(name)).toBe(true) })

  it('a device label with a reserved prefix makes the remote-enrollment token name reserved, a plain label does not', () => {
    const installId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    expect(isReservedTokenName(deviceTokenName('main-agent:phone', installId))).toBe(true)
    expect(isReservedTokenName(deviceTokenName('Fleet-Agent:x', installId))).toBe(true)
    expect(isReservedTokenName(deviceTokenName('Office phone', installId))).toBe(false)
    expect(isReservedTokenName(deviceTokenName(undefined, installId))).toBe(false)
  })

  it('does not fold a Cyrillic homoglyph (a known limit: that needs a confusables skeleton)', () => {
    expect(isReservedTokenName('\u043Eperator')).toBe(false)
  })

  it.each([
    '', 'ci', 'operators', 'operator-1', 'my-dashboard', 'dashboard2', 'main-agent', 'fleet-agent', 'xmain-agent:x', 'browser 2026-10-25 ab12',
  ])('%j is free', (name) => { expect(isReservedTokenName(name)).toBe(false) })

  it('every name the server gives its own tokens is reserved', async () => {
    await issueAgentToken('alpha')
    await issueAgentToken('main-agent')
    await issueOperatorToken()
    await enrollDashboardApiToken('a'.repeat(64), Math.floor(Date.now() / 1000))

    const names = (await listApiTokenRows()).map(r => r.name)
    expect(names.sort()).toEqual(['dashboard', 'fleet-agent:alpha', 'main-agent:main-agent', 'operator'])
    for (const name of names) expect(isReservedTokenName(name), name).toBe(true)
  })
})
