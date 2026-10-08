import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SECURITY WIRING: the production request pipeline must run resolveAuth with
// the DB lookups on (api_tokens role/tenant, dashboard_users sessions). With
// dbLookups=false the gate silently degrades to the DB-less mode, where
// sessions carry no role. The behaviour of both modes is covered in
// auth-gate.test.ts; this pins that web.ts selects the right one. Source-level
// on purpose: booting startWebServer() writes the dashboard token and dirs.

const WEB_SRC = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')

describe('web.ts resolveAuth wiring', () => {
  it('has exactly one resolveAuth call site (no second, unchecked gate)', () => {
    expect(WEB_SRC.match(/\bresolveAuth\(/g)?.length).toBe(1)
  })

  it('passes dbLookups = true as the final argument', () => {
    expect(WEB_SRC).toMatch(/\bresolveAuth\(req, url, path, method, DASHBOARD_TOKEN, true\)/)
  })
})
