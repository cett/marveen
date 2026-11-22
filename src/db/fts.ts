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
 * The ts_rank normalization bitmask (PostgreSQL): 0 = none, 1 = divide by 1+log(document length), 2 = divide by document
 * length, 8 = divide by the number of unique words, 32 = rank / (rank + 1). ONE constant for every PostgreSQL ranking query
 * (memories, recall, workspace documents); calibrated by the recall harness (step 6a): 1 (divide by document length).
 */
export const PG_RANK_NORMALIZATION = 1

/**
 * The negated, scaled PostgreSQL rank of one tsvector against one tsquery expression (lower is better, as bm25 is).
 * `vec` and `query` are SQL expressions (column names, bind placeholders); the constants are interpolated, never user input.
 */
export function pgRankSql(vec: string, query: string): string {
  return `-(ts_rank('{1,1,1,1}', ${vec}, ${query}, ${PG_RANK_NORMALIZATION}) * ${PG_RANK_SCALE})`
}

/**
 * The tsquery text of the builder output (`tok1* tok2*`): every token prefix-matched, the tokens AND-ed. `weight` restricts
 * the match to one weight (the chat search: content, weight A). The tokens are letters and digits only (the builder
 * sanitizes them), so no tsquery operator can enter; the text is still passed as a bind parameter. null when no token.
 */
export function ftsPgTsQuery(tokens: string[], weight?: 'A'): string | null {
  if (tokens.length === 0) return null
  return tokens.map((t) => (weight ? `${t}:${weight}*` : `${t}:*`)).join(' & ')
}

// -- PostgreSQL phrase and word search (phase 3, 6a W2): the one candidate query and the one phrase check --------------

/**
 * The size (characters of the title and the content, bytes of an artifact body) up to which the phrase is checked by the
 * tsvector alone (phraseto). A row this short has at most 16000 words (a word and its space take two characters), under
 * the tsvector position ceiling 16383, so the phraseto is exact there. A longer row gets the text check (pgPhraseIn).
 * ONE constant: the text check costs linearly in the rows that take it (measured in the 6a report).
 */
export const PG_PHRASE_VERIFY_CHARS = 32000

/**
 * The candidate query of a text search: every lexeme of the normalized text, ANDed, NO positions. It is a superset of
 * the phrase: a phrase match needs all its lexemes, so the index never drops a row the phrase check would accept. A
 * phrase query (phraseto_tsquery) is position-dependent: past the tsvector position ceiling (16383) it never matches, so
 * it must not be the index condition. null when the text has no word (a blank or a punctuation-only text).
 */
export function pgCandidateTsq(text: string): { sql: string; params: unknown[] } | null {
  if (text.trim() === '') return null
  return { sql: `plainto_tsquery(${PG_FTS_CONFIG}, public.fts_norm(?))`, params: [text] }
}

/**
 * The phrase check of one text part: true when the query, normalized the way the index normalizes (fts_norm, then the
 * accent and case fold of the config), is a whole-word run of the normalized text. `textSql` is an SQL expression of the
 * text (a column, or a CASE), checked on its own: the text of two parts is never run into one. The query is a bind
 * parameter; the text is never joined to another part.
 */
export function pgPhraseIn(textSql: string, query: string): { sql: string; params: unknown[] } {
  return {
    sql: `strpos(' ' || lower(public.unaccent(trim(public.fts_norm(${textSql})))) || ' ', ' ' || lower(public.unaccent(trim(public.fts_norm(?)))) || ' ') > 0`,
    params: [query],
  }
}
