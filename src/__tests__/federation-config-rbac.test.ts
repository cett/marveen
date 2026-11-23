// The federation config routes are admin-only. Before this change the endpoint table covered every
// POST under /api/federation/ with one prefix row (federation:write), which the tenant 'agent' role
// holds, so a tenant user (or a per-device fleet key, also role agent) could switch federation on or
// off, add a peer (minting an inbound token), reveal or rotate a peer's inbound token, apply the
// config (restart of the main agent's channels session) or remove the whole federation.
//
// This is the endpoint table seen from the gate: for each route and each principal, allowed or
// refused. The wire endpoint (the inbox) keeps federation:write, because a peer (role agent) posts
// to it. PUT, PATCH and DELETE on the peers routes have no table row and fall to admin:all; they are
// pinned here so a later broad row cannot widen them unnoticed.

import { describe, it, expect } from 'vitest'
import { checkPermission } from '../web/authz.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import type { AuthResult } from '../web/auth-gate.js'

const PREFIXES = ['/api/federation', '/api/v1/federation'] as const

// [method, path suffix]: the routes that change or expose federation config.
const CONFIG_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/enabled'],
  ['POST', '/routing-mode'],
  ['POST', '/peers'],
  ['POST', '/refresh'],
  ['POST', '/apply'],
  ['POST', '/remove'],
  ['POST', '/peers/peer-a/rotate-inbound-token'],
  ['GET', '/peers/peer-a/inbound-token'],
  // No table row of their own: the unmapped fallback is admin:all.
  ['PUT', '/peers'],
  ['PATCH', '/peers/peer-a'],
  ['DELETE', '/peers/peer-a'],
]

const ADMIN_TOKEN: AuthResult = { kind: 'token' }
const ADMIN_SESSION: AuthResult = { kind: 'session', user: 'user-a', role: 'admin', tenantId: null }
const TENANT_AGENT_SESSION: AuthResult = { kind: 'session', user: 'user-b', role: 'agent', tenantId: 'tenant-a' }
const READ_ONLY_SESSION: AuthResult = { kind: 'session', user: 'user-c', role: 'read_only', tenantId: 'tenant-a' }
const VIEWER_SESSION: AuthResult = { kind: 'session', user: 'user-d', role: 'viewer', tenantId: 'tenant-a' }
const DEVICE: AuthResult = { kind: 'device', device: 'device-a', deviceId: 1 }
const PEER: AuthResult = { kind: 'federation', peer: 'peer-a' }
const FLEET_TOKEN: AuthResult = { kind: 'token', role: 'fleet_agent', tenantId: 'default', agentId: 'agent-a' }

const REFUSED_PRINCIPALS: ReadonlyArray<readonly [string, AuthResult]> = [
  ['tenant agent session', TENANT_AGENT_SESSION],
  ['read_only session', READ_ONLY_SESSION],
  ['viewer session', VIEWER_SESSION],
  ['device key', DEVICE],
  ['peer', PEER],
  ['fleet agent token', FLEET_TOKEN],
]

describe('federation config routes need admin:all', () => {
  for (const prefix of PREFIXES) {
    for (const [method, suffix] of CONFIG_ROUTES) {
      const path = `${prefix}${suffix}`

      it(`${method} ${path}: resolves to admin:all`, () => {
        // null is the unmapped fallback, which checkPermission reads as admin:all
        expect(resolveRequiredPermission(method, path) ?? 'admin:all').toBe('admin:all')
      })

      for (const [label, auth] of REFUSED_PRINCIPALS) {
        it(`${method} ${path}: ${label} is refused with 403`, () => {
          const d = checkPermission(auth, method, path)
          expect(d.allowed).toBe(false)
          if (!d.allowed) expect(d.status).toBe(403)
        })
      }

      it(`${method} ${path}: the admin token and an admin session are allowed`, () => {
        expect(checkPermission(ADMIN_TOKEN, method, path).allowed).toBe(true)
        expect(checkPermission(ADMIN_SESSION, method, path).allowed).toBe(true)
      })
    }
  }
})

describe('the explicit rows are the reason, not the fallback', () => {
  // The routes with an explicit row resolve to a NAMED admin:all, not to null (the unmapped
  // fallback): removing a row would then widen it to the prefix row's federation:write, and this
  // cell is red. The PUT/PATCH/DELETE routes are the ones that rely on the fallback, pinned above.
  const EXPLICIT: ReadonlyArray<readonly [string, string]> = CONFIG_ROUTES.filter(([m, s]) => !(
    (m === 'PUT' && s === '/peers') || (m === 'PATCH' && s === '/peers/peer-a') || (m === 'DELETE' && s === '/peers/peer-a')
  ))
  for (const prefix of PREFIXES) {
    for (const [method, suffix] of EXPLICIT) {
      it(`${method} ${prefix}${suffix} has its own admin:all row`, () => {
        expect(resolveRequiredPermission(method, `${prefix}${suffix}`)).toBe('admin:all')
      })
    }
  }

  it('PUT, PATCH and DELETE on the peers routes are unmapped (fallback admin:all)', () => {
    for (const prefix of PREFIXES) {
      expect(resolveRequiredPermission('PUT', `${prefix}/peers`)).toBeNull()
      expect(resolveRequiredPermission('PATCH', `${prefix}/peers/peer-a`)).toBeNull()
      expect(resolveRequiredPermission('DELETE', `${prefix}/peers/peer-a`)).toBeNull()
    }
  })
})

describe('the wire and read routes are unchanged', () => {
  for (const prefix of PREFIXES) {
    it(`POST ${prefix}/inbox stays federation:write`, () => {
      expect(resolveRequiredPermission('POST', `${prefix}/inbox`)).toBe('federation:write')
    })

    it(`POST ${prefix}/inbox is not refused for a peer, a tenant agent session or a device key`, () => {
      for (const auth of [PEER, TENANT_AGENT_SESSION, DEVICE, ADMIN_TOKEN]) {
        expect(checkPermission(auth, 'POST', `${prefix}/inbox`).allowed).toBe(true)
      }
    })

    it(`POST ${prefix}/inbox is still refused for read_only, viewer and a fleet agent token`, () => {
      for (const auth of [READ_ONLY_SESSION, VIEWER_SESSION, FLEET_TOKEN]) {
        const d = checkPermission(auth, 'POST', `${prefix}/inbox`)
        expect(d.allowed).toBe(false)
      }
    })

    for (const suffix of ['/manifest', '/peers', '/status', '/directory']) {
      it(`GET ${prefix}${suffix} stays federation:read, open to a peer and a tenant agent session`, () => {
        expect(resolveRequiredPermission('GET', `${prefix}${suffix}`)).toBe('federation:read')
        expect(checkPermission(TENANT_AGENT_SESSION, 'GET', `${prefix}${suffix}`).allowed).toBe(true)
        expect(checkPermission(PEER, 'GET', `${prefix}${suffix}`).allowed).toBe(true)
      })
    }
  }

  it('a path that only starts like an inbound-token route stays on the prefix rows', () => {
    // the regex is anchored: a deeper or shorter path is not caught by it
    expect(resolveRequiredPermission('GET', '/api/federation/peers/peer-a/inbound-token/extra')).toBe('federation:read')
    expect(resolveRequiredPermission('GET', '/api/federation/peers/inbound-token')).toBe('federation:read')
  })
})
