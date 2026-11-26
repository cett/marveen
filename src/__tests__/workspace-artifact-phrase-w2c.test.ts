// The W2c probes for the W2 head (12330d5f2): the 32000-character threshold, the words that normalize to nothing, and the
// parity of the short and the long branch. Both engines: SQLite is the reference. The PostgreSQL-only cells are skipped on
// SQLite (it.skipIf). Durations are not asserted; the cells check hit sets and counts only.
import { describe, expect, it } from 'vitest'
import { dbx, saveWorkspaceDoc, searchWorkspaceDocs, searchWorkspaceDocsPage, createArtifact, listArtifacts, countArtifacts } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'

useTestDb()
const pgOnly = it.skipIf(testDbMode() !== 'pg')

const doc = (title: string, content: string, tenant = 'default') =>
  saveWorkspaceDoc({ agent_id: 'agent-a', tenant_id: tenant, title, content, content_blob: null, content_type: 'text', type: 'plan' })
const listTitles = async (q: string, tenant: string) =>
  (await searchWorkspaceDocsPage(q, { tenantId: tenant, limit: 100 } as never)).items.map((d) => d.title).sort()
const phraseTitles = async (q: string, tenant: string) =>
  (await searchWorkspaceDocs(q, { tenantId: tenant, limit: 100 })).map((d) => d.title).sort()
const listCount = async (q: string, tenant: string) => (await searchWorkspaceDocsPage(q, { tenantId: tenant, limit: 100 } as never)).total

const QUERIES = [
  'rank-check', 'rank check', 'serper.dev', 'serper dev', "don't", 'a1b2', 'abc123def', 'Árvíztűrő', 'ARVIZTURO', 'straße', 'STRASSE',
  'İstanbul', 'istanbul', 'x²y', 'café', 'café', '日本語 テスト', 'Привет мир', 'a & b', 'Q3 - plan', 'foo / bar', 'rank ~ check',
  'puncword !!!', '!!! puncword', 'puncword | & -', '- puncword', '!!!', '|', 'alpha ! beta', 'alpha beta', 'report plan', 'Quarterly',
  'Quarterly report plan', 'plan rank', 'tail', 'quarterly puncword', 'rank-check serper.dev', 'rank-check ready', 'zz', 'Decoy',
]
const D1 = "Rank-check is serper.dev ready. don't a1b2 abc123def Árvíztűrő straße İstanbul x²y café 日本語 テスト Привет мир a & b rank ~ check Q3 - plan foo / bar puncword alpha beta tail"
const D2 = 'rank here check there serper here dev there alpha far away beta Q3 later plan foo bar stuff'
const PAD = ' ' + 'zz '.repeat(11000)

describe('WT1 short row vs long row: the same document, the same hits (both branches), and the SQLite reference', () => {
  it('every query: list and phrase hits of the short copy equal those of the padded (over 32000 characters) copy', async () => {
    await doc('Quarterly report plan', D1, 'ts'); await doc('Decoy notes', D2, 'ts')
    await doc('Quarterly report plan', D1 + PAD, 'tl'); await doc('Decoy notes', D2 + PAD, 'tl')
    const mismatch: string[] = []
    for (const q of QUERIES) {
      const ls = await listTitles(q, 'ts'); const ll = await listTitles(q, 'tl')
      const ps = await phraseTitles(q, 'ts'); const pl = await phraseTitles(q, 'tl')
      const cs = await listCount(q, 'ts'); const cl = await listCount(q, 'tl')
      // the pad word zz is searched on purpose only by the query 'zz'; for it the short copy has no hit by design
      if (q === 'zz') continue
      if (JSON.stringify(ls) !== JSON.stringify(ll)) mismatch.push(`${q} list short ${ls} long ${ll}`)
      if (JSON.stringify(ps) !== JSON.stringify(pl)) mismatch.push(`${q} phrase short ${ps} long ${pl}`)
      if (cs !== cl) mismatch.push(`${q} count short ${cs} long ${cl}`)
      if (cs !== ls.length) mismatch.push(`${q} count ${cs} != list ${ls.length}`)
    }
    expect(mismatch).toEqual([])
    // About 40 queries x 6 searches over rows of more than 32000 characters: about 5 s alone, but a pull request's `vitest related`
    // run can select every test that reaches with-test-db.ts (122 files), and on a loaded runner this one cell went past the
    // default 15 s (one CI run and one local run under load, 2026-11-26). Only this cell gets the longer limit; nothing it asserts changed.
  }, 45_000)
})

describe('WT2 the threshold: title + content length exactly around 32000, dense one-character words', () => {
  it('phrase at the end of a dense row: found, the decoy with a word between is not, for every length 31994..32006', async () => {
    const bad: string[] = []
    for (let L = 31994; L <= 32006; L++) {
      const tenant = `tb${L}`
      // adjacent: title 'T' (1 char) + content ' '*odd + 'a '*k + 'xq yq' = 1 + odd + 2k + 5
      const odd = (L - 6) % 2
      const k = (L - 6 - odd) / 2
      const adjC = ' '.repeat(odd) + 'a '.repeat(k) + 'xq yq'
      // decoy: 1 + odd + 2(k-1) + 7 = L
      const decC = ' '.repeat(odd) + 'a '.repeat(k - 1) + 'xq a yq'
      await doc('T', adjC, tenant); await doc('T', decC, tenant)
      const lens = (await dbx.all('SELECT length(title) + length(content) AS n FROM workspace_docs WHERE tenant_id = ? ORDER BY id', tenant)) as Array<{ n: number }>
      if (lens.length !== 2 || lens[0]!.n !== L || lens[1]!.n !== L) bad.push(`len ${L}: ${JSON.stringify(lens)}`)
      const rows = await searchWorkspaceDocs('xq yq', { tenantId: tenant, limit: 10 })
      if (rows.length !== 1) bad.push(`${L} phrase hits ${rows.length}`)
      const pg = await searchWorkspaceDocsPage('xq yq', { tenantId: tenant, limit: 10 } as never)
      if (pg.total !== 2) bad.push(`${L} list total ${pg.total}`)
    }
    expect(bad).toEqual([])
  })

  it('WT2b a dense TITLE: phrase at the end of a title of 31998..32004 characters (content tiny)', async () => {
    const bad: string[] = []
    for (const L of [31998, 32000, 32002, 32004]) {
      const tenant = `tt${L}`
      const k = Math.floor((L - 5) / 2)
      const pad = L - (2 * k + 5)
      const title = ' '.repeat(pad) + 'a '.repeat(k) + 'xq yq'
      await doc(title, 'filler', tenant)
      const r = await searchWorkspaceDocs('xq yq', { tenantId: tenant, limit: 10 })
      if (r.length !== 1) bad.push(`${L} title phrase ${r.length}`)
    }
    expect(bad).toEqual([])
  })

  it('WT2c the title counts in the length: a 20000 character title plus a 18005 character content, phrase at the end of the content', async () => {
    const title = 'a '.repeat(10000)
    const content = 'a '.repeat(9000) + 'xq yq'
    await doc(title, content, 'tc')
    await doc(title, 'a '.repeat(9000) + 'xq a yq', 'tc')
    const r = await searchWorkspaceDocs('xq yq', { tenantId: 'tc', limit: 10 })
    expect(r.length).toBe(1)
  })

  it('WT2e the title counts in the length (distinct title tokens, so each one holds a position): content alone under 32000, title + content over', async () => {
    const tok = (i: number) => String.fromCharCode(97 + (Math.floor(i / 676) % 26), 97 + (Math.floor(i / 26) % 26), 97 + (i % 26))
    const title = Array.from({ length: 7000 }, (_, i) => tok(i)).join(' ')
    await doc(title, 'a '.repeat(9400) + 'xq yq', 'te')
    await doc(title, 'a '.repeat(9400) + 'xq a yq', 'te')
    const r = await searchWorkspaceDocs('xq yq', { tenantId: 'te', limit: 10 })
    expect(r.length).toBe(1)
  })

  it('WT2d content just over the threshold but a tiny title, tokens long (few tokens): found by the text check', async () => {
    const content = 'longwordnumber '.repeat(2100) + 'xq yq'
    await doc('T', content, 'td')
    expect((await searchWorkspaceDocs('xq yq', { tenantId: 'td', limit: 10 })).length).toBe(1)
  })
})

describe('WR4 words that normalize to nothing (list and phrase search), short and long copy', () => {
  it('list: the punctuation word is dropped, in every position, on a short and on a long row', async () => {
    await doc('Punct short', 'puncword is here alpha beta', 'tr')
    await doc('Punct long', 'puncword is here alpha beta' + PAD, 'tr')
    const want = ['Punct long', 'Punct short']
    const qs = ['puncword !!!', '!!! puncword', '! puncword !', 'puncword | alpha & beta', '- puncword -', 'alpha ~ beta', 'puncword / alpha', '|| puncword ||| alpha !!! beta']
    const bad: string[] = []
    for (const q of qs) {
      const r = await listTitles(q, 'tr')
      if (JSON.stringify(r) !== JSON.stringify(want)) bad.push(`${q}: ${r}`)
    }
    for (const q of ['!!!', '|', '- -', '& | !', '   ']) {
      const pg = await searchWorkspaceDocsPage(q, { tenantId: 'tr', limit: 10 } as never)
      if (pg.total !== 0 || pg.items.length !== 0) bad.push(`all-punct ${q}: ${pg.total}`)
      const p = await searchWorkspaceDocs(q, { tenantId: 'tr', limit: 10 })
      if (p.length !== 0) bad.push(`all-punct phrase ${q}: ${p.length}`)
    }
    expect(bad).toEqual([])
  })

  it('list: a dropped word does not loosen the others: a real word that is missing still gives no hit', async () => {
    await doc('Only alpha', 'alpha here', 'tr2'); await doc('Only alpha long', 'alpha here' + PAD, 'tr2')
    expect(await listTitles('alpha nowordlikethis !!!', 'tr2')).toEqual([])
    expect(await listTitles('!!! nowordlikethis', 'tr2')).toEqual([])
    expect(await listCount('alpha nowordlikethis !!!', 'tr2')).toBe(0)
  })

  it('list: a word of both punctuation and token (a-!-b, a.-.b) behaves as its tokens; hyphen only between real tokens', async () => {
    await doc('Adj', 'rankp checkp together', 'tr3'); await doc('Adj long', 'rankp checkp together' + PAD, 'tr3')
    await doc('Far', 'rankp and then checkp', 'tr3'); await doc('Far long', 'rankp and then checkp' + PAD, 'tr3')
    const bad: string[] = []
    for (const q of ['rankp-checkp', 'rankp.checkp', 'rankp--checkp', 'rankp_checkp', 'rankp-!-checkp']) {
      const r = await listTitles(q, 'tr3')
      if (JSON.stringify(r) !== JSON.stringify(['Adj', 'Adj long'])) bad.push(`${q}: ${r}`)
    }
    expect(bad).toEqual([])
  })
})

describe('WS scope and binary on the long branch of the list search (R4 code path)', () => {
  it('tenant, agent, binary on long rows, list search with a punctuation word', async () => {
    const mine = await doc('Scope', 'scopeq here' + PAD, 'tsc')
    await saveWorkspaceDoc({ agent_id: 'agent-b', tenant_id: 'tsc', title: 'Scope b', content: 'scopeq here' + PAD, content_blob: null, content_type: 'text', type: 'plan' })
    await doc('Scope other tenant', 'scopeq here' + PAD, 'tsc-other')
    const bin = await saveWorkspaceDoc({ agent_id: 'agent-a', tenant_id: 'tsc', title: 'Bin zebra', content: null, content_blob: Buffer.from([1, 2, 3]), content_type: 'binary', type: 'plan' })
    await dbx.run('UPDATE workspace_docs SET content = ? WHERE id = ?', 'scopeq binary ' + PAD, bin.id)
    const r = await searchWorkspaceDocsPage('scopeq !!!', { tenantId: 'tsc', agentId: 'agent-a', limit: 10 } as never)
    expect(r.items.map((x) => x.id)).toEqual([mine.id])
    expect(r.total).toBe(1)
    const all = await searchWorkspaceDocsPage('scopeq - here', { tenantId: 'tsc', limit: 10 } as never)
    expect(all.items.map((x) => x.title).sort()).toEqual(['Scope', 'Scope b'])
    expect(all.total).toBe(2)
  })
})

describe('WB5 a binary row with text in its content column (manual UPDATE; the invariant blanks it) on the long branch', () => {
  it('the content text of a binary row is no phrase and no list evidence, even when the title holds the words apart', async () => {
    const bin = await saveWorkspaceDoc({ agent_id: 'agent-a', tenant_id: 'tb5', title: 'alpha gamma beta', content: null, content_blob: Buffer.from([1, 2, 3]), content_type: 'binary', type: 'plan' })
    await dbx.run('UPDATE workspace_docs SET content = ? WHERE id = ?', 'alpha beta together ' + PAD, bin.id)
    expect(await phraseTitles('alpha beta', 'tb5')).toEqual([])
    expect(await listTitles('alpha-beta', 'tb5')).toEqual([])
  })
})

describe('WA artifact threshold (bytes): phrase at the end of a dense body, found; decoy not', () => {
  it('lengths 31994..32006', async () => {
    const bad: string[] = []
    for (let L = 31994; L <= 32006; L++) {
      const odd = (L - 6) % 2
      const k = (L - 6 - odd) / 2
      const mk = (title: string, body: string) => createArtifact({ agent_id: 'agent-a', tenant_id: `ta${L}`, title, kind: 'text', content: Buffer.from(body) } as never)
      const adj = await mk('T', ' '.repeat(odd) + 'a '.repeat(k) + 'xq yq')
      await mk('T', ' '.repeat(odd) + 'a '.repeat(k - 1) + 'xq a yq')
      const r = (await listArtifacts({ q: 'xq yq', tenant_id: `ta${L}`, limit: 10 } as never)).map((a) => a.id)
      const c = await countArtifacts({ q: 'xq yq', tenant_id: `ta${L}` } as never)
      if (r.length !== 1 || r[0] !== adj.id || c !== 1) bad.push(`${L} hits ${r.length} count ${c}`)
    }
    expect(bad).toEqual([])
  })
})

describe('WT4 a row inside the threshold whose tokens are denser than one per two characters (the claim behind 32000)', () => {
  it('dense mixed-script runs: phrase at the end of a row of 31990+ characters is found (list and phrase), as in the SQLite reference', async () => {
    const pats = ['a٣', 'a１', 'a٣a', 'é１a', 'a１a１', 'Z٣a ', 'x٣ay１b']
    const bad: string[] = []
    for (const pat of pats) {
      const n = Math.floor(31985 / pat.length)
      const tenant = 'tw' + pats.indexOf(pat)
      const content = pat.repeat(n) + ' xq yq'
      const d = await doc('T', content, tenant)
      await doc('T', pat.repeat(n) + ' xq a yq', tenant)
      const len = ((await dbx.get('SELECT length(title) + length(content) AS n FROM workspace_docs WHERE id = ?', d.id)) as { n: number }).n
      const ph = await searchWorkspaceDocs('xq yq', { tenantId: tenant, limit: 10 })
      const li = await searchWorkspaceDocsPage('xq yq', { tenantId: tenant, limit: 10 } as never)
      if (ph.length !== 1) bad.push(`${pat} len ${len} phrase hits ${ph.length}`)
      if (li.total !== 2) bad.push(`${pat} list total ${li.total}`)
    }
    expect(bad).toEqual([])
  })
})

describe('WT5 (PG only) token density: positions * 2 <= characters + 1 for every short mix (the arithmetic behind 32000)', () => {
  pgOnly('strings of 3..5 characters from the dense-prone classes never carry more positions than (length + 1) / 2', async () => {
    const maxPos = (x: string) => `(SELECT coalesce(max(p), 0) FROM unnest(to_tsvector('public.marveen_fts', public.fts_norm(${x}))) AS u(lexeme, positions, weights), unnest(u.positions) AS p)`
    const reps = ['a', 'Z', '5', 'é', 'Ж', '٣', '１', 'ａ', '²', 'ǅ', '日', ' ']
    const arr = `ARRAY[${reps.map((r) => `'${r}'`).join(',')}]`
    const rows = (await dbx.all(`
      WITH r AS (SELECT unnest(${arr}) AS c),
      s AS (
        SELECT r1.c || r2.c || r3.c AS s FROM r r1, r r2, r r3
        UNION ALL SELECT r1.c || r2.c || r3.c || r4.c FROM r r1, r r2, r r3, r r4
        UNION ALL SELECT r1.c || r2.c || r3.c || r4.c || r5.c FROM r r1, r r2, r r3, r r4, r r5)
      SELECT s, len, mx FROM (SELECT s, length(s) AS len, ${maxPos('s')} AS mx FROM s) t WHERE mx * 2 > len + 1 ORDER BY len LIMIT 20`)) as Array<{ s: string; len: number; mx: number }>
    expect(rows).toEqual([])
  }, 900000)

  // The bound behind the threshold: at most one position per two characters, the separator included (a character that is
  // not a token is a separator). macOS measured: a٣a x100 (300 characters) gives 101 positions, a٣a  x100 (400 characters) gives 200. The count is locale- and
  // libc-dependent (on CI's glibc the ٣ is a word character and the count is 1), so the cell pins the inequality, not the number:
  // the dense packing does not arise on CI, and the local run sees it.
  pgOnly('the literals behind the bound: a٣a x100 and a٣a  x100 stay within one position per two characters', async () => {
    const maxPos = (x: string) => `(SELECT coalesce(max(p), 0) FROM unnest(to_tsvector('public.marveen_fts', public.fts_norm(${x}))) AS u(lexeme, positions, weights), unnest(u.positions) AS p)`
    const rows = (await dbx.all(`SELECT ${maxPos("repeat('a٣a', 100)")} AS a, ${maxPos("repeat('a٣a ', 100)")} AS b`)) as Array<{ a: number; b: number }>
    const { a, b } = rows[0]!
    expect(a * 2 <= 300 + 1).toBe(true)
    expect(b * 2 <= 400 + 1).toBe(true)
    expect(a >= 1 && b >= 1).toBe(true)
  })
})
