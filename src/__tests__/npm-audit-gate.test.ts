// scripts/ci/npm-audit-gate.mjs replaces the plain `npm audit --audit-level=high` in CI. The decision must be:
// no high advisory passes unless it is on the allowlist for that package, inside the longest allowed window and
// before its date; a critical advisory never passes; everything the script cannot understand fails (a gate that
// goes quiet on garbage is worse than no gate). The cells pin each side of every edge, the date and window
// boundaries included, and the CLI exit codes through a fake `npm`. The clock is an argument of evaluate(), so
// the cells use a fake date. Fixtures are neutral (invented package names and advisory ids); the one real shape
// is the picomatch report this gate was written for.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
// @ts-expect-error -- plain .mjs CI script, no types
import { evaluate, parseAllowlist, MAX_HORIZON_DAYS, MAX_WINDOW_DAYS, WARN_DAYS } from '../../scripts/ci/npm-audit-gate.mjs'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'ci', 'npm-audit-gate.mjs')
const ALLOWLIST = join(ROOT, 'scripts', 'ci', 'npm-audit-allowlist.json')
const TODAY = '2026-11-18'
const ID_A = 'GHSA-aaaa-bbbb-cccc'
const ID_B = 'GHSA-dddd-eeee-ffff'

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

type Via = string | { source: number; name: string; title: string; url: string; severity: string }
function adv(id: string, name: string, severity = 'high', source = 1000): Via {
  return { source, name, title: `title of ${id}`, url: `https://github.com/advisories/${id}`, severity }
}
function pkg(name: string, severity: string, via: Via[]) {
  return { name, severity, isDirect: false, via, effects: [], range: '*', nodes: [`node_modules/${name}`] }
}
function report(vulnerabilities: Record<string, unknown>) {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } } }
}
interface Entry { id: string; package: string; added: string; expires: string; reason: string; addedBy: string }
/** A valid entry added 10 days before TODAY with 30 days of life (inside the window), overridable per cell. */
const entry = (over: Partial<Entry> = {}): Entry => ({
  id: ID_A, package: 'pkg-a', added: addDays(TODAY, -10), expires: addDays(TODAY, 20), reason: 'no fixed release, dev chain only', addedBy: 'owner-a', ...over,
})
const allow = (...entries: Entry[]) => ({ allow: entries })
const clean = report({})
const oneHigh = (id = ID_A, name = 'pkg-a') => report({ [name]: pkg(name, 'high', [adv(id, name)]) })
const run = (audit: unknown, list: unknown, today = TODAY) => evaluate({ audit, allowlist: list, today })

describe('evaluate: the decision', () => {
  it('passes a clean report with an empty allowlist', () => {
    const r = run(clean, allow())
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
  })

  it('fails a high advisory that is not on the list, naming it', () => {
    const r = run(oneHigh(), allow())
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain(`not allowlisted: ${ID_A} on pkg-a`)
  })

  it('passes a listed advisory, and the note says which exception saved it, who added it, why, and the days left', () => {
    const r = run(oneHigh(), allow(entry()))
    expect(r.ok).toBe(true)
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]).toContain('exception in use, 20 days left')
    expect(r.notes[0]).toContain(ID_A)
    expect(r.notes[0]).toContain('pkg-a')
    expect(r.notes[0]).toContain('by owner-a')
    expect(r.notes[0]).toContain('no fixed release, dev chain only')
    expect(r.warnings).toEqual([])
  })

  it('matches the id case-insensitively', () => {
    expect(run(oneHigh(), allow(entry({ id: ID_A.toUpperCase() }))).ok).toBe(true)
  })

  it('ignores moderate and lower advisories (the level of the old --audit-level=high)', () => {
    const audit = report({ 'pkg-a': pkg('pkg-a', 'moderate', [adv(ID_A, 'pkg-a', 'moderate')]) })
    expect(run(audit, allow()).ok).toBe(true)
  })

  describe('the package is part of the match', () => {
    it('the right id on another package does not save the advisory', () => {
      const r = run(oneHigh(ID_A, 'pkg-a'), allow(entry({ package: 'pkg-z' })))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain(`not allowlisted: ${ID_A} on pkg-a`)
    })

    it('one advisory on two packages needs an entry for each: one entry covers one package only', () => {
      const audit = report({ 'pkg-a': pkg('pkg-a', 'high', [adv(ID_A, 'pkg-a')]), 'pkg-b': pkg('pkg-b', 'high', [adv(ID_A, 'pkg-b')]) })
      const one = run(audit, allow(entry({ package: 'pkg-a' })))
      expect(one.ok).toBe(false)
      expect(one.failures.join('\n')).toContain(`not allowlisted: ${ID_A} on pkg-b`)
      expect(one.failures.join('\n')).not.toContain(`not allowlisted: ${ID_A} on pkg-a`)
      expect(run(audit, allow(entry({ package: 'pkg-a' }), entry({ package: 'pkg-b' }))).ok).toBe(true)
    })

    it('the same id may be listed for two packages, but not twice for one', () => {
      expect(parseAllowlist(allow(entry({ package: 'pkg-a' }), entry({ package: 'pkg-b' }))).errors).toEqual([])
      const dup = parseAllowlist(allow(entry(), entry({ id: ID_A.toUpperCase() })))
      expect(dup.errors.join('\n')).toMatch(/listed twice/)
    })

    it('a listed advisory does not cover a different one on the same package: the unlisted one still fails', () => {
      const audit = report({ 'pkg-a': pkg('pkg-a', 'high', [adv(ID_A, 'pkg-a'), adv(ID_B, 'pkg-a', 'high', 2000)]) })
      const r = run(audit, allow(entry()))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain(`not allowlisted: ${ID_B} on pkg-a`)
      expect(r.failures.join('\n')).not.toContain(`not allowlisted: ${ID_A}`)
    })
  })

  describe('transitive chains', () => {
    const chain = report({
      'pkg-a': pkg('pkg-a', 'high', [adv(ID_A, 'pkg-a')]),
      'pkg-mid': pkg('pkg-mid', 'high', ['pkg-a']),
      'pkg-top': pkg('pkg-top', 'high', ['pkg-mid', 'pkg-a']),
    })

    it('packages that only reach the advisory through string via links are covered by the entry for the advisory package', () => {
      const r = run(chain, allow(entry()))
      expect(r.ok).toBe(true)
      expect(r.notes).toHaveLength(1)
    })

    it('the same chain fails without the entry, on the advisory, not once per linked package', () => {
      const r = run(chain, allow())
      expect(r.ok).toBe(false)
      expect(r.failures).toHaveLength(1)
    })

    it('an unlisted advisory further up the chain still fails next to a listed one', () => {
      const audit = report({
        'pkg-a': pkg('pkg-a', 'high', [adv(ID_A, 'pkg-a')]),
        'pkg-top': pkg('pkg-top', 'high', ['pkg-a', adv(ID_B, 'pkg-top', 'high', 2000)]),
      })
      const r = run(audit, allow(entry()))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain(`${ID_B} on pkg-top`)
    })

    it('a package marked high that no advisory explains fails (a severity the script cannot account for)', () => {
      const r = run(report({ 'pkg-x': pkg('pkg-x', 'high', ['pkg-missing']) }), allow())
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain('pkg-x is marked high')
    })

    it('a package marked high whose only advisory is moderate fails (the severities disagree)', () => {
      const r = run(report({ 'pkg-x': pkg('pkg-x', 'high', [adv(ID_A, 'pkg-x', 'moderate')]) }), allow(entry({ package: 'pkg-x' })))
      expect(r.ok).toBe(false)
    })

    it('a cycle in the via chains terminates and still decides', () => {
      expect(run(report({ 'pkg-x': pkg('pkg-x', 'high', ['pkg-y']), 'pkg-y': pkg('pkg-y', 'high', ['pkg-x']) }), allow()).ok).toBe(false)
    })
  })

  describe('critical is never excepted', () => {
    const critical = report({ 'pkg-a': pkg('pkg-a', 'critical', [adv(ID_A, 'pkg-a', 'critical')]) })

    it('an unlisted critical advisory fails', () => {
      expect(run(critical, allow()).ok).toBe(false)
    })

    it('a listed critical advisory still fails, and the message says why', () => {
      const r = run(critical, allow(entry()))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain('a critical advisory cannot be excepted')
      expect(r.notes).toEqual([])
    })

    it('the same entry passes when the advisory is high: the ban is on the severity, not on the entry', () => {
      expect(run(oneHigh(), allow(entry())).ok).toBe(true)
    })
  })

  describe('expiry', () => {
    it('the exception is valid through its last day (today == expires) and fails the day after', () => {
      const list = allow(entry({ expires: TODAY }))
      const last = run(oneHigh(), list)
      expect(last.ok).toBe(true)
      expect(last.notes.join('\n')).toContain('0 days left')
      const next = run(oneHigh(), list, addDays(TODAY, 1))
      expect(next.ok).toBe(false)
      expect(next.failures.join('\n')).toContain(`expired exception: ${ID_A} on pkg-a ended on ${TODAY}`)
    })

    it('an expired exception fails once, not also as "not allowlisted"', () => {
      const r = run(oneHigh(), allow(entry({ added: addDays(TODAY, -40), expires: addDays(TODAY, -10) })))
      expect(r.failures).toHaveLength(1)
      expect(r.failures[0]).toContain('expired exception')
      expect(r.notes).toEqual([]) // an expired exception is not shown as "in use"
    })

    it('an expired exception fails even when the advisory is no longer reported (stale entries are removed by a person)', () => {
      const r = run(clean, allow(entry({ added: addDays(TODAY, -40), expires: addDays(TODAY, -10) })))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain('expired exception')
    })

    it('the fake clock decides: the same list passes 20 days before expiry and fails 21 days after', () => {
      const list = allow(entry())
      expect(run(oneHigh(), list, TODAY).ok).toBe(true)
      expect(run(oneHigh(), list, addDays(TODAY, 21)).ok).toBe(false)
    })

    it('warns, without failing, when 7 days or fewer are left, naming the days, and not at 8', () => {
      expect(WARN_DAYS).toBe(7)
      const near = run(oneHigh(), allow(entry({ expires: addDays(TODAY, 7) })))
      expect(near.ok).toBe(true)
      expect(near.warnings.join('\n')).toContain('(7 days left)')
      const far = run(oneHigh(), allow(entry({ expires: addDays(TODAY, 8) })))
      expect(far.warnings).toEqual([])
    })

    it('one day left is written in the singular', () => {
      expect(run(oneHigh(), allow(entry({ expires: addDays(TODAY, 1) }))).warnings.join('\n')).toContain('(1 day left)')
    })

    it('a listed entry that matches nothing in the report is a warning, not a failure', () => {
      const r = run(clean, allow(entry()))
      expect(r.ok).toBe(true)
      expect(r.warnings.join('\n')).toContain(`${ID_A} on pkg-a matches no advisory`)
    })
  })

  describe('the longest window', () => {
    it('is 30 days from the day it was added', () => {
      expect(MAX_WINDOW_DAYS).toBe(30)
    })

    it('30 days passes and 31 days fails, counted from "added", not from today', () => {
      const added = addDays(TODAY, -5)
      expect(run(oneHigh(), allow(entry({ added, expires: addDays(added, 30) }))).ok).toBe(true)
      const over = run(oneHigh(), allow(entry({ added, expires: addDays(added, 31) })))
      expect(over.ok).toBe(false)
      expect(over.failures.join('\n')).toContain('lasts 31 days')
      expect(over.failures.join('\n')).toContain('more than the 30 allowed')
    })

    it('a long window fails even when it is still far from over and the advisory is reported', () => {
      expect(run(oneHigh(), allow(entry({ added: TODAY, expires: '2999-01-01' }))).ok).toBe(false)
    })

    it('an entry that expires before it was added fails', () => {
      const r = run(oneHigh(), allow(entry({ added: TODAY, expires: addDays(TODAY, -1) })))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain('before it was added')
    })

    it('an "added" date in the future fails (it would stretch the window); today is fine', () => {
      expect(run(oneHigh(), allow(entry({ added: TODAY, expires: addDays(TODAY, 30) }))).ok).toBe(true)
      const r = run(oneHigh(), allow(entry({ added: addDays(TODAY, 1), expires: addDays(TODAY, 31) })))
      expect(r.ok).toBe(false)
      expect(r.failures.join('\n')).toContain('"added" date in the future')
    })

    it('a bad entry is reported once, not also as expired or unmatched', () => {
      const r = run(oneHigh(), allow(entry({ added: TODAY, expires: '2999-01-01' })))
      expect(r.failures).toHaveLength(1)
    })
  })

  describe('the ceiling counted from today', () => {
    const ceilingMessage = 'more than the 45 days ahead of today'

    it('is 45 days', () => {
      expect(MAX_HORIZON_DAYS).toBe(45)
    })

    it('an expiry 46 days ahead fails with the ceiling message; 45 days ahead does not trip the ceiling', () => {
      const over = run(oneHigh(), allow(entry({ added: TODAY, expires: addDays(TODAY, 46) })))
      expect(over.ok).toBe(false)
      expect(over.failures.join('\n')).toContain(ceilingMessage)
      expect(over.failures.join('\n')).toContain('expires in 46 days')
      // 45 days ahead is exactly on the ceiling: the 30-day window (a stricter rule) is what fails it, not the ceiling.
      const edge = run(oneHigh(), allow(entry({ added: TODAY, expires: addDays(TODAY, 45) })))
      expect(edge.failures.join('\n')).not.toContain(ceilingMessage)
      expect(edge.failures.join('\n')).toContain('more than the 30 allowed')
    })

    it('counts from today, not from the "added" date: a back-dated "added" does not move it', () => {
      // added far in the past makes the window huge as well, but the ceiling message is its own line of defence
      const r = run(oneHigh(), allow(entry({ added: addDays(TODAY, -200), expires: addDays(TODAY, 50) })))
      expect(r.failures.join('\n')).toContain(ceilingMessage)
    })

    it('moves with the clock: the same entry is inside the ceiling 2 days later', () => {
      const e = entry({ added: TODAY, expires: addDays(TODAY, 46) })
      expect(run(oneHigh(), allow(e), TODAY).failures.join('\n')).toContain(ceilingMessage)
      expect(run(oneHigh(), allow(e), addDays(TODAY, 2)).failures.join('\n')).not.toContain(ceilingMessage)
    })

    it('a valid entry (inside the 30-day window) never meets the ceiling, so the gate passes it', () => {
      const r = run(oneHigh(), allow(entry({ added: TODAY, expires: addDays(TODAY, 30) })))
      expect(r.ok).toBe(true)
    })

    it('an entry over the ceiling is reported once', () => {
      const r = run(oneHigh(), allow(entry({ added: TODAY, expires: addDays(TODAY, 100) })))
      expect(r.failures).toHaveLength(1)
    })
  })
})

describe('evaluate: input it cannot trust fails closed', () => {
  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['an empty object', {}],
    ['a registry error', { error: { code: 'ENOTFOUND', summary: 'request failed' } }],
    ['an error next to an otherwise valid-looking report', { ...clean, error: { code: 'E500' } }],
    ['another report version', { ...clean, auditReportVersion: 1 }],
    ['no vulnerabilities map', { auditReportVersion: 2, metadata: {} }],
    ['an array as the vulnerabilities map', { auditReportVersion: 2, vulnerabilities: [], metadata: {} }],
    ['no metadata', { auditReportVersion: 2, vulnerabilities: {} }],
    ['a string', 'no vulnerabilities found'],
  ]
  it.each(bad)('the audit report is %s', (_name, audit) => {
    const r = run(audit, allow(entry()))
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('not a usable npm audit v2 report')
  })

  it('a high advisory with neither a GHSA url nor a source id fails (it cannot be matched to any exception)', () => {
    const anonymous = { name: 'pkg-a', title: 't', severity: 'high' }
    const r = run(report({ 'pkg-a': pkg('pkg-a', 'high', [anonymous as unknown as Via]) }), allow(entry()))
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('neither a GHSA url nor a source id')
  })

  it('an advisory without a GHSA url is identified by its npm source id, and is not allowlisted by accident', () => {
    const noUrl = { source: 4242, name: 'pkg-a', title: 't', url: 'https://example.invalid/x', severity: 'high' }
    const r = run(report({ 'pkg-a': pkg('pkg-a', 'high', [noUrl]) }), allow(entry()))
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('npm-advisory-4242')
  })

  const badLists: Array<[string, unknown, RegExp]> = [
    ['missing', undefined, /"allow" array/],
    ['null', null, /"allow" array/],
    ['an array instead of an object', [], /"allow" array/],
    ['without the allow array', {}, /"allow" array/],
    ['an entry that is not an object', { allow: ['x'] }, /not an object/],
    ['an entry with a bad id', { allow: [{ ...entry(), id: 'CVE-2026-0001' }] }, /not a GHSA id/],
    ['an entry without a package', { allow: [{ ...entry(), package: undefined }] }, /"package" is not an npm package name/],
    ['an entry with a package that is not a name', { allow: [{ ...entry(), package: 'a b;c' }] }, /"package" is not an npm package name/],
    ['an entry without an added date', { allow: [{ ...entry(), added: undefined }] }, /"added" is not a YYYY-MM-DD date/],
    ['an entry without an expiry date', { allow: [{ ...entry(), expires: undefined }] }, /"expires" is not a YYYY-MM-DD date/],
    ['an entry with a date in another format', { allow: [{ ...entry(), expires: '18/12/2026' }] }, /"expires" is not a YYYY-MM-DD date/],
    ['an entry with a date that does not exist', { allow: [{ ...entry(), expires: '2026-02-30' }] }, /"expires" is not a YYYY-MM-DD date/],
    ['an entry with a blank reason', { allow: [{ ...entry(), reason: '   ' }] }, /"reason" is empty/],
    ['an entry without who added it', { allow: [{ ...entry(), addedBy: '' }] }, /"addedBy" is empty/],
  ]
  it.each(badLists)('the allowlist is %s', (_name, list, message) => {
    const r = run(clean, list)
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(message)
  })

  it('one bad entry fails the gate even when the advisory itself is covered by a good one', () => {
    const list = { allow: [entry(), { ...entry({ package: 'pkg-b' }), id: 'nope' }] }
    expect(run(oneHigh(), list).ok).toBe(false)
  })

  it('parseAllowlist keys the valid entries by lower-case id and package', () => {
    const { entries, errors } = parseAllowlist(allow(entry({ id: ID_A.toUpperCase() })))
    expect(errors).toEqual([])
    expect([...entries.keys()]).toEqual([`${ID_A.toLowerCase()}|pkg-a`])
  })
})

describe('the committed allowlist and the real report shape', () => {
  // The report npm printed for the case this gate exists for: one picomatch advisory, reached by five more packages.
  const picomatch = adv('GHSA-fc5q-39xc-vjpf', 'picomatch', 'high', 1247710)
  const real = report({
    '@vitest/coverage-v8': pkg('@vitest/coverage-v8', 'high', ['vitest']),
    fdir: pkg('fdir', 'high', ['picomatch']),
    picomatch: pkg('picomatch', 'high', [picomatch]),
    tinyglobby: pkg('tinyglobby', 'high', ['fdir', 'picomatch']),
    vite: pkg('vite', 'high', ['picomatch', 'tinyglobby']),
    vitest: pkg('vitest', 'high', ['@vitest/coverage-v8', 'picomatch', 'tinyglobby', 'vite']),
  })
  const committed = JSON.parse(readFileSync(ALLOWLIST, 'utf-8'))
  const only = committed.allow[0]

  it('the committed file is valid and holds exactly the picomatch advisory on the picomatch package', () => {
    const { entries, errors } = parseAllowlist(committed)
    expect(errors).toEqual([])
    expect([...entries.keys()]).toEqual(['ghsa-fc5q-39xc-vjpf|picomatch'])
    expect(only.reason.length).toBeGreaterThan(20)
    expect(only.addedBy.length).toBeGreaterThan(0)
  })

  it('its window is inside the maximum', () => {
    const days = (Date.parse(only.expires) - Date.parse(only.added)) / 86_400_000
    expect(days).toBeGreaterThanOrEqual(0)
    expect(days).toBeLessThanOrEqual(MAX_WINDOW_DAYS)
  })

  it('the six packages of the real report pass with the committed list on the day it was added', () => {
    const r = run(real, committed, only.added)
    expect(r.ok).toBe(true)
    expect(r.notes).toHaveLength(1)
  })

  it('the same report passes on the committed expiry date and fails the day after', () => {
    expect(run(real, committed, only.expires).ok).toBe(true)
    expect(run(real, committed, addDays(only.expires, 1)).ok).toBe(false)
  })

  it('a new high advisory next to the picomatch one fails the real report', () => {
    const withNew = report({ ...real.vulnerabilities, 'pkg-new': pkg('pkg-new', 'high', [adv(ID_B, 'pkg-new', 'high', 77)]) })
    const r = run(withNew, committed, only.added)
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain(ID_B)
  })
})

describe('the CLI', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-gate-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const realToday = () => new Date().toISOString().slice(0, 10)
  /** An entry the CLI (which reads the real clock) accepts: added today, 10 days of life. */
  const liveEntry = (over: Partial<Entry> = {}) => entry({ added: realToday(), expires: addDays(realToday(), 10), ...over })

  function runFile(auditDoc: unknown, listDoc: unknown, rawAudit?: string) {
    const auditPath = join(dir, 'audit.json')
    const listPath = join(dir, 'allow.json')
    writeFileSync(auditPath, rawAudit ?? JSON.stringify(auditDoc))
    if (listDoc !== undefined) writeFileSync(listPath, JSON.stringify(listDoc))
    return spawnSync(process.execPath, [GATE, '--audit-json', auditPath, '--allowlist', listPath], { encoding: 'utf-8', timeout: 30_000 })
  }

  it('exits 0 and prints PASS for a listed advisory', () => {
    const r = runFile(oneHigh(), allow(liveEntry()))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('npm-audit-gate: PASS')
    expect(r.stdout).toContain('exception in use, 10 days left')
  })

  it('exits 1 and annotates the failure as an error for an unlisted advisory', () => {
    const r = runFile(oneHigh(), allow())
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error title=npm audit gate::not allowlisted')
    expect(r.stdout).toContain('npm-audit-gate: FAIL (1 problem)')
  })

  it('exits 1 for an exception whose date is long past', () => {
    const r = runFile(oneHigh(), allow(entry({ added: '1999-12-15', expires: '2000-01-01' })))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('expired exception')
  })

  it('exits 1 for an entry whose window is too long', () => {
    const r = runFile(oneHigh(), allow(liveEntry({ expires: addDays(realToday(), 40) })))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('more than the 30 allowed')
  })

  it('exits 1 for an entry that expires far ahead, with the ceiling message', () => {
    const r = runFile(oneHigh(), allow(liveEntry({ expires: '2999-01-01' })))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('days ahead of today that are allowed')
  })

  it('exits 1 when the audit report is not JSON', () => {
    const r = runFile(undefined, allow(), 'npm ERR! network request failed')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('cannot be read as JSON')
  })

  it('exits 1 when the allowlist file is missing, even with a clean report', () => {
    const r = runFile(clean, undefined)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('the allowlist')
  })

  it('exits 1 for a registry-error report even with an allowlist that would cover everything', () => {
    expect(runFile({ error: { code: 'ENOTFOUND' } }, allow(liveEntry())).status).toBe(1)
  })

  // The real path: the script runs `npm audit --json`. A fake npm first on PATH prints what the cell says and exits
  // with the code it says, so the cells pin what npm's exit code and output mean to the gate.
  describe('through a fake npm (npm exits 1 whenever it finds anything, so the exit code alone says nothing)', () => {
    function viaFakeNpm(stdout: string, exitCode: number, list: unknown = allow()) {
      const bin = join(dir, 'bin')
      const out = join(dir, 'fake-out.txt')
      const listPath = join(dir, 'allow.json')
      writeFileSync(out, stdout)
      writeFileSync(listPath, JSON.stringify(list))
      mkdirSync(bin, { recursive: true })
      const fake = join(bin, 'npm')
      writeFileSync(fake, `#!/bin/sh\ncat "$FAKE_NPM_OUT"\nexit ${exitCode}\n`)
      chmodSync(fake, 0o755)
      return spawnSync(process.execPath, [GATE, '--allowlist', listPath], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, FAKE_NPM_OUT: out },
      })
    }

    it('exit 1 with a valid report whose advisory is listed passes (the normal "found something" exit)', () => {
      const r = viaFakeNpm(JSON.stringify(oneHigh()), 1, allow(liveEntry()))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('npm-audit-gate: PASS')
    })

    it('exit 0 with a clean report passes', () => {
      expect(viaFakeNpm(JSON.stringify(clean), 0).status).toBe(0)
    })

    it('exit 1 with an unlisted advisory fails', () => {
      expect(viaFakeNpm(JSON.stringify(oneHigh()), 1).status).toBe(1)
    })

    it('a non-zero exit with empty output fails', () => {
      const r = viaFakeNpm('', 1)
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('printed no JSON')
    })

    it('a non-zero exit with output that is not JSON fails', () => {
      expect(viaFakeNpm('<html>502 Bad Gateway</html>', 1).status).toBe(1)
    })

    it('a zero exit with empty output fails (silence is not a clean report)', () => {
      expect(viaFakeNpm('', 0).status).toBe(1)
    })

    it('a zero exit with JSON of an unknown format fails', () => {
      expect(viaFakeNpm('{"hello":"world"}', 0).status).toBe(1)
    })

    it('a registry error in JSON (npm exits 1 with {"error": ...}) fails, even when everything would be listed', () => {
      expect(viaFakeNpm(JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'request failed' } }), 1, allow(liveEntry())).status).toBe(1)
    })

    it('an npm that is not found fails', () => {
      const listPath = join(dir, 'allow.json')
      writeFileSync(listPath, JSON.stringify(allow()))
      const r = spawnSync(process.execPath, [GATE, '--allowlist', listPath], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, PATH: dir } })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('npm audit could not run')
    })

    it('an npm killed by a signal fails and says so', () => {
      const bin = join(dir, 'bin')
      mkdirSync(bin, { recursive: true })
      const listPath = join(dir, 'allow.json')
      writeFileSync(listPath, JSON.stringify(allow()))
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\nkill -KILL $$\n')
      chmodSync(join(bin, 'npm'), 0o755)
      const r = spawnSync(process.execPath, [GATE, '--allowlist', listPath], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('killed by SIGKILL')
    })
  })
})

describe('the workflow wiring', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')
  const runLines = ci.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('run:'))

  it('the root Security audit step runs the gate', () => {
    expect(runLines).toContain('run: node scripts/ci/npm-audit-gate.mjs')
  })

  it('no step runs the plain root audit any more (it would ignore the allowlist and fail, or be copied back as a bypass)', () => {
    // A run line that starts the audit command (a message later in the line does not count) without --prefix.
    expect(runLines.filter((l) => /^run:\s*(npx\s+)?npm audit\b/.test(l) && !l.includes('--prefix'))).toEqual([])
  })

  it('the lint toolchain audit stays advisory and untouched', () => {
    expect(ci).toContain('npm audit --prefix tools/eslint --audit-level=high || echo "::warning')
  })
})
