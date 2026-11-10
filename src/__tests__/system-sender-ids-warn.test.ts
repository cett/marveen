// SYSTEM_SENDER_IDS is empty by default. When it names anything, the dashboard says so at start-up (a WARN with the
// listed ids, nothing else), because a listed id is a platform sender that any admin-role caller can post as, outside the
// sender routing table. Behaviour is unchanged; these tests pin only the log. All ids are neutral.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'
import { parseSystemSenderIds } from '../config.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { SYSTEM_SENDERS, warnAboutSystemSenders } from '../web/sender-routing-wire.js'

const fakeLog = () => ({ warn: vi.fn() })

describe('warnAboutSystemSenders', () => {
  it('an empty list logs nothing and returns 0', () => {
    const log = fakeLog()
    expect(warnAboutSystemSenders(new Set<string>(), log)).toBe(0)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('a non-empty list logs exactly one WARN with the ids, sorted, and returns how many', () => {
    const log = fakeLog()
    expect(warnAboutSystemSenders(new Set(['sys-b', 'sys-a']), log)).toBe(2)
    expect(log.warn).toHaveBeenCalledTimes(1)
    const [fields, message] = log.warn.mock.calls[0]
    expect(fields).toEqual({ ids: ['sys-a', 'sys-b'] })
    expect(message).toContain('SYSTEM_SENDER_IDS')
  })

  it('a single id is enough', () => {
    const log = fakeLog()
    expect(warnAboutSystemSenders(new Set(['sys-a']), log)).toBe(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('logs the normalised ids the route matches on, not the raw setting', () => {
    const log = fakeLog()
    const set = parseSystemSenderIds(' @sys-a. , sys-b,, ', sanitizeAgentIdent)
    warnAboutSystemSenders(set, log)
    expect(log.warn.mock.calls[0][0]).toEqual({ ids: ['sys-a', 'sys-b'] })
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain('@sys-a.')
  })

  it('does not change the list it is given', () => {
    const set = new Set(['sys-b', 'sys-a'])
    warnAboutSystemSenders(set, fakeLog())
    expect([...set]).toEqual(['sys-b', 'sys-a'])
  })

  it('the default is the configured list, and in a default install (unset => empty) it logs nothing through the real logger', () => {
    expect(SYSTEM_SENDERS.size).toBe(0)
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      expect(warnAboutSystemSenders()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the start-up wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const WEB_SRC = readFileSync(join(here, '../web.ts'), 'utf-8')

  it('startWebServer calls warnAboutSystemSenders, before the server is created', () => {
    const start = WEB_SRC.indexOf('export async function startWebServer(')
    expect(start).toBeGreaterThan(-1)
    const call = WEB_SRC.indexOf('warnAboutSystemSenders()', start)
    expect(call).toBeGreaterThan(start)
    expect(call).toBeLessThan(WEB_SRC.indexOf('server.listen(', start))
    expect(WEB_SRC).toMatch(/import \{ warnAboutSystemSenders \} from '\.\/web\/sender-routing-wire\.js'/)
  })
})
