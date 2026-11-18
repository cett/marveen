#!/usr/bin/env node
// CI gate for the root `npm audit`: high and critical advisories fail the build, except the ones that sit on a
// small allowlist with an expiry date and a reason (scripts/ci/npm-audit-allowlist.json). It replaces the plain
// `npm audit --audit-level=high`, which cannot say "this advisory has no fixed release, accept it until <date>".
//
// The rules (all fail closed):
//   - a high or critical advisory that is not on the list fails;
//   - an allowlist entry whose date has passed fails, whether or not the advisory is still reported (a stale
//     exception must be removed or renewed by a person, it does not silently keep protecting a build);
//   - a malformed allowlist, an unreadable or unexpected audit report (registry error, other report version,
//     empty output) fails;
//   - a package that npm marks high or critical but whose advisory this script cannot find in the report fails
//     (an unexplained severity is never waved through).
// An entry is valid through its expiry day (UTC) and fails from the next day on. Moderate and lower advisories
// are not this gate's business, as with `--audit-level=high`.
//
// No dependencies, so it runs before anything else is trusted. Usage:
//   node scripts/ci/npm-audit-gate.mjs                          (runs `npm audit --json`)
//   node scripts/ci/npm-audit-gate.mjs --audit-json <file>      (reads a saved report; for tests)
//   node scripts/ci/npm-audit-gate.mjs --allowlist <file>       (default: the file next to this script)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BLOCKING = new Set(['high', 'critical'])
const GHSA_RE = /^GHSA(-[a-z0-9]{4}){3}$/i
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** A warning is raised when an exception has this many days or fewer left. */
export const WARN_DAYS = 14

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
function isCalendarDate(s) {
  const m = DATE_RE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86_400_000)
}

/**
 * Validate the allowlist document: { "allow": [ { "id": "GHSA-...", "expires": "YYYY-MM-DD", "reason": "..." } ] }.
 * Returns { entries: Map<lowercased id, entry>, errors: string[] }; any error means the gate fails.
 */
export function parseAllowlist(doc) {
  const errors = []
  const entries = new Map()
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.allow)) {
    return { entries, errors: ['the allowlist must be an object with an "allow" array'] }
  }
  doc.allow.forEach((e, i) => {
    const at = `allow[${i}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${at} is not an object`); return }
    if (typeof e.id !== 'string' || !GHSA_RE.test(e.id)) { errors.push(`${at}.id is not a GHSA id`); return }
    if (typeof e.expires !== 'string' || !isCalendarDate(e.expires)) { errors.push(`${at} (${e.id}): "expires" is not a YYYY-MM-DD date`); return }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') { errors.push(`${at} (${e.id}): "reason" is empty`); return }
    const key = e.id.toLowerCase()
    if (entries.has(key)) { errors.push(`${at}: ${e.id} is listed twice`); return }
    entries.set(key, { id: e.id, expires: e.expires, reason: e.reason })
  })
  return { entries, errors }
}

/** The advisory id of a `via` object: the GHSA id from its url, else the numeric npm source id. */
function advisoryId(via) {
  const m = typeof via.url === 'string' ? /GHSA(-[a-z0-9]{4}){3}/i.exec(via.url) : null
  if (m) return 'GHSA' + m[0].slice(4).toLowerCase() // GitHub writes the prefix upper case and the rest lower case
  return via.source !== undefined ? `npm-advisory-${via.source}` : null
}

/**
 * Decide the gate. `audit` is the parsed `npm audit --json` report, `allowlist` the parsed allowlist file, `today`
 * a YYYY-MM-DD string (UTC). Returns { ok, failures, warnings, notes } with human-readable lines.
 */
export function evaluate({ audit, allowlist, today }) {
  const failures = []
  const warnings = []
  const notes = []

  const { entries, errors } = parseAllowlist(allowlist)
  for (const e of errors) failures.push(`allowlist: ${e}`)

  // The report must be one this script understands, otherwise "no findings" would mean "no idea".
  const vulns = audit && typeof audit === 'object' ? audit.vulnerabilities : undefined
  if (!audit || typeof audit !== 'object' || audit.error || audit.auditReportVersion !== 2 ||
      !vulns || typeof vulns !== 'object' || Array.isArray(vulns) || !audit.metadata || typeof audit.metadata !== 'object') {
    failures.push('audit: the report is not a usable npm audit v2 report (registry error, other format or empty output)')
    return { ok: false, failures, warnings, notes }
  }

  // Every blocking advisory object, once per id, with the packages it hits.
  const advisories = new Map()
  for (const [pkg, v] of Object.entries(vulns)) {
    for (const via of Array.isArray(v?.via) ? v.via : []) {
      if (!via || typeof via !== 'object') continue
      if (!BLOCKING.has(String(via.severity).toLowerCase())) continue
      const id = advisoryId(via)
      if (!id) { failures.push(`audit: a ${via.severity} advisory on ${pkg} has neither a GHSA url nor a source id`); continue }
      const cur = advisories.get(id) ?? { id, severity: String(via.severity).toLowerCase(), title: String(via.title ?? ''), packages: new Set() }
      cur.packages.add(String(via.name ?? pkg))
      advisories.set(id, cur)
    }
  }

  // A package that is high or critical must reach at least one blocking advisory through its via chain.
  const reaches = (name, seen = new Set()) => {
    if (seen.has(name)) return false
    seen.add(name)
    const v = vulns[name]
    if (!v) return false
    return (Array.isArray(v.via) ? v.via : []).some((x) =>
      typeof x === 'string' ? reaches(x, seen) : !!x && typeof x === 'object' && BLOCKING.has(String(x.severity).toLowerCase()))
  }
  for (const [pkg, v] of Object.entries(vulns)) {
    if (BLOCKING.has(String(v?.severity).toLowerCase()) && !reaches(pkg)) {
      failures.push(`audit: ${pkg} is marked ${v.severity} but no ${v.severity}/critical advisory explains it in the report`)
    }
  }

  const used = new Set()
  for (const adv of [...advisories.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const hit = entries.get(adv.id.toLowerCase())
    const what = `${adv.id} (${adv.severity}, ${[...adv.packages].sort().join(', ')}): ${adv.title}`
    if (!hit) { failures.push(`not allowlisted: ${what}`); continue }
    used.add(adv.id.toLowerCase())
    if (today > hit.expires) continue // reported once, as an expired entry, below
    const left = daysBetween(today, hit.expires)
    notes.push(`allowed until ${hit.expires} (${left} day${left === 1 ? '' : 's'} left): ${what}. Reason: ${hit.reason}`)
    if (left <= WARN_DAYS) warnings.push(`the exception for ${adv.id} ends on ${hit.expires} (${left} day${left === 1 ? '' : 's'} left): renew it with a reason or remove it`)
  }

  for (const hit of entries.values()) {
    if (today > hit.expires) failures.push(`expired exception: ${hit.id} ended on ${hit.expires}. Fix the dependency, or renew the entry with a new date and reason`)
    else if (!used.has(hit.id.toLowerCase())) warnings.push(`the exception for ${hit.id} matches no advisory in this report: remove it`)
  }

  return { ok: failures.length === 0, failures, warnings, notes }
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

function readJson(path, what) {
  try { return { value: JSON.parse(readFileSync(path, 'utf-8')) } } catch (err) {
    return { error: `${what} (${path}) cannot be read as JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  const allowPath = argValue(argv, '--allowlist') ?? join(here, 'npm-audit-allowlist.json')
  const reportPath = argValue(argv, '--audit-json')
  const today = new Date().toISOString().slice(0, 10)

  const allow = readJson(allowPath, 'the allowlist')
  let audit
  let auditError
  if (reportPath) {
    const r = readJson(reportPath, 'the audit report')
    audit = r.value
    auditError = r.error
  } else {
    // npm exits 1 whenever it finds anything, so the exit code says nothing here: the JSON on stdout does.
    const r = spawnSync('npm', ['audit', '--json'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 })
    if (r.error) auditError = `npm audit could not run: ${r.error.message}`
    else {
      try { audit = JSON.parse(r.stdout) } catch { auditError = 'npm audit printed no JSON (registry or network error?)' }
    }
  }

  const result = evaluate({ audit, allowlist: allow.value, today })
  const failures = [...(allow.error ? [`allowlist: ${allow.error}`] : []), ...(auditError ? [`audit: ${auditError}`] : []), ...result.failures]
  // Never report success when an input could not even be read.
  const ok = result.ok && !allow.error && !auditError

  for (const n of result.notes) console.log(`npm-audit-gate: ${n}`)
  for (const w of result.warnings) console.log(`::warning title=npm audit exception::${w}`)
  for (const f of failures) console.log(`::error title=npm audit gate::${f}`)
  console.log(ok ? 'npm-audit-gate: PASS' : `npm-audit-gate: FAIL (${failures.length} problem${failures.length === 1 ? '' : 's'})`)
  return ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
