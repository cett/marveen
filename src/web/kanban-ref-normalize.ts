// Rewrites `#<hex8>` kanban-card references inside inter-agent messages and
// kanban comments to the human-facing `#<seq>` form before the content is
// persisted. The CLAUDE.md rule "hivatkozz #seq-vel, ne UUID-vel" is agent
// guidance; this is the code-side enforcement so the dashboard never shows
// the hex form even if a sub-agent forgets the convention.
//
// The matcher is intentionally narrow: only an 8-char `[a-f0-9]` token
// directly behind a `#` and on a word boundary, lookup-gated against
// kanban_cards. A non-match (random hex, GitHub PR `#308`, etc.) passes
// through untouched. The explicit-disambiguation pattern `#31 (cb5080e5)`
// keeps the seq intact (`#31` doesn't match the hex regex) and the bare
// `(cb5080e5)` in parens lacks the `#` prefix so it also passes through.

const HEX8_REF_RE = /#([a-f0-9]{8})\b/gi

export type SeqLookup = (idPrefix: string) => number | null | Promise<number | null>

export async function normalizeKanbanRefs(content: string, lookup: SeqLookup): Promise<string> {
  if (!content || content.indexOf('#') === -1) return content
  // The lookup hits the database: resolve every distinct token first (in order of appearance), then rewrite
  // synchronously, so the replace callback never has to await.
  const seqs = new Map<string, number | null>()
  for (const m of content.matchAll(HEX8_REF_RE)) {
    const hex = m[1].toLowerCase()
    if (!seqs.has(hex)) seqs.set(hex, await lookup(hex))
  }
  return content.replace(HEX8_REF_RE, (match, hex: string) => {
    const seq = seqs.get(hex.toLowerCase())
    if (seq == null) return match
    return `#${seq}`
  })
}
