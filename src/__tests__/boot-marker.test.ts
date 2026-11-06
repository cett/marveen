import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// The boot marker (boot-marker.ts): last_boot / clean_shutdown decide whether the previous process stopped cleanly.
// Real database (fresh :memory: per test); a "restart" is a fresh module instance over the SAME database.

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

type Mods = {
  db: typeof import('../db.js')
  conn: typeof import('../db/connection.js')
  marker: typeof import('../web/boot-marker.js')
  flush: typeof import('../web/sigterm-flush.js')
}

let m: Mods
let storeDir: string

async function load(): Promise<Mods> {
  vi.resetModules()
  return {
    db: await import('../db.js'),
    conn: await import('../db/connection.js'),
    marker: await import('../web/boot-marker.js'),
    flush: await import('../web/sigterm-flush.js'),
  }
}

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'boot-marker-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  m = await load()
  m.db.initDatabase(':memory:')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function value(key: string): Record<string, unknown> | undefined {
  const row = m.conn.db.prepare('SELECT value FROM system_config WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : undefined
}

/** A process restart over the same database: the module state (the registered flushes) is new, the rows are not. */
async function restartProcess(): Promise<void> {
  const rows = m.conn.db.prepare('SELECT key, value FROM system_config WHERE key IN (?, ?)').all('last_boot', 'clean_shutdown') as Array<{ key: string; value: string }>
  m = await load()
  m.db.initDatabase(':memory:')
  for (const r of rows) await m.db.setSystemConfig(r.key, r.value)
}

describe('decidePrevShutdown (pure)', () => {
  const id = (b: string): string => JSON.stringify({ boot_id: b })
  it.each([
    ['no previous boot, no marker', undefined, undefined, 'unknown'],
    ['no previous boot, a marker from some boot', undefined, id('x'), 'unknown'],
    ['previous boot, no marker', id('a'), undefined, 'unclean'],
    ['previous boot, marker of the same boot', id('a'), id('a'), 'clean'],
    ['previous boot, marker of another boot', id('a'), id('b'), 'unclean'],
    ['previous boot value is not JSON', '{nope', id('a'), 'unknown'],
    ['previous boot value has no boot_id', '{}', id('a'), 'unknown'],
    ['previous boot value has an empty boot_id', id(''), id(''), 'unknown'],
    ['marker value is not JSON', id('a'), '{nope', 'unclean'],
    ['marker value is an array', id('a'), '[]', 'unclean'],
  ] as const)('%s -> %s', (_label, last, clean, expected) => {
    expect(m.marker.decidePrevShutdown(last, clean)).toBe(expected)
  })
})

describe('recordBoot', () => {
  it('the first boot is unknown and stores boot_id, started_at and prev_shutdown', async () => {
    const rec = await m.marker.recordBoot(1_800_000_000_000)
    expect(rec.prev_shutdown).toBe('unknown')
    expect(rec.started_at).toBe(1_800_000_000_000)
    expect(rec.boot_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(value('last_boot')).toEqual({ boot_id: rec.boot_id, started_at: 1_800_000_000_000, prev_shutdown: 'unknown' })
    expect(value('clean_shutdown')).toBeUndefined()
  })

  it('a boot after the SIGTERM flush ran is clean', async () => {
    const first = await m.marker.startBootMarker()
    await m.flush.runSigtermFlushes(1000)
    await restartProcess()
    const second = await m.marker.recordBoot()
    expect(second.prev_shutdown).toBe('clean')
    expect(second.boot_id).not.toBe(first!.boot_id)
  })

  it('a boot without the marker (SIGKILL, crash, SIGINT) is unclean', async () => {
    await m.marker.startBootMarker() // registered, but the flush never ran
    await restartProcess()
    expect((await m.marker.recordBoot()).prev_shutdown).toBe('unclean')
  })

  it('a marker stamped by another boot does not make this boot clean', async () => {
    await m.marker.recordBoot()
    await m.db.setSystemConfig('clean_shutdown', JSON.stringify({ boot_id: 'some-other-boot', at: 1 }))
    await restartProcess()
    expect((await m.marker.recordBoot()).prev_shutdown).toBe('unclean')
  })

  it('two boots in a row on one marker: the first is clean, the second is not', async () => {
    await m.marker.startBootMarker()
    await m.flush.runSigtermFlushes(1000) // boot 1 stops cleanly
    await restartProcess()
    const boot2 = await m.marker.startBootMarker() // reads clean; registers its own marker but is then killed
    expect(boot2!.prev_shutdown).toBe('clean')
    await restartProcess()
    const boot3 = await m.marker.recordBoot()
    expect(boot3.prev_shutdown).toBe('unclean') // the marker on disk still belongs to boot 1
  })

  it('does not delete or rewrite the marker', async () => {
    await m.marker.startBootMarker()
    await m.flush.runSigtermFlushes(1000)
    const marker = value('clean_shutdown')
    await restartProcess()
    await m.marker.recordBoot()
    expect(value('clean_shutdown')).toEqual(marker)
  })

  it('logs the boot and writes one audit row (agent scheduler, entity boot)', async () => {
    const { logger } = await import('../logger.js')
    const rec = await m.marker.recordBoot()
    expect(logger.info).toHaveBeenCalledWith({ boot_id: rec.boot_id, prev_shutdown: 'unknown' }, 'boot recorded')
    const rows = m.conn.db.prepare("SELECT agent_id, entity, action, entity_id, detail FROM agent_audit_log WHERE entity = 'boot'").all() as Array<Record<string, string>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'scheduler', entity: 'boot', action: 'boot', entity_id: rec.boot_id })
    expect(JSON.parse(rows[0]!['detail']!)).toEqual({ boot_id: rec.boot_id, prev_shutdown: 'unknown' })
  })

  it('each boot gets a new boot_id', async () => {
    const a = await m.marker.recordBoot()
    const b = await m.marker.recordBoot()
    expect(a.boot_id).not.toBe(b.boot_id)
  })
})

describe('the shutdown-marker flush', () => {
  it('writes clean_shutdown with this boot_id, in one row', async () => {
    const rec = await m.marker.startBootMarker()
    await m.flush.runSigtermFlushes(1000)
    const marker = value('clean_shutdown')!
    expect(marker['boot_id']).toBe(rec!.boot_id)
    expect(typeof marker['at']).toBe('number')
  })

  it('runs first: before a flush registered after it, and a failing later flush does not stop it', async () => {
    const order: string[] = []
    await m.marker.startBootMarker()
    m.flush.registerSigtermFlush('later-throws', () => { order.push('later-throws'); return Promise.reject(new Error('boom')) })
    m.flush.registerSigtermFlush('later-ok', () => { order.push('later-ok'); return Promise.resolve() })
    const seen: string[] = []
    // Observe the marker's position by checking the row exists when the first later flush starts.
    m.flush.registerSigtermFlush('observer', () => { seen.push(value('clean_shutdown') ? 'marker-written' : 'marker-missing'); return Promise.resolve() })
    await m.flush.runSigtermFlushes(1000)
    expect(order).toEqual(['later-throws', 'later-ok'])
    expect(seen).toEqual(['marker-written'])
  })

  it('a flush registered BEFORE the marker would run before it (so the order is the registration order)', async () => {
    const seen: string[] = []
    m.flush.registerSigtermFlush('early', () => { seen.push(value('clean_shutdown') ? 'marker-written' : 'marker-missing'); return Promise.resolve() })
    await m.marker.startBootMarker()
    await m.flush.runSigtermFlushes(1000)
    expect(seen).toEqual(['marker-missing'])
  })

  it('src/index.ts records the boot (and so registers the marker) before it starts the web server', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8')
    const marker = src.indexOf('await startBootMarker()')
    const web = src.indexOf('startWebServer(WEB_PORT)')
    expect(marker).toBeGreaterThan(-1)
    expect(web).toBeGreaterThan(-1)
    expect(marker).toBeLessThan(web)
  })

  it('src/index.ts still flushes only on SIGTERM (a SIGINT leaves no marker: unclean is the correct reading)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8')
    expect(src).toContain("if (signal === 'SIGTERM') {")
  })
})

describe('startBootMarker never throws', () => {
  it('a database that cannot be written gives null and registers no marker', async () => {
    m.conn.db.close()
    await expect(m.marker.startBootMarker()).resolves.toBeNull()
    await m.flush.runSigtermFlushes(1000) // nothing registered, nothing to run
  })
})

describe('readLastBoot', () => {
  it('returns the stored record', async () => {
    const rec = await m.marker.recordBoot()
    expect(m.marker.readLastBoot()).toEqual(rec)
  })
  it('is null before any boot', () => {
    expect(m.marker.readLastBoot()).toBeNull()
  })
  it.each([
    ['not JSON', '{nope'],
    ['an unknown prev_shutdown', JSON.stringify({ boot_id: 'x', started_at: 1, prev_shutdown: 'maybe' })],
    ['a non-numeric started_at', JSON.stringify({ boot_id: 'x', started_at: 'now', prev_shutdown: 'clean' })],
    ['an empty boot_id', JSON.stringify({ boot_id: '', started_at: 1, prev_shutdown: 'clean' })],
  ])('is null for %s', async (_label, raw) => {
    await m.db.setSystemConfig('last_boot', raw)
    expect(m.marker.readLastBoot()).toBeNull()
  })
})
