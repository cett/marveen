import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// updateSystemConfig / setSystemConfigMany (db/system-config.ts): the read-modify-write that cannot lose an
// update, and the multi-key write that lands as one unit. A fresh module instance (and a fresh :memory:
// database) per test, like db-system-config.test.ts.
let dbMod: typeof import('../db.js')
let conn: typeof import('../db/connection.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'system-config-update-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  conn = await import('../db/connection.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

const append = (item: string) => (current: string | undefined): string =>
  JSON.stringify([...(current === undefined ? [] : (JSON.parse(current) as string[])), item])

function dbValue(key: string): string | undefined {
  return (conn.db.prepare('SELECT value FROM system_config WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

describe('updateSystemConfig', () => {
  it('two overlapping read-modify-writes both land (the second sees what the first wrote)', async () => {
    const { updateSystemConfig, getSystemConfig } = dbMod
    await Promise.all([updateSystemConfig('rmw', append('a')), updateSystemConfig('rmw', append('b'))])
    const stored = JSON.parse(dbValue('rmw')!) as string[]
    expect([...stored].sort()).toEqual(['a', 'b'])
    // ...and the cache a synchronous reader sees is the committed row, not the first writer's view.
    expect(JSON.parse(getSystemConfig('rmw')!.value)).toEqual(stored)
  })

  it('many overlapping calls on a key that does not exist yet lose none', async () => {
    const { updateSystemConfig } = dbMod
    const items = ['a', 'b', 'c', 'd', 'e', 'f']
    await Promise.all(items.map((i) => updateSystemConfig('rmw_many', append(i))))
    expect((JSON.parse(dbValue('rmw_many')!) as string[]).sort()).toEqual(items)
  })

  it('reads the DATABASE, not the cache: a row written behind the cache is what mutate gets', async () => {
    const { updateSystemConfig, getSystemConfig } = dbMod
    await dbMod.setSystemConfig('behind', '["seed"]')
    // A write the cache does not know about (another path wrote the table directly).
    conn.db.prepare("UPDATE system_config SET value = '[\"seed\",\"direct\"]' WHERE key = 'behind'").run()
    expect(JSON.parse(getSystemConfig('behind')!.value)).toEqual(['seed'])
    await updateSystemConfig('behind', append('next'))
    expect(JSON.parse(dbValue('behind')!)).toEqual(['seed', 'direct', 'next'])
  })

  it('mutate gets undefined for an absent key', async () => {
    const seen: Array<string | undefined> = []
    await dbMod.updateSystemConfig('absent', (cur) => { seen.push(cur); return 'x' })
    expect(seen).toEqual([undefined])
    expect(dbValue('absent')).toBe('x')
  })

  it('resolves true when it wrote', async () => {
    expect(await dbMod.updateSystemConfig('w', () => 'v')).toBe(true)
  })

  it('returning undefined leaves the row alone: no write, no updated_at bump, resolves false', async () => {
    const { updateSystemConfig } = dbMod
    await dbMod.setSystemConfig('keep', 'orig')
    conn.db.prepare("UPDATE system_config SET updated_at = 1000 WHERE key = 'keep'").run()
    dbMod.reloadSystemConfigCache()
    expect(await updateSystemConfig('keep', () => undefined)).toBe(false)
    expect(conn.db.prepare("SELECT value, updated_at FROM system_config WHERE key = 'keep'").get()).toEqual({ value: 'orig', updated_at: 1000 })
    expect(await updateSystemConfig('never_written', () => undefined)).toBe(false)
    expect(dbValue('never_written')).toBeUndefined()
  })

  it('the cache follows the commit: mutate still sees the old cached row, the resolved call the new one', async () => {
    const { updateSystemConfig, getSystemConfig } = dbMod
    await dbMod.setSystemConfig('seq', 'old')
    let cachedDuringMutate: string | undefined
    const done = updateSystemConfig('seq', () => {
      cachedDuringMutate = getSystemConfig('seq')?.value
      return 'new'
    })
    await done
    expect(cachedDuringMutate).toBe('old')
    expect(getSystemConfig('seq')?.value).toBe('new')
  })

  it('a mutate that throws rejects, writes nothing, leaves the cache alone and does not wedge the lock', async () => {
    const { updateSystemConfig, getSystemConfig } = dbMod
    await dbMod.setSystemConfig('boom', 'orig')
    await expect(updateSystemConfig('boom', () => { throw new Error('mutate failed') })).rejects.toThrow('mutate failed')
    expect(dbValue('boom')).toBe('orig')
    expect(getSystemConfig('boom')?.value).toBe('orig')
    expect(conn.db.inTransaction).toBe(false)
    // the next writer still gets the lock
    await expect(updateSystemConfig('boom', () => 'after')).resolves.toBe(true)
    expect(dbValue('boom')).toBe('after')
  })

  it('a failing write inside the transaction rolls the whole call back (NOT NULL violation)', async () => {
    const { updateSystemConfig, getSystemConfig } = dbMod
    await dbMod.setSystemConfig('nn', 'orig')
    await expect(updateSystemConfig('nn', () => null as unknown as string)).rejects.toThrow()
    expect(dbValue('nn')).toBe('orig')
    expect(getSystemConfig('nn')?.value).toBe('orig')
    expect(conn.db.inTransaction).toBe(false)
  })

  it('takes the write lock up front (BEGIN IMMEDIATE), not a deferred transaction', async () => {
    const exec = vi.spyOn(conn.db, 'exec')
    await dbMod.updateSystemConfig('imm', () => 'v')
    const begins = exec.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('BEGIN'))
    expect(begins).toEqual(['BEGIN IMMEDIATE'])
  })

  it('the source is recorded (default db, or the one given)', async () => {
    await dbMod.updateSystemConfig('src_default', () => 'v')
    await dbMod.updateSystemConfig('src_given', () => 'v', 'import')
    expect(dbMod.getSystemConfig('src_default')?.source).toBe('db')
    expect(dbMod.getSystemConfig('src_given')?.source).toBe('import')
  })
})

describe('setSystemConfigMany', () => {
  it('writes every key, and the cache shows all of them as soon as the call resolves', async () => {
    const { setSystemConfigMany, getSystemConfig } = dbMod
    await setSystemConfigMany([['m1', 'one'], ['m2', 'two'], ['m3', 'three']], 'import')
    for (const [k, v] of [['m1', 'one'], ['m2', 'two'], ['m3', 'three']]) {
      expect(dbValue(k!)).toBe(v)
      expect(getSystemConfig(k!)).toMatchObject({ value: v, source: 'import' })
    }
  })

  it('all or nothing: one failing entry rolls back the others (database and cache)', async () => {
    const { setSystemConfigMany, getSystemConfig } = dbMod
    await dbMod.setSystemConfig('m1', 'before')
    await expect(setSystemConfigMany([['m1', 'changed'], ['m2', 'new'], ['m3', null as unknown as string]])).rejects.toThrow()
    expect(dbValue('m1')).toBe('before')
    expect(dbValue('m2')).toBeUndefined()
    expect(getSystemConfig('m1')?.value).toBe('before')
    expect(getSystemConfig('m2')).toBeUndefined()
    expect(conn.db.inTransaction).toBe(false)
  })

  it('an empty list opens no transaction and writes nothing', async () => {
    const exec = vi.spyOn(conn.db, 'exec')
    await dbMod.setSystemConfigMany([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('is one transaction (BEGIN IMMEDIATE ... COMMIT) for the whole group', async () => {
    const exec = vi.spyOn(conn.db, 'exec')
    await dbMod.setSystemConfigMany([['t1', 'a'], ['t2', 'b']])
    expect(exec.mock.calls.map((c) => String(c[0]))).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
  })

  it('overlapping groups and read-modify-writes do not lose each other', async () => {
    const { setSystemConfigMany, updateSystemConfig } = dbMod
    await Promise.all([
      setSystemConfigMany([['g1', 'a'], ['g2', 'b']]),
      updateSystemConfig('g3', append('x')),
      setSystemConfigMany([['g4', 'c']]),
      updateSystemConfig('g3', append('y')),
    ])
    expect([dbValue('g1'), dbValue('g2'), dbValue('g4')]).toEqual(['a', 'b', 'c'])
    expect((JSON.parse(dbValue('g3')!) as string[]).sort()).toEqual(['x', 'y'])
  })
})

describe('setSystemConfigSync (the boot twin)', () => {
  it('writes the row and the cache, like setSystemConfig', () => {
    dbMod.setSystemConfigSync('boot', 'v', 'boot')
    expect(dbValue('boot')).toBe('v')
    expect(dbMod.getSystemConfig('boot')).toMatchObject({ value: 'v', source: 'boot' })
  })
})
