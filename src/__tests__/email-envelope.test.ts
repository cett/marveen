// The email envelope contract: the server's canonical form and hash must reproduce the golden vectors,
// which an independent reference implementation wrote and the send gate's tests load as well. A
// byte of difference here means a gate hash the server would refuse.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEmailEnvelope, describeEmail, compareCodePoints, canonicalJson, type CanonEnvelope } from '../web/email-envelope.js'

const VECTORS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', '__tests__', 'email-envelope-vectors.json'), 'utf8')) as {
  version: number
  valid: { name: string; agent: string; envelope: Record<string, unknown>; canon: string; hash: string }[]
  invalid: { name: string; agent: string; envelope: Record<string, unknown>; field: string }[]
}

const mail = (extra: Record<string, unknown> = {}) => ({ to: ['owner@example.com'], subject: 'Hello', body: 'Hi there', ...extra })

describe('the golden vectors', () => {
  it('are a real contract: enough cases, every kind of difficult text among them', () => {
    expect(VECTORS.version).toBe(1)
    expect(VECTORS.valid.length).toBeGreaterThanOrEqual(40)
    expect(VECTORS.invalid.length).toBeGreaterThanOrEqual(30)
    const all = VECTORS.valid.map((v) => v.canon).join('\n')
    expect(all).toMatch(/Árvíztűrő/) // Hungarian accents
    expect(all).toMatch(/\u{1F389}/u) // astral emoji
    expect(all).toContain(' ') // line separator, left raw by both sides
    expect(all).toContain('\\u0001') // a control character, escaped
    expect(all).toContain('\u007f') // DEL stays raw
    expect(all).toContain('"cc":[],"') // empty arrays are there
    expect(new Set(VECTORS.valid.map((v) => v.hash)).size).toBeGreaterThan(VECTORS.valid.length - 4) // different mails, different hashes
  })

  it.each(VECTORS.valid.map((v) => [v.name, v] as const))('reproduces %s', (_name, v) => {
    const r = parseEmailEnvelope(v.envelope, v.agent)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.canon).toBe(v.canon)
    expect(r.hash).toBe(v.hash)
    // The canonical form is itself a valid envelope with the same hash (it is what the row stores).
    const again = parseEmailEnvelope(JSON.parse(r.canon), v.agent)
    expect(again.ok && again.hash).toBe(v.hash)
  })

  it.each(VECTORS.invalid.map((v) => [v.name, v] as const))('refuses %s', (_name, v) => {
    const r = parseEmailEnvelope(v.envelope, v.agent)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe(v.field)
  })
})

describe('what the hash is bound to', () => {
  const hashOf = (env: Record<string, unknown>, agent = 'main') => {
    const r = parseEmailEnvelope(env, agent)
    if (!r.ok) throw new Error(r.hint)
    return r.hash
  }

  it('changes with each field and with the agent', () => {
    const base = hashOf(mail())
    const others = [
      mail({ to: ['owner@example.com', 'extra@example.com'] }), mail({ cc: ['owner@example.com'] }), mail({ bcc: ['owner@example.com'] }),
      mail({ subject: 'Hello!' }), mail({ body: 'Hi there ' }), mail({ html_sha256: 'a'.repeat(64) }),
      mail({ attachments: [{ name: 'a', size: 1, sha256: 'a'.repeat(64) }] }),
      mail({ from: 'me@example.com' }), mail({ reply_to: 'me@example.com' }), mail({ in_reply_to: '<id@example.com>' }),
    ]
    for (const o of others) expect(hashOf(o)).not.toBe(base)
    expect(hashOf(mail(), 'worker')).not.toBe(base)
  })

  it('does not move the boundary between subject and body', () => {
    expect(hashOf(mail({ subject: 'Hi', body: 'Bob' }))).not.toBe(hashOf(mail({ subject: 'HiBob', body: 'x' })))
    expect(hashOf(mail({ subject: 'Hi', body: 'Bob' }))).not.toBe(hashOf(mail({ subject: 'HiB', body: 'ob' })))
  })

  it('does not fold line endings or Unicode normalization forms', () => {
    expect(hashOf(mail({ body: 'a\r\nb' }))).not.toBe(hashOf(mail({ body: 'a\nb' })))
    expect(hashOf(mail({ body: 'é' }))).not.toBe(hashOf(mail({ body: 'é' })))
  })

  it('is the same for a different order, case of the domain and repeats of the recipients', () => {
    expect(hashOf(mail({ to: ['B@Example.com', 'a@example.com', 'a@EXAMPLE.com'] }))).toBe(hashOf(mail({ to: ['a@example.com', 'B@example.com'] })))
  })

  it('keeps the case of the local part (a mailbox may tell them apart)', () => {
    expect(hashOf(mail({ to: ['Alice@example.com'] }))).not.toBe(hashOf(mail({ to: ['alice@example.com'] })))
  })

  it('ignores an agent the client names and keeps the one the server knows', () => {
    const r = parseEmailEnvelope(mail({ agent: 'someone-else', v: 1 }), 'main')
    expect(r.ok && r.envelope.agent).toBe('main')
    expect(r.ok && r.hash).toBe(hashOf(mail()))
  })
})

describe('compareCodePoints', () => {
  it('orders by code point where a UTF-16 comparison would not', () => {
    const emoji = '\u{1F389}'
    const fullwidth = '～'
    expect(emoji < fullwidth).toBe(true) // the trap: UTF-16 units put the emoji first
    expect(compareCodePoints(emoji, fullwidth)).toBe(1)
    expect(compareCodePoints(fullwidth, emoji)).toBe(-1)
    expect(compareCodePoints('a', 'a')).toBe(0)
    expect(compareCodePoints('a', 'ab')).toBe(-1)
    expect(compareCodePoints('B', 'a')).toBe(-1)
  })
})

describe('canonicalJson', () => {
  it('writes the keys in sorted order, compact, with non-ASCII text left as it is', () => {
    const e: CanonEnvelope = {
      v: 1, agent: 'main', to: ['a@example.com'], cc: [], bcc: [], subject: 'á', body: 'b',
      from: 'f@example.com', in_reply_to: 'i', reply_to: 'r@example.com', html_sha256: 'h',
      attachments: [{ name: 'n', size: 1, sha256: 's' }],
    }
    expect(canonicalJson(e)).toBe('{"agent":"main","attachments":[{"name":"n","sha256":"s","size":1}],"bcc":[],"body":"b","cc":[],"from":"f@example.com","html_sha256":"h","in_reply_to":"i","reply_to":"r@example.com","subject":"á","to":["a@example.com"],"v":1}')
  })
})

describe('describeEmail', () => {
  const described = (extra: Record<string, unknown> = {}) => {
    const r = parseEmailEnvelope(mail(extra), 'main')
    if (!r.ok) throw new Error(r.hint)
    return describeEmail(r.envelope, r.hash)
  }

  it('shows every recipient field, bcc included, the subject, the body start and the hash prefix', () => {
    const text = described({ to: ['a@example.com'], cc: ['c@example.com'], bcc: ['hidden@example.com'], subject: 'Quarterly', body: 'Dear all' })
    expect(text).toContain('to: a@example.com')
    expect(text).toContain('cc: c@example.com')
    expect(text).toContain('bcc: hidden@example.com')
    expect(text).toContain('subject: "Quarterly"')
    expect(text).toContain('body (8 chars): "Dear all"')
    expect(text).toMatch(/hash [0-9a-f]{12}$/)
  })

  it('lists attachments by name, size and fingerprint', () => {
    expect(described({ attachments: [{ name: 'plan.pdf', size: 42, sha256: 'ab'.repeat(32) }] })).toContain('attachments: plan.pdf (42 bytes, sha256 abababababab)')
  })

  it('flattens line breaks and drops invisible characters, so one request stays one line of plain text', () => {
    const text = described({ subject: 'a\nb​c', body: 'x\r\ny‮z' })
    expect(text).not.toMatch(/[\n\r​‮]/)
    expect(text).toContain('subject: "a bc"')
  })

  it('cuts a long body and a long recipient list', () => {
    const text = described({ body: 'x'.repeat(5000), to: Array.from({ length: 30 }, (_, i) => `u${i}@example.com`) })
    expect(text.length).toBeLessThan(1200)
    expect(text).toContain('(+20 more)')
    expect(text).toContain('body (5000 chars)')
    expect(text).toContain('...')
  })
})

describe('limits', () => {
  it('refuses 101 recipients and accepts 100', () => {
    const many = (n: number) => mail({ to: Array.from({ length: n }, (_, i) => `u${i}@example.com`) })
    expect(parseEmailEnvelope(many(100), 'main').ok).toBe(true)
    expect(parseEmailEnvelope(many(101), 'main').ok).toBe(false)
  })

  it('refuses 21 attachments and accepts 20', () => {
    const files = (n: number) => mail({ attachments: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, size: 1, sha256: 'a'.repeat(64) })) })
    expect(parseEmailEnvelope(files(20), 'main').ok).toBe(true)
    expect(parseEmailEnvelope(files(21), 'main').ok).toBe(false)
  })

  it('refuses anything that is not an object', () => {
    for (const bad of [null, [], 'x', 5, true]) expect(parseEmailEnvelope(bad, 'main')).toMatchObject({ ok: false, field: 'action_payload' })
  })

  it('never throws on hostile input', () => {
    const hostile: unknown[] = [{ to: { length: 1 } }, { to: ['a@example.com'], subject: {}, body: 'b' }, { to: [null], subject: '', body: 'b' }, { __proto__: { to: ['a@example.com'] } }, { constructor: 1 }]
    for (const h of hostile) expect(() => parseEmailEnvelope(h, 'main')).not.toThrow()
  })
})
