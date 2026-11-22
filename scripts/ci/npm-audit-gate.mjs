#!/usr/bin/env node
// CI gate for the root `npm audit`: high advisories fail the build, except the ones that sit on a small allowlist
// with a package, an adding date, an expiry date no more than MAX_WINDOW_DAYS later, a reason and the person who
// added it (scripts/ci/npm-audit-allowlist.json). It replaces the plain `npm audit --audit-level=high`, which cannot
// say "this advisory has no fixed release, accept it until <date>".
//
// The allowlist is gate configuration: adding an entry is a human decision made in a reviewed change. Nothing in
// this script, and no agent automation, writes it.
//
// The rules (all fail closed):
//   - a high advisory that is not on the list fails; the match is on the GHSA id AND the package it hits, so one
//     advisory reported on several packages needs one entry per package, and an unlisted advisory next to a listed
//     one still fails;
//   - a critical advisory can never be excepted: it fails even when it is listed, and the entry is reported;
//   - an entry whose date has passed fails, whether or not the advisory is still reported (a stale exception must
//     be removed or renewed by a person, it does not silently keep protecting a build). An entry is valid through
//     its expiry day (UTC) and fails from the next day on;
//   - an entry whose window (expires minus added) is longer than MAX_WINDOW_DAYS, whose expiry is before its adding
//     date, or whose adding date lies in the future fails (a future "added" would stretch the window);
//   - a malformed list, an unreadable or unexpected audit report (registry error, other report version, empty or
//     non-JSON output, npm killed by a signal) fails;
//   - a package that npm marks high or critical but whose advisory this script cannot find in the report fails
//     (an unexplained severity is never waved through).
// An exception with WARN_DAYS or fewer days left is printed as a warning. Moderate and lower advisories are not this
// gate's business, as with `--audit-level=high`.
//
// The clock is an argument of evaluate() (tests pass a fake date); the CLI reads the real UTC date and has no flag
// to change it, so a workflow cannot move the clock.
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
const PKG_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** The longest an exception may last, counted from the day it was added. */
export const MAX_WINDOW_DAYS = 30
/** How long `npm audit --json` may run before the gate gives up and fails (a timeout is an error, never a pass). */
export const AUDIT_TIMEOUT_MS = 180_000
/** The most `npm audit --json` may print; more fails the run (spawnSync reports ENOBUFS as an error). */
export const AUDIT_MAX_BUFFER = 64 * 1024 * 1024
/** An exception with this many days or fewer left is printed as a warning. */
export const WARN_DAYS = 7

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

const plural = (n) => `${n} day${n === 1 ? '' : 's'}`
const keyOf = (id, pkg) => `${id.toLowerCase()}|${pkg}`

/**
 * Validate the allowlist document:
 *   { "allow": [ { "id": "GHSA-...", "package": "name", "added": "YYYY-MM-DD", "expires": "YYYY-MM-DD",
 *                  "reason": "...", "addedBy": "..." } ] }
 * Returns { entries: Map<"lower-case id|package", entry>, errors: string[] }; any error means the gate fails.
 * The window and the future-date checks need the clock, so evaluate() does those.
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
    const who = `${at} (${e.id})`
    if (typeof e.package !== 'string' || !PKG_RE.test(e.package)) { errors.push(`${who}: "package" is not an npm package name`); return }
    if (typeof e.added !== 'string' || !isCalendarDate(e.added)) { errors.push(`${who}: "added" is not a YYYY-MM-DD date`); return }
    if (typeof e.expires !== 'string' || !isCalendarDate(e.expires)) { errors.push(`${who}: "expires" is not a YYYY-MM-DD date`); return }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') { errors.push(`${who}: "reason" is empty`); return }
    if (typeof e.addedBy !== 'string' || e.addedBy.trim() === '') { errors.push(`${who}: "addedBy" is empty`); return }
    const key = keyOf(e.id, e.package)
    if (entries.has(key)) { errors.push(`${who}: ${e.id} on ${e.package} is listed twice`); return }
    entries.set(key, { id: e.id, package: e.package, added: e.added, expires: e.expires, reason: e.reason, addedBy: e.addedBy })
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

  // Window checks per entry (these need the clock). A bad entry stays in the map so the rest is still reported,
  // but the failure below fails the gate whatever else happens.
  const badEntry = new Set()
  for (const [key, e] of entries) {
    const window = daysBetween(e.added, e.expires)
    if (e.added > today) { failures.push(`allowlist: ${e.id} on ${e.package} has an "added" date in the future (${e.added})`); badEntry.add(key) }
    else if (window < 0) { failures.push(`allowlist: ${e.id} on ${e.package} expires (${e.expires}) before it was added (${e.added})`); badEntry.add(key) }
    else if (window > MAX_WINDOW_DAYS) { failures.push(`allowlist: ${e.id} on ${e.package} lasts ${plural(window)} (${e.added} to ${e.expires}), more than the ${MAX_WINDOW_DAYS} allowed`); badEntry.add(key) }
  }

  // The report must be one this script understands, otherwise "no findings" would mean "no idea".
  const vulns = audit && typeof audit === 'object' ? audit.vulnerabilities : undefined
  if (!audit || typeof audit !== 'object' || audit.error || audit.auditReportVersion !== 2 ||
      !vulns || typeof vulns !== 'object' || Array.isArray(vulns) || !audit.metadata || typeof audit.metadata !== 'object') {
    failures.push('audit: the report is not a usable npm audit v2 report (registry error, other format or empty output)')
    return { ok: false, failures, warnings, notes }
  }

  // Every blocking advisory object, once per (id, package), with its severity.
  const advisories = new Map()
  for (const [pkg, v] of Object.entries(vulns)) {
    for (const via of Array.isArray(v?.via) ? v.via : []) {
      if (!via || typeof via !== 'object') continue // a string is only a link of the chain
      if (!BLOCKING.has(String(via.severity).toLowerCase())) continue
      const id = advisoryId(via)
      if (!id) { failures.push(`audit: a ${via.severity} advisory on ${pkg} has neither a GHSA url nor a source id`); continue }
      const name = String(via.name ?? pkg)
      advisories.set(keyOf(id, name), { id, name, severity: String(via.severity).toLowerCase(), title: String(via.title ?? '') })
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
      failures.push(`audit: ${pkg} is marked ${v.severity} but no high or critical advisory explains it in the report`)
    }
  }

  const used = new Set()
  for (const [key, adv] of [...advisories.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const what = `${adv.id} on ${adv.name} (${adv.severity}): ${adv.title}`
    const hit = entries.get(key)
    if (!hit) { failures.push(`not allowlisted: ${what}`); continue }
    used.add(key)
    if (adv.severity === 'critical') { failures.push(`a critical advisory cannot be excepted, remove the entry and fix the dependency: ${what}`); continue }
    if (badEntry.has(key)) continue // reported above
    if (today > hit.expires) continue // reported once, as an expired entry, below
    const left = daysBetween(today, hit.expires)
    notes.push(`exception in use, ${plural(left)} left (until ${hit.expires}, added ${hit.added} by ${hit.addedBy}): ${what}. Reason: ${hit.reason}`)
    if (left <= WARN_DAYS) warnings.push(`the exception for ${adv.id} on ${adv.name} ends on ${hit.expires} (${plural(left)} left): fix the dependency or renew the entry in a reviewed change`)
  }

  for (const [key, hit] of entries) {
    if (badEntry.has(key)) continue
    if (today > hit.expires) failures.push(`expired exception: ${hit.id} on ${hit.package} ended on ${hit.expires}. Fix the dependency, or renew the entry with a new date and reason`)
    else if (!used.has(key)) warnings.push(`the exception for ${hit.id} on ${hit.package} matches no advisory in this report: remove it`)
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
    // npm exits 1 whenever it finds anything, so a non-zero exit alone says nothing: the JSON on stdout does. But
    // a run that was killed, timed out or printed nothing usable is not a report.
    const r = spawnSync('npm', ['audit', '--json'], { encoding: 'utf-8', maxBuffer: AUDIT_MAX_BUFFER, timeout: AUDIT_TIMEOUT_MS })
    if (r.error) auditError = `npm audit could not run: ${r.error.message}`
    else if (r.signal) auditError = `npm audit was killed by ${r.signal}`
    else {
      try { audit = JSON.parse(r.stdout) } catch { auditError = `npm audit printed no JSON (exit ${r.status}; registry or network error?)` }
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
