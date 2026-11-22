// The FTS5 query builders keep their SQLite output (phase 3, c2): the sanitizer that builds the MATCH expression of the
// memory searches, the phrase spelling of a whole text, and the every-word-required spelling of the workspace search.
// The expected values are the outputs of the code before the move (captured on develop 8f9a03802), so a move that
// changes a byte fails here. SQLite only: the builders are pure text functions, no database.
// The source pin at the end is weak (a text scan, named as such): it says where the MATCH text may live, nothing more.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildFtsMatchExpression, ftsAllTerms, ftsEscape } from '../db/fts.js'

const INPUTS = [
  '', ' ', 'hello', 'Hello World', 'rank-check', 'serper.dev', 'a_b', 'http://x.hu/p?q=1', 'jo@ex.com',
  'AND OR NOT', 'NEAR(a b)', '"quoted phrase"', '*', 'a\\b', "it's", 'ö ő ü ű', 'tier_1 100%',
  'a'.repeat(70), 'word '.repeat(25), 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22',
]

// JSON.stringify of buildFtsMatchExpression over INPUTS, captured before the move (develop 8f9a03802).
const GOLDEN = '["","","hello*","hello* world*","rank* check*","serper* dev*","a* b*","http* x* hu* p* q* 1*","jo* ex* com*","and* or* not*","near* a* b*","quoted* phrase*","","a* b*","it* s*","ö* ő* ü* ű*","tier* 1* 100*","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa*","word* word* word* word* word* word* word* word* word* word* word* word* word* word* word* word* word* word* word* word*","w1* w2* w3* w4* w5* w6* w7* w8* w9* w10* w11* w12* w13* w14* w15* w16* w17* w18* w19* w20*"]'

describe('buildFtsMatchExpression: the SQLite output is unchanged', () => {
  it('gives the same expression for every input (20 inputs: empty, punctuation, operators, quotes, 64+ chars, 20+ tokens)', () => {
    expect(INPUTS.length).toBe(20)
    expect(JSON.stringify(INPUTS.map((q) => buildFtsMatchExpression(q)))).toBe(GOLDEN)
  })
})

describe('ftsEscape and ftsAllTerms: the phrase and the every-word spelling', () => {
  it('quotes the whole text as one phrase, doubling the inner quotes', () => {
    expect(ftsEscape('say "hi"')).toBe('"say ""hi"""')
    expect(ftsEscape('')).toBe('""')
    expect(ftsEscape('AND OR')).toBe('"AND OR"')
  })

  it('quotes every word on its own (the words are AND-ed), null for no word', () => {
    expect(ftsAllTerms('a "b"')).toBe('"a" """b"""')
    expect(ftsAllTerms('  x   y ')).toBe('"x" "y"')
    expect(ftsAllTerms('')).toBeNull()
    expect(ftsAllTerms('   ')).toBeNull()
  })
})

describe('the MATCH text lives in db/fts.ts (weak source pin, named as such)', () => {
  it('no other db module spells an FTS5 MATCH clause; the vector MATCH (vec0) is out of scope here', () => {
    const dir = path.resolve(__dirname, '..', 'db')
    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f === 'fts.ts' || f === 'vector.ts') continue
      const code = readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('//'))
        .join('\n')
      if (/\bMATCH\s+[?@:]/i.test(code) && !/embedding MATCH/.test(code)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
