// Browser enrollment: a one-time code is traded for the browser's OWN admin token.
//
//   POST /api/admin/browser-enroll-codes   -- an admin asks for a fresh single-use code (and the URL to open)
//   POST /api/auth/enroll-browser {code}   -- PUBLIC: spends a code, mints a named, revocable admin token
//
// The dashboard URL used to carry the shared token (`/?token=<shared>`). It carries a code now
// (`/?enroll=<code>`); the shared token never leaves store/. The minted token is an ordinary
// api_tokens row (role admin, tenant default, named `browser <date> <tag>`), so it shows up in
// GET /api/admin/tokens and is revoked alone with DELETE /api/admin/tokens/:id/revoke.
//
// The code store and its brute-force throttle live in web/browser-enroll-codes.ts.

import { randomBytes } from 'node:crypto'
import { insertApiToken } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { consumeEnrollCode, issueEnrollCode } from '../browser-enroll-codes.js'
import { generateToken, sha256hex } from './tokens.js'
import { denyAgentCredentialIssue } from '../session-only-guard.js'
import type { RouteContext } from './types.js'

const ENROLL_BODY_MAX_BYTES = 2 * 1024

// A code buys a full admin token, so only a global admin (the shared token, an admin token of the
// default tenant, or a global-admin session) may ask for one. A tenant-scoped admin must not turn
// a code into a default-tenant admin token. 'device' is deliberately absent: a leaked device key
// must not be able to mint further credentials.
function isGlobalAdmin(ctx: RouteContext): boolean {
  const kindOk = ctx.auth?.kind === 'token' || ctx.auth?.kind === 'session'
  const tenantOk = ctx.tenantId === undefined || ctx.tenantId === null || ctx.tenantId === 'default'
  return kindOk && ctx.role === 'admin' && tenantOk
}

export async function tryHandleBrowserEnroll(ctx: RouteContext): Promise<boolean> {
  const { path, method, req, res } = ctx

  if (method === 'POST' && path === '/api/admin/browser-enroll-codes') {
    if (denyAgentCredentialIssue(ctx, 'admin.browser_enroll_code.create')) return true
    if (!isGlobalAdmin(ctx)) {
      json(res, { error: 'forbidden', hint: 'Only a global admin can issue a browser enrollment code' }, 403)
      return true
    }
    const { code, expiresAt } = issueEnrollCode()
    logger.info({ by: ctx.auth?.tokenName ?? ctx.auth?.user ?? ctx.auth?.kind }, 'browser enrollment code issued')
    json(res, { code, expires_at: Math.floor(expiresAt / 1000) }, 201)
    return true
  }

  if (method === 'POST' && path === '/api/auth/enroll-browser') {
    let code = ''
    try {
      const raw = (await readBody(req, { maxBytes: ENROLL_BODY_MAX_BYTES })).toString().trim()
      const parsed = raw ? JSON.parse(raw) : {}
      if (parsed && typeof parsed === 'object' && typeof (parsed as { code?: unknown }).code === 'string') {
        code = (parsed as { code: string }).code.trim()
      }
    } catch {
      json(res, { error: 'parse_error', hint: 'invalid body' }, 400)
      return true
    }

    const attempt = consumeEnrollCode(code)
    if (!attempt.ok) {
      if (attempt.reason === 'throttled') {
        logger.warn('browser enroll: failed-attempt cap reached -- enrollment throttled')
        // setHeader before json() so Retry-After merges into writeHead's header map.
        res.setHeader('Retry-After', String(attempt.retryAfterS))
        json(res, { error: 'limit_exceeded', retry_after_s: attempt.retryAfterS }, 429)
        return true
      }
      logger.warn('browser enroll: invalid or expired code')
      json(res, { error: 'unauthorized', hint: 'Invalid or expired enrollment code' }, 401)
      return true
    }

    const now = Math.floor(Date.now() / 1000)
    const name = `browser ${new Date(now * 1000).toISOString().slice(0, 10)} ${randomBytes(2).toString('hex')}`
    const rawToken = generateToken()
    try {
      const row = await insertApiToken({ tokenHash: sha256hex(rawToken), name, role: 'admin', tenantId: 'default', createdAt: now, expiresAt: null })
      logger.info({ tokenId: row.id, name }, 'browser enrolled: api_token created')
      // The raw token is returned ONCE; only its hash is stored.
      json(res, { token: rawToken, id: row.id, name: row.name }, 201)
    } catch (e) {
      logger.error({ err: e }, 'browser enroll: token mint failed')
      json(res, { error: 'internal_error', hint: 'failed to create token' }, 500)
    }
    return true
  }

  return false
}
