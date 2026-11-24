// The SQLite snapshot of the copy tool (P-G1, src/db/pg-copy/sqlite-source.ts): the copy reads a private copy taken with
// the backup API, never the live file, and the copy is removed when the snapshot is closed. Plain SQLite, no PostgreSQL.
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { integrityProblems, openSnapshot } from '../db/pg-copy/sqlite-source.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A small live database with one row, in its own directory. */
function liveDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-snap-'))
  dirs.push(dir)
  const file = join(dir, 'live.db')
  const db = new Database(file)
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
  db.exec("INSERT INTO notes (body) VALUES ('first')")
  db.close()
  return file
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('snapshot: the copy reads a private copy, never the live file', () => {
  it('the connection reads a file inside the snapshot directory, the live file is unchanged, and a later write to the live file does not reach the snapshot', async () => {
    const live = liveDatabase()
    const before = sha256(live)
    const snap = await openSnapshot(live)
    try {
      expect(snap.db.name).not.toBe(live)
      expect(snap.db.name.startsWith(`${snap.dir}/`)).toBe(true)
      expect(sha256(live)).toBe(before)

      const writer = new Database(live)
      writer.exec("INSERT INTO notes (body) VALUES ('second')")
      writer.close()

      const row = snap.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: bigint | number }
      expect(Number(row.n)).toBe(1)
    } finally {
      snap.close()
    }
  })
})

describe('snapshot: the directory is private while open and gone after close', () => {
  it('the directory holding the copy is mode 0700 while open, and close() removes the directory with the copy in it', async () => {
    const snap = await openSnapshot(liveDatabase())
    const dir = snap.dir
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(existsSync(join(dir, 'snapshot.db'))).toBe(true)
    snap.close()
    expect(existsSync(dir)).toBe(false)
  })
})

describe('snapshot: read-only, and nothing left behind on a failed open', () => {
  it('a write through the snapshot connection throws: the snapshot is opened read-only', async () => {
    const snap = await openSnapshot(liveDatabase())
    try {
      expect(() => snap.db.exec('CREATE TABLE zz_write (a INTEGER)')).toThrow()
    } finally {
      snap.close()
    }
  })

  it('a live file with mode 0444 still opens, is only read, and keeps its bytes', async () => {
    const live = liveDatabase()
    const before = sha256(live)
    chmodSync(live, 0o444)
    try {
      const snap = await openSnapshot(live)
      try {
        const row = snap.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: bigint | number }
        expect(Number(row.n)).toBe(1)
      } finally {
        snap.close()
      }
    } finally {
      chmodSync(live, 0o644)
    }
    expect(sha256(live)).toBe(before)
  })

  it('a live path that does not exist is refused, and no marveen-pg-copy-* directory is left in the temp directory', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'pgcopy-tmp-'))
    dirs.push(isolated)
    const saved = process.env.TMPDIR
    // os.tmpdir() reads TMPDIR on each call: the snapshot directory of this open is created inside the isolated directory
    process.env.TMPDIR = isolated
    try {
      await expect(openSnapshot(join(isolated, 'missing.db'))).rejects.toThrow()
      expect(readdirSync(isolated).filter((n) => n.startsWith('marveen-pg-copy-'))).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
  })
})

describe('live file: the copy never writes it, not even to recover it', () => {
  it('a live file with a hot journal (a crash mid-transaction) is refused and left as it was: no rollback into the live file, the journal stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-hot-'))
    dirs.push(dir)
    const live = join(dir, 'live.db')
    const setup = new Database(live)
    setup.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)')
    setup.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 3000) INSERT INTO big (body) SELECT printf('%0200d', i) FROM c")
    setup.close()

    // a transaction whose dirty pages have spilled into the file: the originals are in the journal, the transaction never ends
    const writer = new Database(live)
    writer.pragma('cache_size = 2')
    writer.exec('BEGIN')
    writer.exec("UPDATE big SET body = printf('%0200d', id * 7)")
    const crash = mkdtempSync(join(tmpdir(), 'pgcopy-crash-'))
    dirs.push(crash)
    const crashLive = join(crash, 'live.db')
    expect(existsSync(`${live}-journal`)).toBe(true)
    copyFileSync(live, crashLive)
    copyFileSync(`${live}-journal`, `${crashLive}-journal`)
    writer.exec('ROLLBACK')
    writer.close()

    const bytes = sha256(crashLive)
    const journal = sha256(`${crashLive}-journal`)
    await expect(openSnapshot(crashLive)).rejects.toThrow()
    expect(sha256(crashLive)).toBe(bytes)
    expect(sha256(`${crashLive}-journal`)).toBe(journal)
  })
})

describe('integrity: an index entry that no longer matches its table is a problem, which quick_check does not look for', () => {
  it('integrityProblems reports it; PRAGMA quick_check on the same file says ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-integ-'))
    dirs.push(dir)
    const file = join(dir, 'idx.db')
    const db = new Database(file)
    db.unsafeMode(true)
    db.exec('CREATE TABLE t (a INTEGER, b INTEGER)')
    db.exec('CREATE INDEX t_a ON t (a)')
    db.exec('INSERT INTO t (a, b) VALUES (1, 10), (2, 20), (3, 30)')
    // the index now claims column b, while its entries still hold the values of a: the index is out of step with the rows
    db.pragma('writable_schema = ON')
    db.exec("UPDATE sqlite_master SET sql = 'CREATE INDEX t_a ON t (b)' WHERE name = 't_a'")
    db.pragma('writable_schema = OFF')
    db.close()

    const ro = new Database(file, { readonly: true, fileMustExist: true })
    try {
      expect(ro.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
      expect(integrityProblems(ro).length).toBeGreaterThan(0)
    } finally {
      ro.close()
    }
  })
})
