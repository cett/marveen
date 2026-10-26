// `npm run dashboard-user -- add | reset-password | remove` against an isolated store. The commands call async
// db functions; a call left without its await still exits 0 but changes nothing (or changes it after the process
// has moved on), so the test reads the database file the CLI wrote.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { verifyPassword } from '../../src/web/password-hash.js'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PASSWORD = 'a-long-test-password-1'
const NEW_PASSWORD = 'another-long-password-2'

describe('the CLI add / reset-password / remove commands', () => {
  let storeDir: string

  beforeEach(() => { storeDir = mkdtempSync(join(tmpdir(), 'du-life-')) })
  afterEach(() => { rmSync(storeDir, { recursive: true, force: true }) })

  function cli(args: string[], stdin?: string) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(TSX, ['scripts/dashboard-user.ts', ...args], {
        cwd: ROOT, env: { ...process.env, MARVEEN_STORE_DIR: storeDir },
      })
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', (d) => { stdout += d })
      p.stderr.on('data', (d) => { stderr += d })
      p.on('close', (status) => resolve({ status, stdout, stderr }))
      if (stdin !== undefined) p.stdin.write(stdin)
      p.stdin.end()
    })
  }

  function rows(): { username: string; role: string; password_hash: string }[] {
    const db = new Database(join(storeDir, 'claudeclaw.db'), { readonly: true })
    try {
      return db.prepare('SELECT username, role, password_hash FROM dashboard_users ORDER BY id').all() as { username: string; role: string; password_hash: string }[]
    } finally { db.close() }
  }

  it('add stores a login whose hash verifies, reset-password replaces it, remove deletes the row', async () => {
    const added = await cli(['add', 'person-a', '--password-stdin'], PASSWORD)
    expect(added.status, added.stderr).toBe(0)
    const afterAdd = rows()
    expect(afterAdd).toHaveLength(1)
    expect(afterAdd[0]!.role).toBe('admin')
    expect(await verifyPassword(PASSWORD, afterAdd[0]!.password_hash)).toBe(true)

    const reset = await cli(['reset-password', 'person-a', '--password-stdin'], NEW_PASSWORD)
    expect(reset.status, reset.stderr).toBe(0)
    const afterReset = rows()
    expect(afterReset[0]!.password_hash).not.toBe(afterAdd[0]!.password_hash)
    expect(await verifyPassword(NEW_PASSWORD, afterReset[0]!.password_hash)).toBe(true)
    expect(await verifyPassword(PASSWORD, afterReset[0]!.password_hash)).toBe(false)

    const removed = await cli(['remove', 'person-a'])
    expect(removed.status, removed.stderr).toBe(0)
    expect(removed.stdout).toContain('back to token-only mode')
    expect(rows()).toEqual([])
  }, 180_000)

  it('refuses a second add of the same name and a reset or remove of an unknown one', async () => {
    expect((await cli(['add', 'person-a', '--password-stdin'], PASSWORD)).status).toBe(0)
    const again = await cli(['add', 'person-a', '--password-stdin'], PASSWORD)
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('already exists')
    expect(rows()).toHaveLength(1)

    const reset = await cli(['reset-password', 'nobody', '--password-stdin'], NEW_PASSWORD)
    expect(reset.status).toBe(1)
    expect(reset.stderr).toContain('not found')
    const removed = await cli(['remove', 'nobody'])
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain('not found')
    expect(rows()).toHaveLength(1)
  }, 180_000)
})
