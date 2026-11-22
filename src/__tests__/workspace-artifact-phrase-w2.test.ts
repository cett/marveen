// The W2 probes (phase 3, 6a): the phrase search of the workspace documents and of the artifacts past the 16383rd word,
// on both engines (SQLite is the reference). The phrase is checked on the normalized text of each part (title, meta,
// content), never across two parts; a binary body is never a hit; the tenant and agent scope is in the SQL. The timing
// cells check only the hit count; durations are not asserted.
import { describe, expect, it } from 'vitest'
import { dbx, saveWorkspaceDoc, searchWorkspaceDocs, searchWorkspaceDocsPage, createArtifact, listArtifacts, countArtifacts } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const doc = (p: { title: string; content?: string; tenant?: string; agent?: string; binary?: boolean }) =>
  saveWorkspaceDoc({
    agent_id: p.agent ?? 'agent-a', tenant_id: p.tenant ?? 'default', title: p.title,
    content: p.binary ? null : (p.content ?? ''), content_blob: p.binary ? Buffer.from([1, 2, 3]) : null,
    content_type: p.binary ? 'binary' : 'text', type: 'plan',
  })

const phrase = async (q: string, f: { tenantId?: string; agentId?: string } = {}) =>
  (await searchWorkspaceDocs(q, { tenantId: f.tenantId ?? 'default', agentId: f.agentId, limit: 50 })).map((d) => d.id).sort()

const page = async (q: string, f: Record<string, unknown> = {}) =>
  (await searchWorkspaceDocsPage(q, { tenantId: 'default', limit: 50, ...f } as never)).items.map((d) => d.id).sort()

const filler = (n: number) => 'f '.repeat(n)

const art = (title: string, body: string, kind: string = 'text', extra: Record<string, unknown> = {}) =>
  createArtifact({ agent_id: 'agent-a', title, kind: kind as never, content: Buffer.from(body), ...extra } as never)

const aids = async (q: string, extra: Record<string, unknown> = {}) =>
  (await listArtifacts({ q, limit: 50, ...extra } as never)).map((a) => a.id).sort()

describe('W2 workspace phrase search', () => {
  it('WA1 a phrase inside the TITLE (content empty or different) is a hit', async () => {
    const t = await doc({ title: 'Quarterly report plan', content: 'nothing about it' })
    const e = await doc({ title: 'Roadmap review notes', content: '' })
    expect(await phrase('report plan')).toEqual([t.id])
    expect(await phrase('review notes')).toEqual([e.id])
  })

  it('WB1 boundary: adjacent words found and gapped words not found, for every start position around 16383', async () => {
    const miss: string[] = []
    for (let k = 16376; k <= 16392; k++) {
      const adj = await doc({ title: `Adj ${k}`, content: `${filler(k)}pa${k} pb${k} tail` })
      await doc({ title: `Gap ${k}`, content: `${filler(k)}ga${k} gx${k} gb${k} tail` })
      const ra = await phrase(`pa${k} pb${k}`)
      const rg = await phrase(`ga${k} gb${k}`)
      if (ra.length !== 1 || ra[0] !== adj.id) miss.push(`adj ${k} found ${ra.length}`)
      if (rg.length !== 0) miss.push(`gap ${k} falsepositive ${rg.length}`)
    }
    expect(miss).toEqual([])
  })

  it('WB2 the false-positive shape: A at 16382, B, C at 16383 (alpha beta is not a hit, alpha gamma is)', async () => {
    await doc({ title: 'FP shape', content: `${filler(16381)}alpha gamma beta tail` })
    expect(await phrase('alpha beta')).toEqual([])
    expect((await phrase('alpha gamma')).length).toBe(1)
  })

  it('WC1 accents and case past the 16383rd word', async () => {
    const d = await doc({ title: 'Accent', content: `${filler(16400)}Árvíztűrő Tükörfúrógép x` })
    expect(await phrase('arvizturo tukorfurogep')).toEqual([d.id])
    expect(await phrase('ÁRVÍZTŰRŐ tükörfúrógép')).toEqual([d.id])
  })

  it('WD1 the title/content border on a long row and on a short row: no phrase runs from one into the other', async () => {
    await doc({ title: 'Long rankx', content: `checkx ${filler(16400)}` })
    await doc({ title: 'Short ranky', content: 'checky values' })
    expect(await phrase('rankx checkx')).toEqual([])
    expect(await phrase('ranky checky')).toEqual([])
  })

  it('WE1 hyphenated and punctuated phrase queries past the 16383rd word (phrase search)', async () => {
    const d = await doc({ title: 'Hyphen', content: `${filler(16400)}rank check done` })
    expect(await phrase('rank-check')).toEqual([d.id])
    expect(await phrase('rank, check')).toEqual([d.id])
  })

  it('WE2 the LIST search (searchWorkspaceDocsPage) with a hyphenated word past the 16383rd word', async () => {
    const d = await doc({ title: 'Hyphen list', content: `${filler(16400)}rankh checkh done` })
    expect(await page('rankh-checkh')).toEqual([d.id])
  })

  it('WF1 tenant and agent scope on long rows (the verification branch)', async () => {
    const mine = await doc({ title: 'Scope long', content: `${filler(16400)}scopeone scopetwo`, tenant: 'default', agent: 'agent-a' })
    await doc({ title: 'Scope long', content: `${filler(16400)}scopeone scopetwo`, tenant: 'tenant-b', agent: 'agent-a' })
    await doc({ title: 'Scope long', content: `${filler(16400)}scopeone scopetwo`, tenant: 'default', agent: 'agent-b' })
    expect(await phrase('scopeone scopetwo', { tenantId: 'default', agentId: 'agent-a' })).toEqual([mine.id])
    expect((await phrase('scopeone scopetwo', { tenantId: 'default' })).length).toBe(2)
    expect((await phrase('scopeone scopetwo', { tenantId: 'tenant-b' })).length).toBe(1)
    expect((await phrase('scopeone scopetwo', { tenantId: 'nobody' })).length).toBe(0)
  })

  it('WG1 a binary document: text in its content column is not a phrase hit', async () => {
    const b = await doc({ title: 'Bin zebra', binary: true })
    await dbx.run('UPDATE workspace_docs SET content = ? WHERE id = ?', `${filler(16400)}binone bintwo`, b.id)
    expect(await phrase('binone bintwo')).toEqual([])
  })

  it('WI1 the 300000-character cap: a phrase inside the cap on a long row is found', async () => {
    const d = await doc({ title: 'Cap doc', content: `${filler(20000)}capone captwo ${'filler '.repeat(40000)}tailone tailtwo` })
    expect(await phrase('capone captwo')).toEqual([d.id])
  })

  it('WK1 the snippet of a phrase hit past the 16383rd word: one row comes back', async () => {
    await doc({ title: 'Snip long', content: `${filler(16400)}snipone sniptwo end` })
    const rows = await searchWorkspaceDocs('snipone sniptwo', { tenantId: 'default', limit: 5 }) as unknown as Array<{ snippet?: string | null }>
    expect(rows).toHaveLength(1)
  })

  it('WL1 a doc that has the words but not the phrase does not hide a doc that has it', async () => {
    const hit = await doc({ title: 'Mix hit', content: 'mixalpha mixbeta here' })
    await doc({ title: 'Mix words', content: 'mixbeta first then mixalpha' })
    expect(await phrase('mixalpha mixbeta')).toEqual([hit.id])
  })

  it('WL2 whole words: the phrase is not a substring of a longer word', async () => {
    await doc({ title: 'Substr', content: 'xalpha beta then alpha later beta' })
    expect(await phrase('alpha beta')).toEqual([])
  })

  it('WP1 timing shape: a common two-word phrase over 40 documents of about 10 KB; the hit count is the document count', async () => {
    const body = 'common words appear here and there '.repeat(300)
    for (let i = 0; i < 40; i++) await doc({ title: `Perf ${i}`, content: `${body} unique${i}` })
    expect((await phrase('common words')).length).toBe(40)
    expect((await page('common words')).length).toBe(40)
  })
  // 6a threshold (PG_PHRASE_VERIFY_CHARS): a short row takes the tsvector phrase; the hit is the same as on the text check
  it('WH1 a short row (under the 32000-character limit) finds its phrase, and a gapped phrase is not a hit', async () => {
    const hit = await doc({ title: 'Short hit', content: `${filler(15000)}shortone shorttwo` })
    await doc({ title: 'Short gap', content: `${filler(15000)}shortgapone x shortgaptwo` })
    expect(await phrase('shortone shorttwo')).toEqual([hit.id])
    expect(await phrase('shortgapone shortgaptwo')).toEqual([])
    expect(await page('shortone shorttwo')).toEqual([hit.id])
  })
})


describe('W2 artifact phrase search', () => {
  it('AA1 long body: found past the 16383rd word, count agrees; the false-positive shape is not a hit', async () => {
    const d = await art('Long', `${filler(16400)}ceilingone ceilingtwo`)
    await art('FPshape', `${filler(16381)}alpha gamma beta tail`)
    expect(await aids('ceilingone ceilingtwo')).toEqual([d.id])
    expect(await countArtifacts({ q: 'ceilingone ceilingtwo' })).toBe(1)
    expect(await aids('alpha beta')).toEqual([])
    expect((await aids('alpha gamma')).length).toBe(1)
  })

  it('AA2 boundary around 16383 on artifacts', async () => {
    const miss: string[] = []
    for (let k = 16378; k <= 16390; k++) {
      const adj = await art(`AdjA ${k}`, `${filler(k)}pa${k} pb${k} tail`)
      await art(`GapA ${k}`, `${filler(k)}ga${k} gx${k} gb${k} tail`)
      const ra = await aids(`pa${k} pb${k}`)
      const rg = await aids(`ga${k} gb${k}`)
      if (ra.length !== 1 || ra[0] !== adj.id) miss.push(`adj ${k}`)
      if (rg.length) miss.push(`gap ${k}`)
    }
    expect(miss).toEqual([])
  })

  it('AB1 title, meta and body phrases; no phrase across the parts; accents on a long body', async () => {
    const t = await art('Quarterly review plan', 'x', 'text')
    const m = await art('Meta holder', '{}', 'json', { meta: { owner: 'zebra stripes' } })
    await art('Ends rankz', 'checkz starts', 'text')
    const acc = await art('Acc', `${filler(16400)}Árvíztűrő tükörfúrógép`, 'text')
    expect(await aids('review plan')).toEqual([t.id])
    expect(await aids('zebra stripes')).toEqual([m.id])
    expect(await aids('rankz checkz')).toEqual([])
    expect(await aids('arvizturo tukorfurogep')).toEqual([acc.id])
  })

  it('AC1 binary kind: body text is never a phrase hit; html body past 16383 is', async () => {
    await art('Blob', `${filler(16400)}binone bintwo`, 'binary')
    const h = await art('Page', `${filler(16400)}htmlone htmltwo`, 'html')
    expect(await aids('binone bintwo')).toEqual([])
    expect(await aids('htmlone htmltwo')).toEqual([h.id])
  })

  it('AC2 binary body is not a phrase hit even when the words sit in the title and the meta', async () => {
    await art('binone', 'binone bintwo', 'binary', { meta: { k: 'bintwo' } })
    expect(await aids('binone bintwo')).toEqual([])
  })

  it('AD1 tenant, agent and kind filters on long bodies', async () => {
    const body = Buffer.from(`${filler(16400)}scopeone scopetwo`)
    const mine = await createArtifact({ agent_id: 'agent-a', tenant_id: 'default', title: 'Sc', kind: 'text', content: body } as never)
    await createArtifact({ agent_id: 'agent-a', tenant_id: 'tenant-b', title: 'Sc', kind: 'text', content: body } as never)
    await createArtifact({ agent_id: 'agent-b', tenant_id: 'default', title: 'Sc', kind: 'text', content: body } as never)
    expect(await aids('scopeone scopetwo', { tenant_id: 'default', agent: 'agent-a' })).toEqual([mine.id])
    expect(await countArtifacts({ q: 'scopeone scopetwo', tenant_id: 'tenant-b' } as never)).toBe(1)
    expect((await aids('scopeone scopetwo', { tenant_id: 'default', kind: 'html' })).length).toBe(0)
  })

  it('AE1 empty and punctuation-only artifact query', async () => {
    await art('Any', 'text')
    expect(await aids('!!! ???')).toEqual([])
  })

  it('AP1 timing shape: a common two-word phrase over 20 artifacts of about 10 KB; the hit count is the artifact count', async () => {
    const body = 'common words appear here and there '.repeat(300)
    for (let i = 0; i < 20; i++) await art(`PerfA ${i}`, `${body} u${i}`)
    expect((await aids('common words')).length).toBe(20)
  })
})

// R4 (Boo, Rick): a word with no token (!!!, |, &, -, ~) is no word: it drops out, as on SQLite, on the short and the long
// rows, on the workspace list search and on the artifact search. A query of punctuation only finds nothing.
describe('R4 a word without a token drops out of the search, on both searches and both row sizes', () => {
  const cases: Array<[string, string]> = [
    ['puncword !!!', 'puncword here'],
    ['alpha | beta', 'alpha beta here'],
    ['alpha & beta', 'alpha beta here'],
    ['rank ~ check', 'rank check here'],
    ['Q3 - plan', 'Q3 plan here'],
  ]

  it.each(cases)('the workspace list search finds %s on a short and on a long row', async (q, text) => {
    const short = await doc({ title: 'R4 short', content: text })
    const long = await doc({ title: 'R4 long', content: `${filler(16400)}${text}` })
    expect(await page(q)).toEqual([short.id, long.id].sort())
  })

  it.each(cases)('the artifact search finds %s on a short and on a long body', async (q, text) => {
    const short = await art('R4 short', text)
    const long = await art('R4 long', `${filler(16400)}${text}`)
    expect(await aids(q)).toEqual([short.id, long.id].sort())
  })

  it('a query of punctuation only finds nothing (workspace list, workspace phrase, artifact)', async () => {
    await doc({ title: 'R4 any', content: 'plain words here' })
    await art('R4 any', 'plain words here')
    expect(await page('!!! | &')).toEqual([])
    expect(await phrase('!!! | &')).toEqual([])
    expect(await aids('!!! | &')).toEqual([])
  })
})

// L2 (Benjamin r8): the list search needs EVERY word. A row with one of two words is no hit, in either order, on a short and
// on a long row; the page and the count agree. The artifact search takes the whole text as one phrase, so the same row is
// no hit there either.
describe('L2 the list search needs every word: a row with one of two words is no hit, on both row sizes', () => {
  const total = async (q: string) => (await searchWorkspaceDocsPage(q, { tenantId: 'default', limit: 50 } as never)).total

  it('workspace list and count: the rows with one word only are no hit, the rows with both are', async () => {
    const onlyFirst = await doc({ title: 'L2 first short', content: 'l2word here' })
    const onlyFirstLong = await doc({ title: 'L2 first long', content: `${filler(16400)} l2word here` })
    const onlySecond = await doc({ title: 'L2 second short', content: 'l2miss here' })
    const onlySecondLong = await doc({ title: 'L2 second long', content: `${filler(16400)} l2miss here` })
    const bothShort = await doc({ title: 'L2 both short', content: 'l2word l2miss here' })
    const bothLong = await doc({ title: 'L2 both long', content: `${filler(16400)} l2word l2miss here` })
    const want = [bothShort.id, bothLong.id].sort()
    expect(await page('l2word l2miss')).toEqual(want)
    expect(await page('l2miss l2word')).toEqual(want)
    expect(await total('l2word l2miss')).toBe(2)
    expect(await total('l2miss l2word')).toBe(2)
    for (const id of [onlyFirst.id, onlyFirstLong.id, onlySecond.id, onlySecondLong.id]) {
      expect(want).not.toContain(id)
    }
  })

  it('artifact search: a body with one of two words is no hit, a body with both (short and long) is', async () => {
    const short = await art('L2 both short', 'l2word l2miss here')
    const long = await art('L2 both long', `${filler(16400)} l2word l2miss here`)
    await art('L2 first only', 'l2word here')
    await art('L2 second only long', `${filler(16400)} l2miss here`)
    expect(await aids('l2word l2miss')).toEqual([short.id, long.id].sort())
    expect(await countArtifacts({ q: 'l2word l2miss' })).toBe(2)
  })
})

// L2b (Rick, 21060): a hyphenated word of the list search is a phrase (its parts adjacent), not two independent words. The
// candidate (every lexeme ANDed) cannot tell the two apart, so the per-word check is the one that must. Rows with the parts
// apart are no hit; the controls with the parts adjacent are.
describe('L2b a hyphenated word is a phrase in the list search, on both row sizes, list and count', () => {
  const total = async (q: string) => (await searchWorkspaceDocsPage(q, { tenantId: 'default', limit: 50 } as never)).total

  it('alpha-beta gamma: the apart row is no hit, the adjacent control is (list and count)', async () => {
    const apart = await doc({ title: 'L2b apart short', content: 'alpha x beta gamma' })
    const apartLong = await doc({ title: 'L2b apart long', content: `${filler(16400)} alpha x beta gamma` })
    const adj = await doc({ title: 'L2b adjacent short', content: 'alpha beta gamma' })
    const adjLong = await doc({ title: 'L2b adjacent long', content: `${filler(16400)} alpha beta gamma` })
    const want = [adj.id, adjLong.id].sort()
    expect(await page('alpha-beta gamma')).toEqual(want)
    expect(await total('alpha-beta gamma')).toBe(2)
    expect(want).not.toContain(apart.id)
    expect(want).not.toContain(apartLong.id)
  })

  it('alpha-beta !!!: the apart row is no hit, the adjacent control is (list and count)', async () => {
    const apart = await doc({ title: 'L2b punct apart short', content: 'alpha x beta' })
    const apartLong = await doc({ title: 'L2b punct apart long', content: `${filler(16400)} alpha x beta` })
    const adj = await doc({ title: 'L2b punct adjacent short', content: 'alpha beta' })
    const adjLong = await doc({ title: 'L2b punct adjacent long', content: `${filler(16400)} alpha beta` })
    const want = [adj.id, adjLong.id].sort()
    expect(await page('alpha-beta !!!')).toEqual(want)
    expect(await total('alpha-beta !!!')).toBe(2)
    expect(want).not.toContain(apart.id)
    expect(want).not.toContain(apartLong.id)
  })
})
