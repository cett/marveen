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
import { sha256Hex } from './db/skill-revisions.js'

export interface SkillFileFacts {
  rel_path: string
  mode: number
  content: Buffer
}

/** The frontmatter keys whose block counts as a privilege. Lower case; compared exactly. */
const PRIVILEGE_KEYS: ReadonlySet<string> = new Set(['allowed-tools', 'allowed_tools', 'tools', 'hooks', 'description'])

/** The text between the leading `---` lines, or null when the file has no frontmatter. */
function frontmatterOf(content: string): string[] | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(1, i)
  }
  return null // never closed: not a frontmatter, so nothing in it is read as a privilege key
}

/**
 * The privilege blocks of a SKILL.md: key -> the key's own line value plus its indented continuation lines, joined.
 * A top-level key starts at column 0 with `name:`; a line that starts with whitespace or `-` continues the previous key.
 * A key that appears twice keeps its last block (the way a YAML loader would), so a duplicate cannot hide an edit.
 */
export function privilegeBlocks(content: string): Map<string, string> {
  const out = new Map<string, string>()
  const fm = frontmatterOf(content)
  if (!fm) return out
  let key: string | null = null
  let parts: string[] = []
  const flush = () => { if (key !== null && PRIVILEGE_KEYS.has(key)) out.set(key, parts.join('\n')) }
  for (const raw of fm) {
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
 * (`allowed-tools`/`allowed_tools`/`tools`/`hooks`, or a new runnable file) gates a create.
 */
export function skillTouchesPrivilege(
  before: { content: string; files: readonly SkillFileFacts[] } | null,
  after: { content: string; files: readonly SkillFileFacts[] },
): PrivilegeVerdict {
  const reasons: PrivilegeVerdict['reasons'] = []

  const hadRunnable = new Set((before?.files ?? []).filter(isRunnable).map(runnableId))
  if (after.files.filter(isRunnable).some((f) => !hadRunnable.has(runnableId(f)))) reasons.push('script')

  const was = before ? privilegeBlocks(before.content) : new Map<string, string>()
  const now = privilegeBlocks(after.content)
  const keys = new Set([...was.keys(), ...now.keys()])
  for (const k of keys) {
    if (before === null && k === 'description') continue
    if ((was.get(k) ?? '') !== (now.get(k) ?? '')) { reasons.push('frontmatter'); break }
  }
  return { touches: reasons.length > 0, reasons }
}
