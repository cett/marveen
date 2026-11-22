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
export function ftsTokens(query: string): string[] {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    // Replace punctuation with a space (not delete) so "rank-check" / "serper.dev"
    // tokenize the same way unicode61 indexed them (rank + check), instead of
    // fusing into a single unfindable token "rankcheck".
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  if (!sanitized) return []
  return sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN))
}

/** The SQLite MATCH expression: every token prefix-matched; FTS5 ANDs the space-separated terms. */
export function buildFtsMatchExpression(query: string): string {
  return ftsTokens(query).map((t) => t + '*').join(' ')
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

// -- PostgreSQL (phase 3, c3): the same questions on the generated tsvector of migration 0004 --------------------------

/** The regconfig of the full-text search (migration 0003), as SQL text: a constant, never user input. */
export const PG_FTS_CONFIG = "'public.marveen_fts'"

/**
 * Multiplier of the PostgreSQL rank: ts_rank is about 0..0.6 where bm25 is larger, so an uncalibrated recency blend would
 * lean toward recency. ONE constant, calibrated by the recall harness (c9); 1 until then.
 */
export const PG_RANK_SCALE = 1

/**
 * The tsquery text of the builder output (`tok1* tok2*`): every token prefix-matched, the tokens AND-ed. `weight` restricts
 * the match to one weight (the chat search: content, weight A). The tokens are letters and digits only (the builder
 * sanitizes them), so no tsquery operator can enter; the text is still passed as a bind parameter. null when no token.
 */
export function ftsPgTsQuery(tokens: string[], weight?: 'A'): string | null {
  if (tokens.length === 0) return null
  return tokens.map((t) => (weight ? `${t}:${weight}*` : `${t}:*`)).join(' & ')
}
