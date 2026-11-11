// Does a proposed change to a skill touch what the skill may DO? (quarantine, step 3)
//
// A change that does is not written to the live skill: it is recorded as a pending revision and waits for a person
// (see db/skill-revisions.ts submitPendingRevision). The rule is deliberately narrow and mechanical, so a reviewer can
// predict it:
//
//   1. a runnable companion file (under scripts/, or with an execute bit) is new or different from every runnable file
//      the skill had (a path/mode/hash triple that was not there before). Removing a runnable file never counts: it
//      narrows what the skill can run.
//   2. a frontmatter block that decides what the skill may do or when a model picks it differs from before:
//      `allowed-tools` (also written `allowed_tools`), `tools`, `hooks`, `description`. The whole block counts, so a
//      continuation line (a YAML list, a folded description) is part of it. `description` only counts as a CHANGE
//      from an already-approved value, so a brand-new skill (no "before" at all) has nothing for it to diverge from:
//      a create gates only on an actual capability grant (`allowed-tools`/`tools`/`hooks`, or a new runnable file),
//      never on `description` alone.
//
// Everything else in SKILL.md (the body text, other frontmatter keys) is a plain edit. The comparison is on the text as
// stored (header stripped), line endings normalized, surrounding blanks trimmed per line.
//
// The frontmatter is read TWO ways, and a privilege key seen by either way counts. The skill loader is Claude Code itself
// (closed: it cannot be imported, and its closing rule cannot be proved), and a line scanner and a YAML loader disagree on
// real input: a block scalar with an indented `---` line closes the scanner's head early and hides what follows; a quoted
// key (`"allowed-tools": Bash`) or a flow mapping (`{allowed-tools: Bash}`) is not a bare token to the scanner but is a
// key to a YAML loader. So the gate has to be at least as suspicious as any reasonable reader: the scanner view and the
// js-yaml view are both compared, and where the two disagree about where the head ends, or the head cannot be parsed
// safely, ANY edit of the head counts (see the synthetic `!region` and `!unparsable` entries).
import { load as yamlLoad } from 'js-yaml'
import { sha256Hex } from './db/skill-revisions.js'

export interface SkillFileFacts {
  rel_path: string
  mode: number
  content: Buffer
}

/** The frontmatter keys whose block counts as a privilege. Lower case; compared exactly. */
const PRIVILEGE_KEYS: ReadonlySet<string> = new Set(['allowed-tools', 'allowed_tools', 'tools', 'hooks', 'description'])

/** A capability key name anywhere in a head text: `allowed-tools`, `allowed_tools`, `tools`, `hooks` (not `description`). */
const CAPABILITY_NAME = /allowed[-_]tools|tools|hooks/i

/** A frontmatter head larger than this is not parsed at all (the request body cap is 20 MB): it is gated as unparsable. */
const MAX_HEAD_BYTES = 64 * 1024
/** The canonicalizer visits at most this many YAML nodes (an alias chain is cheap to load and exponential to walk). */
const MAX_NODES = 10_000
const MAX_DEPTH = 200

class HeadTooComplex extends Error {}

/** One leading U+FEFF is dropped for both views: how the closed loader reads a BOM-prefixed file is unknown, and reading it as frontmatter is the cautious side. */
const withoutBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/** The normalized lines of a SKILL.md and where its head could end: null when there is no frontmatter at all. */
function headOf(content: string): { lines: string[]; scanEnd: number; yamlEnd: number } | null {
  const lines = withoutBom(content).replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  let scanEnd = -1
  let yamlEnd = -1
  for (let i = 1; i < lines.length; i++) {
    if (scanEnd === -1 && lines[i].trim() === '---') scanEnd = i
    if (yamlEnd === -1 && /^---[ \t]*$/.test(lines[i])) yamlEnd = i
    if (scanEnd !== -1 && yamlEnd !== -1) break
  }
  if (scanEnd === -1 && yamlEnd === -1) return null // never closed: not a frontmatter, so nothing in it is read as a privilege key
  return { lines, scanEnd, yamlEnd }
}

/** The scanner view: key -> the key's own line value plus its indented continuation lines, joined (the original reader). */
function scanBlocks(head: string[]): Map<string, string> {
  const out = new Map<string, string>()
  let key: string | null = null
  let parts: string[] = []
  const flush = () => { if (key !== null && PRIVILEGE_KEYS.has(key)) out.set(key, parts.join('\n')) }
  for (const raw of head) {
    const m = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(raw)
    if (m) {
      flush()
      key = m[1].toLowerCase()
      parts = [m[2].trim()]
    } else if (key !== null) {
      parts.push(raw.trim())
    }
  }
  flush()
  return out
}

/** Canonical JSON of a loaded YAML value: sorted keys, dates as ISO text, bounded in nodes and depth. */
function canonical(value: unknown, budget: { nodes: number }, depth = 0): string {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new HeadTooComplex()
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(Number.isNaN(value.getTime()) ? 'invalid-date' : value.toISOString())
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, budget, depth + 1)).join(',')}]`
  if (value instanceof Map) {
    return canonical(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])), budget, depth)
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, budget, depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(typeof value === 'bigint' ? value.toString() : value)
}

/**
 * The YAML view: the head up to the first column-0 `---` line, loaded by js-yaml with its default (safe) schema.
 * Returns the privilege keys it sees (normalized: trimmed, lower case) with their canonical values, or 'unparsable'
 * when the head is too large, too complex, or not valid YAML.
 */
function yamlBlocks(head: string[]): Map<string, string> | 'unparsable' {
  const text = head.join('\n')
  if (Buffer.byteLength(text, 'utf-8') > MAX_HEAD_BYTES) return 'unparsable'
  let loaded: unknown
  try { loaded = yamlLoad(text) } catch { return 'unparsable' }
  const out = new Map<string, string>()
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) return out // no mapping: no keys to read
  const budget = { nodes: 0 }
  try {
    const entries = loaded instanceof Map ? [...loaded.entries()] : Object.entries(loaded as Record<string, unknown>)
    for (const [rawKey, value] of entries) {
      const key = String(rawKey).trim().toLowerCase()
      if (!PRIVILEGE_KEYS.has(key)) continue
      const canon = canonical(value, budget)
      // two keys that differ only in case or spacing are one key to the gate: keep both values so neither hides the other
      out.set(key, out.has(key) ? `${out.get(key)}|${canon}` : canon)
    }
  } catch (err) {
    if (err instanceof HeadTooComplex) return 'unparsable'
    throw err
  }
  return out
}

/** The text between the leading `---` lines as the original line scanner reads it, or null when there is no frontmatter. */
function frontmatterOf(content: string): string[] | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(1, i)
  }
  return null // never closed: not a frontmatter, so nothing in it is read as a privilege key
}

/**
 * The privilege blocks as the line SCANNER reads them (one of the two views, kept as its own export: the
 * comparison the gate runs is privilegeView below). key -> the key's own line value plus its indented continuation
 * lines, joined. A top-level key starts at column 0 with `name:`; a line that starts with whitespace or `-` continues
 * the previous key. A key that appears twice keeps its last block.
 */
export function privilegeBlocks(content: string): Map<string, string> {
  const fm = frontmatterOf(content)
  return fm ? scanBlocks(fm) : new Map<string, string>()
}

/**
 * The privilege view the gate compares: privilege key -> one entry holding BOTH views of the key (`yaml:` the canonical
 * value a YAML loader sees, `scan:` the line scanner's text), so a change in either is a change and a key only one view
 * sees still counts. Two synthetic entries make the comparison fail closed: `!region` (the head and everything up to the
 * last column-0 `---` line, when the scanner and the YAML loader disagree where the head ends) and `!unparsable` (a head
 * that is not valid YAML, is larger than 64 KB or is too complex to canonicalize): any edit there counts as touching
 * privilege. A leading BOM is dropped first. A key that appears twice keeps its last scanner block, and both YAML values.
 */
export function privilegeView(content: string): Map<string, string> {
  const out = new Map<string, string>()
  const head = headOf(content)
  if (!head) return out
  const { lines, scanEnd, yamlEnd } = head

  const scanned = scanEnd === -1 ? new Map<string, string>() : scanBlocks(lines.slice(1, scanEnd))
  const yaml = yamlEnd === -1 ? new Map<string, string>() : yamlBlocks(lines.slice(1, yamlEnd))

  if (yaml === 'unparsable') {
    const headText = lines.slice(1, yamlEnd).join('\n')
    out.set('!unparsable', sha256Hex(headText))
    // a head nobody could parse that also NAMES a capability key (bare, quoted or in a flow mapping, any case, anywhere in
    // its text): this one gates a create too. A harmless colon in a description does not.
    if (CAPABILITY_NAME.test(headText)) out.set('!unparsable-cap', sha256Hex(headText))
  }
  if (scanEnd !== yamlEnd) {
    // The two readers close the head at different lines: an indented `---` sits inside a block, or one of them never closes.
    let last = Math.max(scanEnd, yamlEnd)
    for (let i = last + 1; i < lines.length; i++) if (/^---[ \t]*$/.test(lines[i])) last = i
    out.set('!region', sha256Hex(lines.slice(0, last + 1).join('\n')))
  }

  const yamlMap = yaml === 'unparsable' ? new Map<string, string>() : yaml
  for (const key of new Set([...scanned.keys(), ...yamlMap.keys()])) {
    out.set(key, `yaml:${yamlMap.get(key) ?? ''}\nscan:${scanned.get(key) ?? ''}`)
  }
  return out
}

const isRunnable = (f: SkillFileFacts): boolean => f.rel_path.startsWith('scripts/') || (f.mode & 0o111) !== 0
const runnableId = (f: SkillFileFacts): string => `${f.rel_path}\0${f.mode}\0${sha256Hex(f.content)}`

export interface PrivilegeVerdict {
  touches: boolean
  /** Why, in words that name the rule and never the text: for the audit trail and the answer. */
  reasons: Array<'script' | 'frontmatter'>
}

/**
 * Compares the state a skill has with the state that is proposed. `before` is null for a skill that has no live state
 * (a new one): then every runnable file counts as new, but `description` does not -- it only gates as a CHANGE from
 * an already-approved value (the update path, where it is a privilege key because it decides when a model picks the
 * skill), and a brand-new skill has no approved value to diverge from. Only an actual new capability grant
 * (`allowed-tools`/`allowed_tools`/`tools`/`hooks`, or a new runnable file) gates a create. A head that the two readers
 * split differently (`!region`) gates a create too: nothing can be promised about what it grants. A head that cannot be
 * parsed (`!unparsable`) does NOT gate a create by itself: on the real corpus about a quarter of the SKILL.md files are
 * unparsable, all for one harmless reason (an unquoted description with a colon), and the loader reads them fine, so
 * gating them would park every fourth new skill for nothing. It gates a create only when the unparsable head also holds
 * a capability key name (`!unparsable-cap`). On an update every one of the three counts, as any change of a head the
 * gate cannot read.
 */
export function skillTouchesPrivilege(
  before: { content: string; files: readonly SkillFileFacts[] } | null,
  after: { content: string; files: readonly SkillFileFacts[] },
): PrivilegeVerdict {
  const reasons: PrivilegeVerdict['reasons'] = []

  const hadRunnable = new Set((before?.files ?? []).filter(isRunnable).map(runnableId))
  if (after.files.filter(isRunnable).some((f) => !hadRunnable.has(runnableId(f)))) reasons.push('script')

  const was = before ? privilegeView(before.content) : new Map<string, string>()
  const now = privilegeView(after.content)
  const keys = new Set([...was.keys(), ...now.keys()])
  for (const k of keys) {
    if (before === null && (k === 'description' || k === '!unparsable')) continue
    if ((was.get(k) ?? '') !== (now.get(k) ?? '')) { reasons.push('frontmatter'); break }
  }
  return { touches: reasons.length > 0, reasons }
}
