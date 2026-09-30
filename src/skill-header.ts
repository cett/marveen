// Marker line for SKILL.md files generated from the skills table. The file is a
// cache of the DB row (the DB is the source of truth), and the line tells a
// human, or an agent about to Edit it, where the real copy lives.
//
// It goes AFTER the frontmatter: Claude Code's skill loader wants the
// frontmatter as the very first thing in the file. Stored DB content never
// carries it (every write path strips it), so strip(add(x)) === x.

const MARKER = '<!-- GENERATED from the skills DB'

export interface GeneratedHeaderInfo { id: string | null; tenant: boolean }

function headerLine(id: string, tenant: boolean): string {
  const safeId = /^[A-Za-z0-9._\/-]+$/.test(id) ? id : ''
  const what = tenant ? 'tenant skill' : 'skill'
  const ident = safeId ? ` (${what} ${safeId})` : ''
  return `${MARKER}${ident}. Edit it in the dashboard or via PUT /api/skills/sql/<url-encoded id>; ` +
    `this file is rewritten from the DB, a direct edit is only kept if the file->DB hook synced it. -->`
}

function frontmatterEnd(content: string): number {
  // Offset just past the closing "---" line (including its newline, if any), or 0 when there is no frontmatter.
  const m = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/)
  return m ? m[0].length : 0
}

function findHeader(content: string): { start: number; end: number; eof: boolean } | null {
  let pos = 0
  while (pos <= content.length) {
    const nl = content.indexOf('\n', pos)
    const lineEnd = nl === -1 ? content.length : nl
    if (content.startsWith(MARKER, pos) && content.slice(pos, lineEnd).trimEnd().endsWith('-->')) {
      return { start: pos, end: nl === -1 ? lineEnd : nl + 1, eof: nl === -1 }
    }
    if (nl === -1) break
    pos = nl + 1
  }
  return null
}

export function addGeneratedHeader(content: string, id: string, opts: { tenant?: boolean } = {}): string {
  const bare = stripGeneratedHeader(content)
  const line = headerLine(id, !!opts.tenant)
  const at = frontmatterEnd(bare)
  if (at === 0) return `${line}\n${bare}`
  const before = bare.slice(0, at)
  const after = bare.slice(at)
  // Frontmatter closing line without a trailing newline (file ends there).
  if (!before.endsWith('\n')) return `${before}\n${line}`
  return `${before}${line}\n${after}`
}

export function stripGeneratedHeader(content: string): string {
  const h = findHeader(content)
  if (!h) return content
  // A header at EOF has no trailing newline of its own: drop the newline that preceded it.
  if (h.eof && h.start > 0 && content[h.start - 1] === '\n') return content.slice(0, h.start - 1)
  return content.slice(0, h.start) + content.slice(h.end)
}

export function readGeneratedHeader(content: string): GeneratedHeaderInfo | null {
  const h = findHeader(content)
  if (!h) return null
  const line = content.slice(h.start, h.end)
  const m = line.match(/\((tenant skill|skill) ([^)\s]+)\)/)
  return { id: m ? m[2] : null, tenant: m ? m[1] === 'tenant skill' : false }
}
