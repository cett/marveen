// `npm run dashboard-user -- list` names each login's role and tenant, so the owner can confirm from the
// machine that a login is a global admin (role admin, tenant global) without opening the dashboard.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { formatUserLine, formatTenant } from '../lib/dashboard-user-format.js'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PASSWORD = 'a-long-test-password-1'
const CREATED = Date.UTC(2026, 9, 12, 8, 0, 0) / 1000

describe('formatUserLine', () => {
  const base = { username: 'person-a', role: 'admin', tenant_id: null, created_at: CREATED, disabled: 0 }

  it('names the role and a global tenant', () => {
    expect(formatUserLine(base)).toBe('person-a  role=admin  tenant=global  created 2026-10-12T08:00:00.000Z')
  })

  it('names a tenant by its id', () => {
    expect(formatUserLine({ ...base, username: 'user-b', role: 'agent', tenant_id: 'tenant-b' }))
      .toBe('user-b  role=agent  tenant=tenant-b  created 2026-10-12T08:00:00.000Z')
  })

  it('marks a disabled login and still shows what it would be', () => {
    expect(formatUserLine({ ...base, disabled: 1 })).toContain('person-a (disabled)  role=admin  tenant=global')
  })

  it('does not read an empty tenant id as a tenant', () => {
    expect(formatTenant('')).toBe('tenant=global')
    expect(formatTenant(undefined)).toBe('tenant=global')
    expect(formatTenant(null)).toBe('tenant=global')
  })

  it('tells an admin who belongs to a tenant from the global admin (the difference that matters)', () => {
    const tenantAdmin = formatUserLine({ ...base, tenant_id: 'tenant-b' })
    expect(tenantAdmin).toContain('role=admin')
    expect(tenantAdmin).not.toContain('tenant=global')
  })
})

describe('the CLI list command', () => {
  let storeDir: string

  beforeEach(() => { storeDir = mkdtempSync(join(tmpdir(), 'du-list-')) })
  afterEach(() => { rmSync(storeDir, { recursive: true, force: true }) })

  // Async spawn, one process per command, against an isolated store.
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

  it('says so when there is no login', async () => {
    const out = await cli(['list'])
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('No dashboard users')
    // First run on an empty store applies every migration; none of those log lines may reach stdout.
    expect(out.stdout.trim().split('\n')).toHaveLength(1)
    expect(out.stderr).toContain('Migration applied')
  }, 60_000)

  it('lists each login with its role and tenant', async () => {
    for (const name of ['person-a', 'user-b', 'user-c']) {
      const added = await cli(['add', name, '--password-stdin'], PASSWORD)
      expect(added.status, added.stderr).toBe(0)
    }
    const db = new Database(join(storeDir, 'claudeclaw.db'))
    db.prepare("UPDATE dashboard_users SET role = 'admin', tenant_id = 'tenant-b' WHERE username = 'user-b'").run()
    db.prepare("UPDATE dashboard_users SET disabled = 1 WHERE username = 'user-c'").run()
    db.close()

    const out = await cli(['list'])
    expect(out.status, out.stderr).toBe(0)
    const lines = out.stdout.trim().split('\n')
    expect(lines).toHaveLength(3)
    // The first login is the global admin; the tenant admin looks different; the later one is a viewer.
    expect(lines[0]).toMatch(/^person-a {2}role=admin {2}tenant=global {2}created /)
    expect(lines[1]).toMatch(/^user-b {2}role=admin {2}tenant=tenant-b {2}created /)
    expect(lines[2]).toMatch(/^user-c \(disabled\) {2}role=viewer {2}tenant=global {2}created /)
    // The startup schema report is a log line: it belongs on stderr, never in the output a caller parses.
    expect(out.stdout).not.toContain('schema:')
    expect(out.stderr).toContain('schema: db')
    // A listing never carries a password or its hash.
    expect(out.stdout).not.toContain(PASSWORD)
    expect(out.stdout).not.toMatch(/scrypt|\$/)
  }, 120_000)
})
