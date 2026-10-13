// The Approvals detail view for an email request and the event timeline of any request. Part 1 tests the
// pure builders (web/modules/approval-email-view.js) against real hu/en strings; part 2 runs the real
// web/modules/approvals.js against a small fake DOM and clicks a row, so what is asserted is the markup
// a person would get, including that an agent-written body never becomes markup; part 3 holds the
// wiring (CSS, markup, i18n key coverage) as string contracts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAllCss } from './css-helper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(__dirname, '../../web', p), 'utf-8')

const HASH = 'ab12cd34ef56' + '0'.repeat(52)
const BODY_ATTACK = '<script>window.pwned = 1</script><img src=x onerror="window.pwned=2">line two\n& "quoted" \'single\''
const ENVELOPE = {
  v: 1,
  agent: 'main-agent',
  to: ['bob@example.test', 'worker"><img src=x onerror=alert(1)>@example.test'],
  cc: [],
  bcc: ['audit@example.test'],
  subject: 'Quarterly <b>numbers</b>',
  body: BODY_ATTACK,
  html_sha256: '1'.repeat(64),
  attachments: [{ name: '<report>.pdf', size: 2048, sha256: '2'.repeat(64) }],
  from: 'main@example.test',
  reply_to: 'reply@example.test',
  in_reply_to: '<thread-1@example.test>',
}
const EMAIL_ROW = {
  id: 'm1', agent_id: 'main-agent', category: 'email_send', status: 'approved', human_only: 1,
  action_description: 'Email from main-agent | to: bob@example.test | subject: "Quarterly" | ' + 'x'.repeat(200),
  action_payload: JSON.stringify(ENVELOPE), content_hash: HASH,
  requested_at: 1_000_000, timeout_at: null, resolved_by: 'human:session:person-a', resolved_at: 1_000_100,
  resolved_via: 'dashboard_session', consumed_at: 1_000_200, consumed_by: 'main-agent', consumed_ref: 'run-1',
}
const OTHER_ROW = {
  id: 'd1', agent_id: 'worker', category: 'deploy', status: 'pending', human_only: 0,
  action_description: 'ship it', action_payload: JSON.stringify({ note: '<b>not a mail</b>' }), content_hash: null,
  requested_at: 1_000_000, timeout_at: null, resolved_by: null, resolved_at: null, resolved_via: null, consumed_at: null, consumed_by: null,
}

const i18nFor = (lang: 'hu' | 'en') => {
  const win: any = { _i18n: {}, _brandTokens: {} }
  vm.runInNewContext(read('lang/hu.js'), { window: win })
  vm.runInNewContext(read('lang/en.js'), { window: win })
  return { win, lang }
}

async function loadView(lang: 'hu' | 'en' = 'en') {
  const { win } = i18nFor(lang)
  vi.stubGlobal('window', win)
  vi.stubGlobal('localStorage', { getItem: () => lang })
  vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({}) }))
  vi.resetModules()
  return await import('../../web/modules/approval-email-view.js')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('truncateDescription / shortHash / parseEmailPayload', () => {
  it('cuts at 80 characters with an ellipsis, leaves an 80-character text alone, survives null', async () => {
    const v = await loadView()
    expect(v.truncateDescription('a'.repeat(80), 80)).toBe('a'.repeat(80))
    expect(v.truncateDescription('a'.repeat(81), 80)).toBe('a'.repeat(80) + '...')
    expect(v.truncateDescription(null)).toBe('')
    expect(v.truncateDescription(undefined, 80)).toBe('')
  })

  it('cuts by code point: an astral character is never split into a lone surrogate', async () => {
    const v = await loadView()
    const cut = v.truncateDescription('\u{1F600}'.repeat(90), 80)
    expect(cut).toBe('\u{1F600}'.repeat(80) + '...')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false)
  })

  it('shortHash is the first 12 hex of a sha256 and nothing for anything else', async () => {
    const v = await loadView()
    expect(v.shortHash(HASH)).toBe('ab12cd34ef56')
    expect(v.shortHash('AB12'.repeat(16))).toBe('')
    expect(v.shortHash('ab12')).toBe('')
    expect(v.shortHash('<script>' + '0'.repeat(56))).toBe('')
    expect(v.shortHash(null)).toBe('')
    expect(v.shortHash(42)).toBe('')
  })

  it('parseEmailPayload reads the envelope and gives a safe type to every field', async () => {
    const v = await loadView()
    const p = v.parseEmailPayload(JSON.stringify(ENVELOPE))!
    expect(p.to).toHaveLength(2)
    expect(p.bcc).toEqual(['audit@example.test'])
    expect(p.attachments).toEqual([{ name: '<report>.pdf', size: 2048, sha256: '2'.repeat(64) }])
    const odd = v.parseEmailPayload(JSON.stringify({ to: 'bob@example.test', cc: [1, 'ok@example.test', null], subject: 5, body: { x: 1 }, attachments: [null, { name: 3 }, 'x'] }))!
    expect(odd.to).toEqual([])
    expect(odd.cc).toEqual(['ok@example.test'])
    expect(odd.subject).toBe('')
    expect(odd.body).toBe('')
    expect(odd.attachments).toEqual([{ name: '', size: null, sha256: '' }])
  })

  it.each([['undefined', undefined], ['null', null], ['empty', ''], ['blank', '   '], ['not JSON', '{oops'], ['an array', '[1,2]'], ['a string literal', '"x"'], ['null literal', 'null'], ['a number', 7]])(
    'parseEmailPayload is null for %s',
    async (_n, raw) => {
      const v = await loadView()
      expect(v.parseEmailPayload(raw)).toBeNull()
    },
  )
})

describe('approvalStateBadges', () => {
  const kinds = (a: object, opts?: { compact?: boolean; windowS?: number | null; nowS?: number }, v?: any) => v.approvalStateBadges(a, opts).map((b: any) => b.kind)

  it('a used-up mail says when and by whom, in both languages', async () => {
    const en = await loadView('en')
    const [b] = en.approvalStateBadges(EMAIL_ROW)
    expect(b.kind).toBe('consumed')
    expect(b.label).toMatch(/^Used up \(.+, main-agent\)$/)
    const hu = await loadView('hu')
    expect(hu.approvalStateBadges(EMAIL_ROW)[0].label).toMatch(/^Elfogyasztva \(.+, main-agent\)$/)
  })

  it('a consumed row with no consumer name shows a dash, not the word undefined', async () => {
    const v = await loadView()
    expect(v.approvalStateBadges({ ...EMAIL_ROW, consumed_by: null })[0].label).toMatch(/, -\)$/)
  })

  it('an approved, unused, hash-bound request is marked as not used yet', async () => {
    const v = await loadView()
    const row = { ...EMAIL_ROW, consumed_at: null, consumed_by: null }
    expect(kinds(row, undefined, v)).toContain('unused')
    expect(kinds(row, undefined, v)).not.toContain('consumed')
  })

  it('an approved request with no hash can never be used up, so it is not marked unused', async () => {
    const v = await loadView()
    expect(kinds({ status: 'approved', content_hash: null, resolved_via: 'bearer' }, undefined, v)).toEqual(['token'])
  })

  describe('the use window', () => {
    // resolved_at 1_000_100, window 1800: the last second it can still be used up is 1_001_900.
    const unusedRow = { ...EMAIL_ROW, consumed_at: null, consumed_by: null }
    // the use markers only; the decision marker (human/token) is a separate concern
    const states = (a: object, opts: { compact?: boolean; windowS?: number | null; nowS?: number } | undefined, v: any) =>
      kinds(a, opts, v).filter((k: string) => ['consumed', 'unused', 'lapsed'].includes(k))
    const at = (nowS: number, windowS: number | null = 1800) => ({ windowS, nowS })

    it('an approved, unused request decided longer ago than the window is lapsed, in both languages', async () => {
      const en = await loadView('en')
      const [b] = en.approvalStateBadges(unusedRow, at(1_001_901))
      expect(b.kind).toBe('lapsed')
      expect(b.label).toBe('Expired (window)')
      expect(b.title).toBe('Approved, but not used within 30 minutes, so it can no longer be used')
      const hu = await loadView('hu')
      const [h] = hu.approvalStateBadges(unusedRow, at(1_001_901))
      expect(h.label).toBe('Lejárt (ablak)')
      expect(h.title).toContain('30 percen belül')
    })

    it('the cut is the server one: exactly at the window it is still unused, one second later it is lapsed', async () => {
      const v = await loadView()
      expect(states(unusedRow, at(1_001_900), v)).toEqual(['unused'])
      expect(states(unusedRow, at(1_001_901), v)).toEqual(['lapsed'])
    })

    it('inside the window, and without a known window, it stays unused', async () => {
      const v = await loadView()
      expect(states(unusedRow, at(1_000_200), v)).toEqual(['unused'])
      expect(states(unusedRow, at(9_999_999, null), v)).toEqual(['unused'])
      expect(states(unusedRow, { nowS: 9_999_999 }, v)).toEqual(['unused'])
      expect(states(unusedRow, at(9_999_999, 0), v)).toEqual(['unused'])
      expect(states(unusedRow, at(9_999_999, Number.NaN), v)).toEqual(['unused'])
    })

    it('a used-up request is never lapsed, however old; nor is one with no hash or no decision time', async () => {
      const v = await loadView()
      expect(states(EMAIL_ROW, at(9_999_999), v)).toEqual(['consumed'])
      expect(states({ ...unusedRow, content_hash: null }, at(9_999_999), v)).not.toContain('lapsed')
      expect(states({ ...unusedRow, resolved_at: null }, at(9_999_999), v)).toEqual(['unused'])
      expect(states({ ...unusedRow, status: 'rejected' }, at(9_999_999), v)).not.toContain('lapsed')
      expect(states({ ...unusedRow, status: 'timeout', resolved_at: null }, at(9_999_999), v)).not.toContain('lapsed')
    })

    it('the compact (list) form carries it too, and replaces the unused marker rather than joining it', async () => {
      const v = await loadView()
      expect(states(unusedRow, { compact: true, ...at(1_001_901) }, v)).toEqual(['lapsed'])
      expect(states(unusedRow, { compact: true, ...at(1_000_300) }, v)).toEqual(['unused'])
    })
  })

  it('a pending or rejected hash-bound request is neither used nor unused', async () => {
    const v = await loadView()
    expect(kinds({ ...EMAIL_ROW, status: 'pending', consumed_at: null, resolved_via: null }, undefined, v)).toEqual([])
    expect(kinds({ ...EMAIL_ROW, status: 'rejected', consumed_at: null, resolved_via: 'dashboard_session' }, undefined, v)).toEqual(['human'])
  })

  it('a request nobody decided in time is marked expired', async () => {
    const v = await loadView()
    expect(kinds({ status: 'timeout', content_hash: HASH, resolved_via: null }, undefined, v)).toEqual(['expired'])
  })

  it('the decision marker follows resolved_via: a dashboard session is a human, a bearer is an advisory token decision', async () => {
    const v = await loadView()
    expect(kinds({ status: 'approved', resolved_via: 'dashboard_session' }, undefined, v)).toEqual(['human'])
    const [tok] = v.approvalStateBadges({ status: 'approved', resolved_via: 'bearer' })
    expect(tok.kind).toBe('token')
    expect(tok.label).toBe('Token decision (advisory)')
    expect(tok.title).toBeTruthy()
    expect(kinds({ status: 'approved', resolved_via: 'something-else' }, undefined, v)).toEqual([])
    expect(kinds({ status: 'approved', resolved_via: null }, undefined, v)).toEqual([])
    const hu = await loadView('hu')
    expect(hu.approvalStateBadges({ status: 'approved', resolved_via: 'bearer' })[0].label).toBe('Token-döntés (advisory)')
    expect(hu.approvalStateBadges({ status: 'approved', resolved_via: 'dashboard_session' })[0].label).toBe('Emberi döntés')
    expect(hu.approvalStateBadges({ status: 'timeout' })[0].label).toBe('Lejárt')
  })

  it('compact (the list) keeps only the used-up and not-used-yet markers', async () => {
    const v = await loadView()
    expect(kinds(EMAIL_ROW, { compact: true }, v)).toEqual(['consumed'])
    expect(kinds({ ...EMAIL_ROW, consumed_at: null }, { compact: true }, v)).toEqual(['unused'])
    expect(kinds({ status: 'timeout', content_hash: HASH, resolved_via: 'bearer' }, { compact: true }, v)).toEqual([])
    expect(v.approvalStateBadges(null)).toEqual([])
  })

  it('renderBadges escapes the label and the title', async () => {
    const v = await loadView()
    const html = v.renderBadges([{ kind: 'x"><i>', label: '<b>bold</b>', title: '"><u>' }])
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<i>')
    expect(html).not.toContain('<u>')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })
})

describe('renderEmailPayload', () => {
  it('shows each recipient on its own line, the subject, the whole body, the attachment name and sha256', async () => {
    const v = await loadView()
    const html = v.renderEmailPayload(v.parseEmailPayload(JSON.stringify(ENVELOPE)))
    expect((html.match(/approvals-email-line/g) ?? []).length).toBeGreaterThanOrEqual(4) // 2 to + 1 bcc + 1 attachment
    expect(html).toContain('bob@example.test')
    expect(html).toContain('audit@example.test')
    expect(html).toContain('Quarterly &lt;b&gt;numbers&lt;/b&gt;')
    expect(html).toContain('&lt;report&gt;.pdf (2048 bytes)')
    expect(html).toContain('2'.repeat(64))
    expect(html).toContain('1'.repeat(64)) // the html part sha256
    expect(html).toContain('approvals-email-body')
    expect(html).toContain('reply@example.test')
    expect(html).toContain('&lt;thread-1@example.test&gt;')
  })

  it('an empty cc is said out loud, not hidden', async () => {
    const v = await loadView()
    const html = v.renderEmailPayload(v.parseEmailPayload(JSON.stringify(ENVELOPE)))
    expect(html).toMatch(/Cc<\/span>\s*<span class="approvals-detail-value"><span class="approvals-email-none">\(none\)<\/span>/)
  })

  it('escapes the agent-written body, subject, names and addresses: nothing becomes an element or an attribute', async () => {
    const v = await loadView()
    const html = v.renderEmailPayload(v.parseEmailPayload(JSON.stringify(ENVELOPE)))
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<b>/i)
    expect(html).not.toMatch(/<report>/i)
    expect(html).not.toMatch(/<[^>]*\sonerror=/i)
    expect(html).toContain('&lt;script&gt;window.pwned = 1&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;window.pwned=2&quot;&gt;line two')
    expect(html).toContain('&amp; &quot;quoted&quot; &#39;single&#39;')
  })

  it('a missing payload says so instead of rendering an empty mail', async () => {
    const v = await loadView()
    expect(v.renderEmailPayload(null)).toContain('missing or unreadable')
    const hu = await loadView('hu')
    expect(hu.renderEmailPayload(null)).toContain('hiányoznak vagy nem olvashatók')
  })
})

describe('renderTimeline / sortEvents / eventLabel', () => {
  const EVENTS = [
    { id: 5, event: 'consumed', reason: 'main-agent', actor: 'main-agent', ref: 'run-1', created_at: 300 },
    { id: 2, event: 'consume_refused', reason: 'hash_mismatch', actor: 'main-agent', ref: 'run-0', created_at: 200 },
    { id: 4, event: 'notify_suppressed', reason: 'rate_limited', actor: 'system', created_at: 100 },
    { id: 3, event: 'owner_unreached', actor: 'system', created_at: 100 },
    { id: 6, event: 'bearer_denied', reason: 'human_only_category', actor: 'worker', created_at: 150 },
    { id: 1, event: 'created_deduplicated', actor: 'main-agent', created_at: 90 },
  ]

  it('lists the events oldest first, ties broken by id', async () => {
    const v = await loadView()
    expect(v.sortEvents(EVENTS).map((e) => e.id)).toEqual([1, 3, 4, 6, 2, 5])
    expect(v.sortEvents(null)).toEqual([])
    expect(v.sortEvents([null, 'x', { id: 1, created_at: 1 }]).map((e) => e.id)).toEqual([1])
    const html = v.renderTimeline([...EVENTS].reverse())
    const order = [...html.matchAll(/data-event="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(['created_deduplicated', 'owner_unreached', 'notify_suppressed', 'bearer_denied', 'consume_refused', 'consumed'])
  })

  it('every event kind and reason the server writes has a readable label in English and Hungarian, not the raw token', async () => {
    for (const lang of ['en', 'hu'] as const) {
      const v = await loadView(lang)
      for (const kind of v.EVENT_KINDS) {
        const { kind: label } = v.eventLabel({ event: kind })
        expect(label, `${lang} ${kind}`).not.toBe(kind)
        expect(label).not.toMatch(/^approvals\./)
      }
      for (const reason of v.EVENT_REASONS) {
        const { reason: label } = v.eventLabel({ event: 'consume_refused', reason })
        expect(label, `${lang} ${reason}`).not.toBe(reason)
        expect(label).not.toMatch(/^approvals\./)
      }
    }
  })

  it('labels read in the dashboard language', async () => {
    const en = await loadView('en')
    expect(en.eventLabel({ event: 'consume_refused', reason: 'hash_mismatch' })).toEqual({ kind: 'Use refused', reason: 'not the approved mail (hash differs)' })
    const hu = await loadView('hu')
    expect(hu.eventLabel({ event: 'consumed' }).kind).toBe('Felhasználva')
  })

  it('an unknown kind or reason shows as sent, escaped', async () => {
    const v = await loadView()
    expect(v.eventLabel({ event: 'future_kind', reason: 'future_reason' })).toEqual({ kind: 'future_kind', reason: 'future_reason' })
    const html = v.renderTimeline([{ id: 1, event: '<i>x</i>', reason: '<u>y</u>', actor: '<s>z</s>', ref: '"><b>', created_at: 1 }])
    expect(html).not.toMatch(/<[ius]>|<b>/i)
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
    expect(html).toContain('&lt;u&gt;y&lt;/u&gt;')
  })

  it('shows the actor and the reference of an event', async () => {
    const v = await loadView()
    const html = v.renderTimeline([EVENTS[0]])
    expect(html).toContain('by main-agent')
    expect(html).toContain('ref run-1')
    expect(html).toContain('approvals-event-ok')
    expect(v.renderTimeline([EVENTS[1]])).toContain('approvals-event-warn')
  })

  it('an empty journal says so', async () => {
    const v = await loadView()
    expect(v.renderTimeline([])).toContain('No events recorded.')
    expect(v.renderTimeline(undefined)).toContain('No events recorded.')
  })
})

// ---------------------------------------------------------------------------------------------------
// The real approvals.js in a fake DOM.

interface FakeEl { innerHTML: string; textContent: string; hidden: boolean; classList: { add(c: string): void; remove(c: string): void }; addEventListener(t: string, cb: () => void): void; querySelectorAll(): never[]; querySelector(): null; style: Record<string, string> }
function fakeEl(): FakeEl {
  return {
    innerHTML: '', textContent: '', hidden: true, style: {},
    classList: { add() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
  }
}

type EventsAnswer = { status: number; body?: unknown } | 'throw' | Promise<{ status: number; body?: unknown }>

async function mount(rows: object[], eventsFor: (id: string) => EventsAnswer, lang: 'hu' | 'en' = 'en', windowS?: number) {
  const els: Record<string, FakeEl> = {}
  const get = (id: string) => (els[id] ||= fakeEl())
  const { win } = i18nFor(lang)
  const clicks: Array<(e: unknown) => void> = []
  const eventCalls: string[] = []
  vi.stubGlobal('window', win)
  vi.stubGlobal('localStorage', { getItem: () => lang })
  vi.stubGlobal('document', {
    addEventListener: (type: string, cb: (e: unknown) => void) => { if (type === 'click') clicks.push(cb) },
    getElementById: get,
    querySelectorAll: () => [],
  })
  vi.stubGlobal('setInterval', () => 0)
  vi.stubGlobal('clearInterval', () => {})
  vi.stubGlobal('fetch', async (url: string) => {
    const m = url.match(/^\/api\/approvals\/([^/?]+)\/events$/)
    if (m) {
      eventCalls.push(url)
      const a = await eventsFor(decodeURIComponent(m[1]))
      if (a === 'throw') throw new Error('offline')
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body }
    }
    if (url.startsWith('/api/approvals')) {
      return { ok: true, status: 200, json: async () => ({ items: rows, total: rows.length, counts: { pending: 1, approved: 1, rejected: 0, timeout: 0 }, oldest_pending: null, ...(windowS === undefined ? {} : { window_s: windowS }) }) }
    }
    if (url === '/api/auth/status') return { ok: true, status: 200, json: async () => ({ authenticated: true, method: 'session', role: 'admin', tenant_id: null, human_only_enforced: true }) }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.resetModules()
  // @ts-expect-error -- plain browser module without a .d.ts
  const mod = await import('../../web/modules/approvals.js')
  await mod.loadApprovalsPage()
  const click = (id: string) => {
    const evt = { target: { closest: (sel: string) => (sel === '#approvalsTbody tr[data-approval-id]' ? { dataset: { approvalId: id } } : null) } }
    for (const cb of clicks) cb(evt)
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  // The journal is painted into its own element after the detail is built; `shown` is both, as a person sees them.
  const shown = () => get('approvalsDetailBody').innerHTML + get('approvalsEventsBody').innerHTML
  return { get, click, flush, eventCalls, shown }
}

const JOURNAL = {
  approval_id: 'm1',
  items: [
    { id: 2, approval_id: 'm1', event: 'consumed', reason: 'main-agent', actor: 'main-agent', ref: 'run-1', created_at: 1_000_200 },
    { id: 1, approval_id: 'm1', event: 'created_deduplicated', actor: 'main-agent', created_at: 1_000_050 },
  ],
}

describe('approvals.js: the list', () => {
  it('cuts the server-written description to 80 characters, keeps the whole text in the tooltip, and marks a used-up mail', async () => {
    const { get } = await mount([EMAIL_ROW, OTHER_ROW], () => ({ status: 200, body: { items: [] } }))
    const tbody = get('approvalsTbody').innerHTML
    expect(tbody).toContain('x'.repeat(10) + '...')
    const cell = tbody.match(/<td style="max-width:280px[^>]*>([^<]*)<\/td>/)![1]
    expect(Array.from(cell.replace(/&quot;/g, '"')).length).toBe(83) // 80 characters and the ellipsis
    expect(cell.endsWith('...')).toBe(true)
    expect(tbody).toContain(`title="${EMAIL_ROW.action_description.replace(/"/g, '&quot;')}"`)
    expect(tbody).toContain('approvals-state-consumed')
    expect(tbody).not.toContain('approvals-state-human') // the list stays compact
  })
})

describe('approvals.js: the use window', () => {
  const OLD_UNUSED = { ...EMAIL_ROW, id: 'u1', consumed_at: null, consumed_by: null, resolved_at: Math.floor(Date.now() / 1000) - 3600 }
  const FRESH_UNUSED = { ...OLD_UNUSED, id: 'u2', resolved_at: Math.floor(Date.now() / 1000) - 60 }

  it('the list marks an unused approval older than the window the server reported as lapsed, a fresh one as unused', async () => {
    const { get } = await mount([OLD_UNUSED, FRESH_UNUSED], () => ({ status: 200, body: { items: [] } }), 'en', 1800)
    const rows = get('approvalsTbody').innerHTML.split('</tr>')
    expect(rows[0]).toContain('approvals-state-lapsed')
    expect(rows[0]).not.toContain('approvals-state-unused')
    expect(rows[1]).toContain('approvals-state-unused')
    expect(rows[1]).not.toContain('approvals-state-lapsed')
  })

  it('the window comes from the server: a longer window keeps the same hour-old approval unused', async () => {
    const { get } = await mount([OLD_UNUSED], () => ({ status: 200, body: { items: [] } }), 'en', 86400)
    const html = get('approvalsTbody').innerHTML
    expect(html).toContain('approvals-state-unused')
    expect(html).not.toContain('approvals-state-lapsed')
  })

  it('a server that sends no window_s leaves the old marker alone', async () => {
    const { get } = await mount([OLD_UNUSED], () => ({ status: 200, body: { items: [] } }), 'en')
    const html = get('approvalsTbody').innerHTML
    expect(html).toContain('approvals-state-unused')
    expect(html).not.toContain('approvals-state-lapsed')
  })

  it('the detail of a lapsed request carries the marker too', async () => {
    const { click, flush, shown } = await mount([OLD_UNUSED], () => ({ status: 200, body: { items: [] } }), 'hu', 1800)
    click('u1')
    await flush()
    const html = shown()
    expect(html).toContain('approvals-state-lapsed')
    expect(html).toContain('Lejárt (ablak)')
  })
})

describe('approvals.js: the detail of an email request', () => {
  it('shows the mail field by field, the hash fingerprint, the markers and the timeline, all escaped', async () => {
    const { click, flush, eventCalls, shown } = await mount([EMAIL_ROW], () => ({ status: 200, body: JOURNAL }))
    click('m1')
    await flush()
    const html = shown()
    expect(eventCalls).toEqual(['/api/approvals/m1/events'])
    // the mail
    expect(html).toContain('bob@example.test')
    expect(html).toContain('audit@example.test')
    expect(html).toContain('Quarterly &lt;b&gt;numbers&lt;/b&gt;')
    expect(html).toContain('&lt;report&gt;.pdf (2048 bytes)')
    expect(html).toContain('2'.repeat(64))
    // nothing the agent wrote became markup
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<[^>]*\sonerror=/i)
    expect(html).toContain('&lt;script&gt;window.pwned = 1&lt;/script&gt;')
    // fingerprint and markers
    expect(html).toContain('>ab12cd34ef56</code>')
    expect(html).toContain(`title="${HASH}"`)
    expect(html).toContain('approvals-state-consumed')
    expect(html).toContain('approvals-state-human')
    expect(html).toContain('approvals-humanonly-badge')
    // the timeline, oldest first
    expect(html).toContain('Event timeline')
    expect(html.indexOf('Identical request folded')).toBeGreaterThan(-1)
    expect(html.indexOf('Identical request folded')).toBeLessThan(html.indexOf('>Used up</span>'))
  })

  it('reads in Hungarian when the dashboard is Hungarian', async () => {
    const { click, flush, shown } = await mount([EMAIL_ROW], () => ({ status: 200, body: JOURNAL }), 'hu')
    click('m1')
    await flush()
    const html = shown()
    expect(html).toContain('A levél')
    expect(html).toContain('Titkos másolat (bcc)')
    expect(html).toContain('Mellékletek')
    expect(html).toContain('2048 bájt')
    expect(html).toContain('Eseménytörténet')
    expect(html).toContain('Felhasználva')
    expect(html).toContain('Emberi döntés')
  })

  it('a token-decided row carries the advisory marker and no human marker', async () => {
    const row = { ...EMAIL_ROW, resolved_via: 'bearer', consumed_at: null, consumed_by: null }
    const { click, flush, shown } = await mount([row], () => ({ status: 200, body: { items: [] } }))
    click('m1')
    await flush()
    const html = shown()
    expect(html).toContain('Token decision (advisory)')
    expect(html).not.toContain('approvals-state-human')
    expect(html).toContain('approvals-state-unused')
    expect(html).toContain('No events recorded.')
  })

  it('an unreadable payload falls back to the description and says so', async () => {
    const row = { ...EMAIL_ROW, action_payload: '{broken' }
    const { click, flush, shown } = await mount([row], () => ({ status: 200, body: { items: [] } }))
    click('m1')
    await flush()
    const html = shown()
    expect(html).toContain('missing or unreadable')
    expect(html).toContain('Full description')
    expect(html).not.toContain('approvals-email-body')
  })

  it('an expired request shows the expired marker', async () => {
    const row = { ...EMAIL_ROW, status: 'timeout', resolved_via: null, consumed_at: null, consumed_by: null, resolved_at: null }
    const { click, flush, shown } = await mount([row], () => ({ status: 200, body: { items: [] } }))
    click('m1')
    await flush()
    expect(shown()).toContain('approvals-state-expired')
  })
})

describe('approvals.js: the detail of another request', () => {
  it('has no mail section (the payload is not rendered as a mail) but still gets the journal', async () => {
    const { click, flush, shown } = await mount([OTHER_ROW], () => ({ status: 200, body: { items: [{ id: 1, event: 'bearer_denied', reason: 'human_only_category', actor: 'worker', created_at: 5 }] } }))
    click('d1')
    await flush()
    const html = shown()
    expect(html).not.toContain('approvals-email-body')
    expect(html).not.toContain('not a mail')
    expect(html).toContain('Token decision on a human-only request')
    expect(html).toContain('refused: a person must decide')
  })
})

describe('approvals.js: the journal request', () => {
  it.each([[403], [404]])('a %i answer reads as not available to this login', async (status) => {
    const { get, click, flush } = await mount([EMAIL_ROW], () => ({ status, body: { error: 'x' } }))
    click('m1')
    await flush()
    expect(get('approvalsEventsBody').innerHTML).toContain('not available to this login')
  })

  it('a server error and a network failure read as a load failure, and the rest of the detail stays', async () => {
    for (const answer of [{ status: 500 }, 'throw'] as EventsAnswer[]) {
      const { get, click, flush } = await mount([EMAIL_ROW], () => answer)
      click('m1')
      await flush()
      expect(get('approvalsEventsBody').innerHTML).toContain('Could not load the events.')
      expect(get('approvalsDetailBody').innerHTML).toContain('bob@example.test')
    }
  })

  it('shows the loading line until the journal arrives', async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {}
    const pending = new Promise<{ status: number; body: unknown }>((r) => { release = r })
    const { get, click, flush } = await mount([EMAIL_ROW], () => pending)
    click('m1')
    await flush()
    expect(get('approvalsDetailBody').innerHTML).toContain('Loading...')
    expect(get('approvalsEventsBody').innerHTML).toBe('')
    release({ status: 200, body: JOURNAL })
    await flush()
    expect(get('approvalsEventsBody').innerHTML).toContain('approvals-events')
  })

  it('a late answer for a request the modal has moved away from is dropped', async () => {
    let releaseFirst: (v: { status: number; body: unknown }) => void = () => {}
    const first = new Promise<{ status: number; body: unknown }>((r) => { releaseFirst = r })
    const { get, click, flush } = await mount([EMAIL_ROW, OTHER_ROW], (id) =>
      id === 'm1' ? first : { status: 200, body: { items: [{ id: 9, event: 'owner_unreached', actor: 'system', created_at: 1 }] } })
    click('m1')
    click('d1')
    await flush()
    expect(get('approvalsEventsBody').innerHTML).toContain('Owner notification not delivered')
    releaseFirst({ status: 200, body: JOURNAL })
    await flush()
    const html = get('approvalsEventsBody').innerHTML
    expect(html).toContain('Owner notification not delivered')
    expect(html).not.toContain('Identical request folded')
  })
})

// ---------------------------------------------------------------------------------------------------
// Wiring contracts.

describe('wiring', () => {
  const APPROVALS = read('modules/approvals.js')
  const VIEW = read('modules/approval-email-view.js')
  const CSS = readAllCss()
  const HTML = read('index.html')

  it('the detail reads the journal route and the list cuts through the view helper', () => {
    expect(APPROVALS).toContain('/events`')
    expect(APPROVALS).toContain('truncateDescription(a.action_description, 80)')
    expect(APPROVALS).toContain("from './approval-email-view.js'")
  })

  it('the CSS has the classes the detail uses', () => {
    for (const cls of ['.approvals-email-body', '.approvals-state-badge', '.approvals-state-consumed', '.approvals-state-expired', '.approvals-state-lapsed', '.approvals-events', '.approvals-event', '.approvals-detail-section', '.approvals-hash']) {
      expect(CSS, cls).toContain(cls)
    }
    expect(CSS).toMatch(/\.approvals-email-body\s*\{[^}]*overflow:\s*auto/)
  })

  it('the modal title is translated', () => {
    expect(HTML).toContain('data-i18n="approvals.detail.title"')
  })

  it('every approvals key the two modules use exists in both language files, with the same placeholders', async () => {
    const win: any = { _i18n: {} }
    vm.runInNewContext(read('lang/hu.js'), { window: win })
    vm.runInNewContext(read('lang/en.js'), { window: win })
    const used = new Set<string>()
    for (const src of [APPROVALS, VIEW]) for (const m of src.matchAll(/\bt\('(approvals\.[a-z_.]+[a-z_])'/g)) used.add(m[1])
    // dynamic keys: the event kinds and reasons, and the status words
    const v = await loadView()
    for (const k of v.EVENT_KINDS) used.add('approvals.event.' + k)
    for (const r of v.EVENT_REASONS) used.add('approvals.event.reason.' + r)
    expect(used.size).toBeGreaterThan(40)
    const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    for (const key of used) {
      expect(win._i18n.hu[key], `hu ${key}`).toBeTruthy()
      expect(win._i18n.en[key], `en ${key}`).toBeTruthy()
      expect(tokens(win._i18n.hu[key]), key).toBe(tokens(win._i18n.en[key]))
    }
  })
})
