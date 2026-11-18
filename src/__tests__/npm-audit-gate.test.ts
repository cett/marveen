// scripts/ci/npm-audit-gate.mjs replaces the plain `npm audit --audit-level=high` in CI. The decision must be:
// no high or critical advisory passes unless it is on the allowlist AND its date has not passed; everything the
// script cannot understand fails (a gate that goes quiet on garbage is worse than no gate). The cells below pin
// each side of every edge, the date boundary included, and the CLI exit codes. Fixtures are neutral (invented
// package names and advisory ids); the one real shape is the picomatch report this gate was written for.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs CI script, no types
import { evaluate, parseAllowlist, WARN_DAYS } from '../../scripts/ci/npm-audit-gate.mjs'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'ci', 'npm-audit-gate.mjs')
const ALLOWLIST = join(ROOT, 'scripts', 'ci', 'npm-audit-allowlist.json')
const TODAY = '2026-11-18'
const ID_A = 'GHSA-aaaa-bbbb-cccc'
const ID_B = 'GHSA-dddd-eeee-ffff'

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
const allow = (...entries: Array<{ id: string; expires: string; reason?: string }>) => ({
  allow: entries.map((e) => ({ reason: 'no fixed release, dev chain only', ...e })),
})
const clean = report({})
const oneHigh = (id = ID_A) => report({ 'pkg-a': pkg('pkg-a', 'high', [adv(id, 'pkg-a')]) })

describe('evaluate: the decision', () => {
  it('passes a clean report with an empty allowlist', () => {
    const r = evaluate({ audit: clean, allowlist: allow(), today: TODAY })
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
  })

  it('fails a high advisory that is not on the list, naming it', () => {
    const r = evaluate({ audit: oneHigh(), allowlist: allow(), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain(`not allowlisted: ${ID_A}`)
  })

  it('fails a critical advisory that is not on the list', () => {
    const audit = report({ 'pkg-a': pkg('pkg-a', 'critical', [adv(ID_A, 'pkg-a', 'critical')]) })
    expect(evaluate({ audit, allowlist: allow(), today: TODAY }).ok).toBe(false)
  })

  it('passes a listed advisory before its date, with a note holding the reason', () => {
    const r = evaluate({ audit: oneHigh(), allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY })
    expect(r.ok).toBe(true)
    expect(r.notes.join('\n')).toContain('allowed until 2026-12-18 (30 days left)')
    expect(r.notes.join('\n')).toContain('no fixed release, dev chain only')
    expect(r.warnings).toEqual([])
  })

  it('the exception is valid through its last day (today == expires) and fails the day after', () => {
    const list = allow({ id: ID_A, expires: TODAY })
    const last = evaluate({ audit: oneHigh(), allowlist: list, today: TODAY })
    expect(last.ok).toBe(true)
    expect(last.notes.join('\n')).toContain('(0 days left)')
    expect(last.warnings.join('\n')).toContain('(0 days left)')
    const next = evaluate({ audit: oneHigh(), allowlist: list, today: '2026-11-19' })
    expect(next.ok).toBe(false)
    expect(next.failures.join('\n')).toContain(`expired exception: ${ID_A} ended on ${TODAY}`)
  })

  it('an expired exception fails once, not also as "not allowlisted"', () => {
    const r = evaluate({ audit: oneHigh(), allowlist: allow({ id: ID_A, expires: '2026-01-01' }), today: TODAY })
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('expired exception')
  })

  it('an expired exception fails even when the advisory is no longer reported (stale entries are removed by a person)', () => {
    const r = evaluate({ audit: clean, allowlist: allow({ id: ID_A, expires: '2026-01-01' }), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('expired exception')
  })

  it('warns, without failing, when the exception ends within the warning window, and not one day before it', () => {
    const near = evaluate({ audit: oneHigh(), allowlist: allow({ id: ID_A, expires: '2026-12-02' }), today: TODAY })
    expect(WARN_DAYS).toBe(14)
    expect(near.ok).toBe(true)
    expect(near.warnings.join('\n')).toContain('(14 days left)')
    const far = evaluate({ audit: oneHigh(), allowlist: allow({ id: ID_A, expires: '2026-12-03' }), today: TODAY })
    expect(far.warnings).toEqual([])
  })

  it('a listed advisory does not cover a different one: the unlisted one still fails', () => {
    const audit = report({
      'pkg-a': pkg('pkg-a', 'high', [adv(ID_A, 'pkg-a')]),
      'pkg-b': pkg('pkg-b', 'high', [adv(ID_B, 'pkg-b', 'high', 2000)]),
    })
    const r = evaluate({ audit, allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain(ID_B)
    expect(r.failures.join('\n')).not.toContain(`not allowlisted: ${ID_A}`)
  })

  it('matches the id case-insensitively', () => {
    const r = evaluate({ audit: oneHigh(), allowlist: allow({ id: ID_A.toUpperCase(), expires: '2026-12-18' }), today: TODAY })
    expect(r.ok).toBe(true)
  })

  it('ignores moderate and lower advisories (the level of the old --audit-level=high)', () => {
    const audit = report({ 'pkg-a': pkg('pkg-a', 'moderate', [adv(ID_A, 'pkg-a', 'moderate')]) })
    expect(evaluate({ audit, allowlist: allow(), today: TODAY }).ok).toBe(true)
  })

  it('a listed entry that matches nothing in the report is a warning, not a failure', () => {
    const r = evaluate({ audit: clean, allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY })
    expect(r.ok).toBe(true)
    expect(r.warnings.join('\n')).toContain(`${ID_A} matches no advisory`)
  })

  it('a package that only reaches the advisory through other packages is covered by the same entry', () => {
    const audit = report({
      'pkg-a': pkg('pkg-a', 'high', [adv(ID_A, 'pkg-a')]),
      'pkg-mid': pkg('pkg-mid', 'high', ['pkg-a']),
      'pkg-top': pkg('pkg-top', 'high', ['pkg-mid', 'pkg-a']),
    })
    expect(evaluate({ audit, allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY }).ok).toBe(true)
    expect(evaluate({ audit, allowlist: allow(), today: TODAY }).ok).toBe(false)
  })

  it('fails a package marked high that no advisory explains (a severity the script cannot account for)', () => {
    const audit = report({ 'pkg-x': pkg('pkg-x', 'high', ['pkg-missing']) })
    const r = evaluate({ audit, allowlist: allow(), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('pkg-x is marked high')
  })

  it('fails a package marked high whose only advisory is moderate (the severities disagree)', () => {
    const audit = report({ 'pkg-x': pkg('pkg-x', 'high', [adv(ID_A, 'pkg-x', 'moderate')]) })
    expect(evaluate({ audit, allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY }).ok).toBe(false)
  })

  it('a dependency cycle in the via chains terminates and still decides', () => {
    const audit = report({ 'pkg-x': pkg('pkg-x', 'high', ['pkg-y']), 'pkg-y': pkg('pkg-y', 'high', ['pkg-x']) })
    const r = evaluate({ audit, allowlist: allow(), today: TODAY })
    expect(r.ok).toBe(false)
  })

  it('a high advisory with neither a GHSA url nor a source id fails (it cannot be matched to any exception)', () => {
    const anonymous = { name: 'pkg-a', title: 't', severity: 'high' }
    const audit = report({ 'pkg-a': pkg('pkg-a', 'high', [anonymous as unknown as Via]) })
    const r = evaluate({ audit, allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('neither a GHSA url nor a source id')
  })

  it('an advisory without a GHSA url is identified by its npm source id, and is not allowlisted by accident', () => {
    const noUrl = { source: 4242, name: 'pkg-a', title: 't', url: 'https://example.invalid/x', severity: 'high' }
    const audit = report({ 'pkg-a': pkg('pkg-a', 'high', [noUrl]) })
    const r = evaluate({ audit, allowlist: allow({ id: ID_A, expires: '2026-12-18' }), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('npm-advisory-4242')
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
    const r = evaluate({ audit, allowlist: allow(), today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain('not a usable npm audit v2 report')
  })

  const badLists: Array<[string, unknown, RegExp]> = [
    ['missing', undefined, /"allow" array/],
    ['null', null, /"allow" array/],
    ['an array instead of an object', [], /"allow" array/],
    ['without the allow array', {}, /"allow" array/],
    ['an entry that is not an object', { allow: ['x'] }, /not an object/],
    ['an entry with a bad id', { allow: [{ id: 'CVE-2026-0001', expires: '2026-12-18', reason: 'r' }] }, /not a GHSA id/],
    ['an entry without an expiry date', { allow: [{ id: ID_A, reason: 'r' }] }, /not a YYYY-MM-DD date/],
    ['an entry with a date in another format', { allow: [{ id: ID_A, expires: '18/12/2026', reason: 'r' }] }, /not a YYYY-MM-DD date/],
    ['an entry with a date that does not exist', { allow: [{ id: ID_A, expires: '2026-02-30', reason: 'r' }] }, /not a YYYY-MM-DD date/],
    ['an entry with a blank reason', { allow: [{ id: ID_A, expires: '2026-12-18', reason: '   ' }] }, /"reason" is empty/],
    ['the same id twice', { allow: [{ id: ID_A, expires: '2026-12-18', reason: 'r' }, { id: ID_A.toUpperCase(), expires: '2026-12-19', reason: 'r' }] }, /listed twice/],
  ]
  it.each(badLists)('the allowlist is %s', (_name, list, message) => {
    const r = evaluate({ audit: clean, allowlist: list, today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(message)
  })

  it('one bad entry fails the gate even when the advisory itself would be covered by a good one', () => {
    const list = { allow: [{ id: ID_A, expires: '2026-12-18', reason: 'r' }, { id: 'nope', expires: '2026-12-18', reason: 'r' }] }
    expect(evaluate({ audit: oneHigh(), allowlist: list, today: TODAY }).ok).toBe(false)
  })

  it('parseAllowlist returns the valid entries keyed by lower-case id', () => {
    const { entries, errors } = parseAllowlist(allow({ id: ID_A.toUpperCase(), expires: '2026-12-18' }))
    expect(errors).toEqual([])
    expect([...entries.keys()]).toEqual([ID_A.toLowerCase()])
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

  it('the committed file is valid and holds exactly the picomatch advisory', () => {
    const { entries, errors } = parseAllowlist(committed)
    expect(errors).toEqual([])
    expect([...entries.keys()]).toEqual(['ghsa-fc5q-39xc-vjpf'])
    expect(entries.get('ghsa-fc5q-39xc-vjpf')?.reason.length).toBeGreaterThan(20)
  })

  it('the six packages of the real report pass with the committed list before its date', () => {
    const r = evaluate({ audit: real, allowlist: committed, today: TODAY })
    expect(r.ok).toBe(true)
    expect(r.notes).toHaveLength(1)
  })

  it('the same report fails on the committed expiry date plus one day', () => {
    const expires = committed.allow[0].expires as string
    const nextDay = new Date(Date.parse(expires + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)
    expect(evaluate({ audit: real, allowlist: committed, today: expires }).ok).toBe(true)
    expect(evaluate({ audit: real, allowlist: committed, today: nextDay }).ok).toBe(false)
  })

  it('a new high advisory next to the picomatch one fails the real report', () => {
    const withNew = report({
      ...real.vulnerabilities,
      'pkg-new': pkg('pkg-new', 'high', [adv(ID_B, 'pkg-new', 'high', 77)]),
    })
    const r = evaluate({ audit: withNew, allowlist: committed, today: TODAY })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toContain(ID_B)
  })
})

describe('the CLI', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-gate-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function run(auditDoc: unknown, listDoc: unknown, rawAudit?: string) {
    const auditPath = join(dir, 'audit.json')
    const listPath = join(dir, 'allow.json')
    writeFileSync(auditPath, rawAudit ?? JSON.stringify(auditDoc))
    if (listDoc !== undefined) writeFileSync(listPath, JSON.stringify(listDoc))
    return spawnSync(process.execPath, [GATE, '--audit-json', auditPath, '--allowlist', listPath], { encoding: 'utf-8', timeout: 30_000 })
  }

  it('exits 0 and prints PASS for a listed advisory with a far-off date', () => {
    const r = run(oneHigh(), allow({ id: ID_A, expires: '2999-01-01' }))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('npm-audit-gate: PASS')
  })

  it('exits 1 and annotates the failure as an error for an unlisted advisory', () => {
    const r = run(oneHigh(), allow())
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error title=npm audit gate::not allowlisted')
    expect(r.stdout).toContain('npm-audit-gate: FAIL (1 problem)')
  })

  it('exits 1 for an exception whose date is long past', () => {
    const r = run(oneHigh(), allow({ id: ID_A, expires: '2000-01-01' }))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('expired exception')
  })

  it('exits 1 when the audit report is not JSON', () => {
    const r = run(undefined, allow(), 'npm ERR! network request failed')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('cannot be read as JSON')
  })

  it('exits 1 when the allowlist file is missing, even with a clean report', () => {
    const r = run(clean, undefined)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('the allowlist')
  })

  it('exits 1 for a registry-error report even with an allowlist that would cover everything', () => {
    const r = run({ error: { code: 'ENOTFOUND' } }, allow({ id: ID_A, expires: '2999-01-01' }))
    expect(r.status).toBe(1)
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
