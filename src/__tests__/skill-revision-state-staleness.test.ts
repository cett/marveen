// Staleness of a pending skill revision covers the WHOLE live state (text, description, companion files), not only the
// SKILL.md text. A proposal records prev_state_sha256 when it is built; activation recomputes the same hash from the live
// tables. Real in-memory SQLite throughout; only on-disk regeneration is out of scope (nothing here touches the disk).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, db, createSkill, updateSkill, getSkill, getSkillFile, putSkillFile, deleteSkillFile,
  decideSkillRevision, listPendingRevisions, listSkillRevisions, hashSkillState, sha256Hex, hashFileSet,
} from '../db.js'

beforeEach(() => { initDatabase(':memory:') })

const SYSTEM = { kind: 'system' as const, id: null }
const REVIEWER = { kind: 'human' as const, id: 'reviewer' }
const PLAIN = '---\nname: x\ndescription: d\n---\nbody\n'
const PRIVILEGED = '---\nname: x\ndescription: d\nallowed-tools: Bash\n---\nbody\n'

/** A live skill with a description that differs from its frontmatter's, so a description-only edit is observable. */
async function liveSkill(id: string): Promise<void> {
  const r = await createSkill({ id, name: id, description: 'original description', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
  if (r.outcome !== 'created') throw new Error('fixture did not create a live skill')
}

/** A modify proposal (a privileged text change goes through the gate and is queued, the live row untouched). */
async function proposeModify(id: string): Promise<number> {
  const r = await updateSkill(id, { content: PRIVILEGED }, SYSTEM, {}, { gatePrivilege: true })
  if (r.outcome !== 'pending') throw new Error('fixture did not queue a pending modify')
  return r.revision.id
}

const activatedCount = async (id: string): Promise<number> => (await listSkillRevisions(id)).length

describe('prev_state_sha256: what a proposal records', () => {
  it('a modify proposal records the hash of the live text, description and file set at proposal time', async () => {
    await liveSkill('agent/a/rec')
    await putSkillFile('agent/a/rec', 'references/a.txt', Buffer.from('doc'), 0o644, SYSTEM)
    const id = await proposeModify('agent/a/rec')
    const row = db.prepare('SELECT prev_state_sha256 FROM skill_revisions WHERE id = ?').get(id) as { prev_state_sha256: string | null }
    expect(row.prev_state_sha256).toBe(hashSkillState(PLAIN, 'original description', [{ rel_path: 'references/a.txt', mode: 0o644, content: Buffer.from('doc') }]))
  })

  it('a create proposal records it too: no new row has a NULL', async () => {
    const r = await createSkill({ id: 'agent/a/new', name: 'n', description: 'desc', content: PRIVILEGED, tenant_id: 'fleet' }, SYSTEM, {}, { gatePrivilege: true })
    if (r.outcome !== 'pending') throw new Error('expected pending')
    const row = db.prepare('SELECT prev_state_sha256 FROM skill_revisions WHERE id = ?').get(r.revision.id) as { prev_state_sha256: string | null }
    expect(row.prev_state_sha256).toBe(hashSkillState(PRIVILEGED, 'desc', []))
  })
})

describe('hashSkillState', () => {
  const f = (rel_path: string, mode: number, body: string) => ({ rel_path, mode, content: Buffer.from(body) })

  it('changes when the text, the description, a file path, a file mode or a file byte changes', () => {
    const base = hashSkillState('text', 'desc', [f('a.txt', 0o644, 'x')])
    expect(hashSkillState('text2', 'desc', [f('a.txt', 0o644, 'x')])).not.toBe(base)
    expect(hashSkillState('text', 'desc2', [f('a.txt', 0o644, 'x')])).not.toBe(base)
    expect(hashSkillState('text', 'desc', [f('b.txt', 0o644, 'x')])).not.toBe(base)
    expect(hashSkillState('text', 'desc', [f('a.txt', 0o755, 'x')])).not.toBe(base)
    expect(hashSkillState('text', 'desc', [f('a.txt', 0o644, 'y')])).not.toBe(base)
    expect(hashSkillState('text', 'desc', [])).not.toBe(base)
  })

  it('does not depend on the order the file rows come back in', () => {
    const one = hashSkillState('t', 'd', [f('a', 0o644, '1'), f('b', 0o644, '2')])
    expect(hashSkillState('t', 'd', [f('b', 0o644, '2'), f('a', 0o644, '1')])).toBe(one)
  })

  it('is the documented composition: text hash, NUL, description, NUL, file-set hash (empty for no files)', () => {
    expect(hashSkillState('t', 'd', [])).toBe(sha256Hex(`${sha256Hex('t')}\0d\0`))
    const files = [f('a', 0o644, '1')]
    expect(hashSkillState('t', 'd', files)).toBe(sha256Hex(`${sha256Hex('t')}\0d\0${hashFileSet(files)}`))
  })
})

describe('activate refuses a proposal whose live state moved (stale_proposal)', () => {
  it('a description-only direct write after the proposal: refused, the direct write survives', async () => {
    await liveSkill('agent/a/desc')
    const id = await proposeModify('agent/a/desc')
    const before = await activatedCount('agent/a/desc')
    expect((await updateSkill('agent/a/desc', { description: 'edited directly' }, SYSTEM, {})).outcome).toBe('updated')
    // the premise of the whole item: this edit writes NO revision, so the trail cannot see it
    expect(await activatedCount('agent/a/desc')).toBe(before)

    expect(await decideSkillRevision(id, 'activate', REVIEWER)).toEqual({ outcome: 'stale_proposal' })
    const skill = await getSkill('agent/a/desc')
    expect(skill?.description).toBe('edited directly')
    expect(skill?.content).toBe(PLAIN)
    expect(await listPendingRevisions('agent/a/desc')).toHaveLength(1)
  })

  it('a companion file put after the proposal: refused, the file survives', async () => {
    await liveSkill('agent/a/put')
    const id = await proposeModify('agent/a/put')
    expect((await putSkillFile('agent/a/put', 'references/late.txt', Buffer.from('late'), 0o644, SYSTEM)).outcome).not.toBe('pending')

    expect(await decideSkillRevision(id, 'activate', REVIEWER)).toEqual({ outcome: 'stale_proposal' })
    expect((await getSkillFile('agent/a/put', 'references/late.txt'))?.content.toString()).toBe('late')
    expect((await getSkill('agent/a/put'))?.content).toBe(PLAIN)
    expect(await listPendingRevisions('agent/a/put')).toHaveLength(1)
  })

  it('a companion file delete after the proposal: refused, the file stays deleted and the text is untouched', async () => {
    await liveSkill('agent/a/del')
    await putSkillFile('agent/a/del', 'references/gone.txt', Buffer.from('x'), 0o644, SYSTEM)
    const id = await proposeModify('agent/a/del')
    expect(await deleteSkillFile('agent/a/del', 'references/gone.txt', SYSTEM)).toBe(true)

    expect(await decideSkillRevision(id, 'activate', REVIEWER)).toEqual({ outcome: 'stale_proposal' })
    expect(await getSkillFile('agent/a/del', 'references/gone.txt')).toBeUndefined()
    expect((await getSkill('agent/a/del'))?.content).toBe(PLAIN)
  })

  it('a file whose mode changed after the proposal counts too', async () => {
    await liveSkill('agent/a/mode')
    await putSkillFile('agent/a/mode', 'references/m.txt', Buffer.from('x'), 0o644, SYSTEM)
    const id = await proposeModify('agent/a/mode')
    // the stored mode is 0o644 or 0o755 only (sanitizeSkillFileMode), so an executable bit is the mode change
    await putSkillFile('agent/a/mode', 'references/m.txt', Buffer.from('x'), 0o755, SYSTEM)
    expect(await decideSkillRevision(id, 'activate', REVIEWER)).toEqual({ outcome: 'stale_proposal' })
  })

  it('a newer text landed first (the case that was already covered) is still refused', async () => {
    await liveSkill('agent/a/text')
    const first = await proposeModify('agent/a/text')
    expect((await updateSkill('agent/a/text', { content: PLAIN.replace('body', 'body v2') }, SYSTEM, {})).outcome).toBe('updated')
    expect(await decideSkillRevision(first, 'activate', REVIEWER)).toEqual({ outcome: 'stale_proposal' })
    expect((await getSkill('agent/a/text'))?.content).toBe(PLAIN.replace('body', 'body v2'))
  })
})

describe('activate goes through when the live state did not move', () => {
  it('unchanged text, description and files: activated, the proposal carries the current file set over', async () => {
    await liveSkill('agent/a/ok')
    await putSkillFile('agent/a/ok', 'references/keep.txt', Buffer.from('keep'), 0o644, SYSTEM)
    const id = await proposeModify('agent/a/ok')
    expect((await decideSkillRevision(id, 'activate', REVIEWER)).outcome).toBe('activated')
    const skill = await getSkill('agent/a/ok')
    expect(skill).toMatchObject({ status: 'live', content: PRIVILEGED })
    expect((await getSkillFile('agent/a/ok', 'references/keep.txt'))?.content.toString()).toBe('keep')
  })

  it('a direct description edit made BEFORE the proposal is part of the state it was built on: activated', async () => {
    await liveSkill('agent/a/before')
    expect((await updateSkill('agent/a/before', { description: 'edited first' }, SYSTEM, {})).outcome).toBe('updated')
    const id = await proposeModify('agent/a/before')
    expect((await decideSkillRevision(id, 'activate', REVIEWER)).outcome).toBe('activated')
  })

  it('a pending create (nothing to compare) activates', async () => {
    const r = await createSkill({ id: 'agent/a/c', name: 'c', content: PRIVILEGED, tenant_id: 'fleet' }, SYSTEM, {}, { gatePrivilege: true })
    if (r.outcome !== 'pending') throw new Error('expected pending')
    expect((await decideSkillRevision(r.revision.id, 'activate', REVIEWER)).outcome).toBe('activated')
  })
})

describe('a pending row without prev_state_sha256 keeps the old text-only comparison', () => {
  // The shape a pending dashboard import had before migration 0095: no state hash, prev_sha256 = the text it replaces.
  function legacyPending(id: string): number {
    return db.prepare(`
      INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, content, prev_sha256, files_sha256, author_kind, status)
      VALUES (?, 'fleet', (SELECT COALESCE(MAX(seq), 0) + 1 FROM skill_revisions WHERE skill_id = ?), 'modify', ?, ?, NULL, 'human', 'pending')
    `).run(id, id, PRIVILEGED, sha256Hex(PLAIN)).lastInsertRowid as number
  }

  it('text unchanged: activated', async () => {
    await liveSkill('agent/a/legacy-ok')
    const id = legacyPending('agent/a/legacy-ok')
    expect((db.prepare('SELECT prev_state_sha256 AS p FROM skill_revisions WHERE id = ?').get(id) as { p: string | null }).p).toBeNull()
    expect((await decideSkillRevision(id, 'activate', REVIEWER)).outcome).toBe('activated')
  })

  it('a newer text landed first: stale_proposal', async () => {
    await liveSkill('agent/a/legacy-stale')
    const id = legacyPending('agent/a/legacy-stale')
    expect((await updateSkill('agent/a/legacy-stale', { content: PLAIN.replace('body', 'body v2') }, SYSTEM, {})).outcome).toBe('updated')
    expect(await decideSkillRevision(id, 'activate', REVIEWER)).toEqual({ outcome: 'stale_proposal' })
  })

  it('a description-only edit is NOT stale for such a row: it is not stranded, and says so', async () => {
    await liveSkill('agent/a/legacy-desc')
    const id = legacyPending('agent/a/legacy-desc')
    expect((await updateSkill('agent/a/legacy-desc', { description: 'edited directly' }, SYSTEM, {})).outcome).toBe('updated')
    expect((await decideSkillRevision(id, 'activate', REVIEWER)).outcome).toBe('activated')
  })
})
