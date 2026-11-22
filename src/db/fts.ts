// FTS5 spellings and the query builders for the SQLite engine (phase 3, c2). The only file that holds the MATCH
// text of the FTS5 tables: the callers interpolate the constants below, so the SQL bytes are the same as before.
// The PostgreSQL side (tsvector, phraseto_tsquery, GIN) is added beside these in later steps.

// Build a safe FTS5 MATCH expression from a free-form user query.
//
// FTS5 treats AND / OR / NOT / NEAR as reserved operators only when uppercase
// and unquoted -- so we lowercase everything, which turns them into ordinary
// search terms. We also cap the number and length of tokens to bound query
// cost (the sanitizer previously allowed an arbitrary-length prefix expansion
// that could make a single request scan the entire index).
export function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    // Replace punctuation with a space (not delete) so "rank-check" / "serper.dev"
    // tokenize the same way unicode61 indexed them (rank + check), instead of
    // fusing into a single unfindable token "rankcheck".
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

/** Phrase spelling of one user text for FTS5: the whole text is one quoted phrase, a quote is doubled. */
export function ftsEscape(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

// FTS5 MATCH expression for a box of words: every whitespace-separated word, quoted (so FTS operators typed by
// the user are plain text), all of them required. null when there is no word.
export function ftsAllTerms(q: string): string | null {
  const terms = q.split(/\s+/).filter(Boolean)
  return terms.length ? terms.map(ftsEscape).join(' ') : null
}

/** The MATCH clauses, one per FTS5 table and column scope; the callers put them into their SQL unchanged. */
export const FTS_MATCH = {
  /** memories_fts, one column (the chat search: content only) */
  memoryContent: 'f.content MATCH ?',
  /** memories_fts, every column (the agent search and the recall search) */
  memoryAll: 'f.memories_fts MATCH ?',
  /** artifacts_fts, the artifact search (a subquery on rowid) */
  artifact: 'artifacts_fts MATCH ?',
  /** workspace_docs_fts, the workspace document search (joined from ftsFrom) */
  workspace: 'workspace_docs_fts MATCH ?',
} as const
