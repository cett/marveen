import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_TOKENS, ALLOWED_STATUS_TOKENS, checkErrorResponse } from '../api-error-catalog.js'

const repoFile = (...parts: string[]) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', ...parts), 'utf-8')

// The catalog is the source of truth; the openapi Error enum and the generated SDK type are GENERATED from it
// (npm run generate:sdk). A generator bug once wrote a bogus value into both and dropped a real token, and `tsc`
// could not see it: both files are valid. These tests compare the generated artefacts with the catalog itself.
describe('generated artefacts match the catalog', () => {
  it('the openapi Error.error enum is exactly ERROR_TOKENS, in order', () => {
    const yaml = repoFile('docs', 'openapi.yaml')
    const block = yaml.match(/properties:\n\s+error:\n\s+type: string[\s\S]*?\n\s+enum:\n([\s\S]*?)\n\s+hint:/)
    expect(block, 'Error.error enum block not found in docs/openapi.yaml').not.toBeNull()
    const values = block![1].split('\n').map((l) => l.trim().replace(/^- /, ''))
    expect(values).toEqual([...ERROR_TOKENS])
  })

  it('the generated SDK Error.error union is exactly ERROR_TOKENS, in order', () => {
    const ts = repoFile('src', 'generated', 'api.ts')
    const line = ts.match(/^\s+error: ('[^;]+);$/m)
    expect(line, 'Error.error union not found in src/generated/api.ts').not.toBeNull()
    const values = line![1].split(' | ').map((v) => v.replace(/'/g, ''))
    expect(values).toEqual([...ERROR_TOKENS])
  })

  it('every token is a plain snake_case word (a stray fragment of a comment is not)', () => {
    for (const t of ERROR_TOKENS) expect(t).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

describe('api-error-catalog invariants', () => {
  it('has no duplicate tokens', () => {
    expect(new Set(ERROR_TOKENS).size).toBe(ERROR_TOKENS.length)
  })

  it('all ALLOWED_STATUS_TOKENS entries reference valid tokens', () => {
    const valid = new Set(ERROR_TOKENS)
    for (const [status, tokens] of Object.entries(ALLOWED_STATUS_TOKENS)) {
      for (const t of tokens) {
        expect(valid.has(t), `${t} in status ${status} not in catalog`).toBe(true)
      }
    }
  })

  it('known valid pairings pass', () => {
    expect(checkErrorResponse('not_found', 404)).toBeNull()
    expect(checkErrorResponse('internal_error', 500)).toBeNull()
    expect(checkErrorResponse('upstream_error', 502)).toBeNull()
    expect(checkErrorResponse('required', 400)).toBeNull()
    expect(checkErrorResponse('disabled', 409)).toBeNull()
    expect(checkErrorResponse('sender_not_in_allowlist', 403)).toBeNull()
    expect(checkErrorResponse('federation_disabled', 400)).toBeNull()
    expect(checkErrorResponse('unknown_query_parameter', 400)).toBeNull()
    expect(checkErrorResponse('vault_key_unavailable', 503)).toBeNull()
  })

  it('vault_key_unavailable is a 503 only (an operator fixes it; not a bug-500, not a state-409, not a client 4xx)', () => {
    for (const status of [400, 403, 404, 409, 500, 502]) {
      expect(checkErrorResponse('vault_key_unavailable', status), `HTTP ${status}`).toMatch(/not allowed with HTTP/)
    }
  })

  it('the generic 503 tokens are unchanged (the vault token was added, nothing removed)', () => {
    expect(ALLOWED_STATUS_TOKENS[503]).toEqual(expect.arrayContaining(['timeout', 'upstream_error', 'internal_error', 'vault_key_unavailable']))
    expect(checkErrorResponse('internal_error', 503)).toBeNull()
  })

  it('catches unknown token', () => {
    expect(checkErrorResponse('some_random_thing', 400)).toMatch(/unknown error token/)
  })

  it('catches forbidden status-token pairing (internal_error + 400)', () => {
    expect(checkErrorResponse('internal_error', 400)).toMatch(/not allowed with HTTP 400/)
  })

  it('catches forbidden pairing (not_found + 500)', () => {
    expect(checkErrorResponse('not_found', 500)).toMatch(/not allowed with HTTP 500/)
  })

  it('catches forbidden pairing (upstream_error + 500)', () => {
    expect(checkErrorResponse('upstream_error', 500)).toMatch(/not allowed with HTTP 500/)
  })

  it('catches forbidden pairing (forbidden + 400)', () => {
    expect(checkErrorResponse('forbidden', 400)).toMatch(/not allowed with HTTP 400/)
  })

  it('status_conflict is a 409-only token', () => {
    expect(checkErrorResponse('status_conflict', 409)).toBeNull()
    // A compare-and-set miss is a state conflict: never a 400 (malformed), 404 (missing) or 500.
    expect(checkErrorResponse('status_conflict', 400)).toMatch(/not allowed with HTTP 400/)
    expect(checkErrorResponse('status_conflict', 404)).toMatch(/not allowed with HTTP 404/)
    expect(checkErrorResponse('status_conflict', 500)).toMatch(/not allowed with HTTP 500/)
  })

  it('agent_not_allowed is a 403-only token', () => {
    expect(checkErrorResponse('agent_not_allowed', 403)).toBeNull()
    // A refused target is an authorization answer: never a malformed request, a missing entity or a state conflict.
    expect(checkErrorResponse('agent_not_allowed', 400)).toMatch(/not allowed with HTTP 400/)
    expect(checkErrorResponse('agent_not_allowed', 404)).toMatch(/not allowed with HTTP 404/)
    expect(checkErrorResponse('agent_not_allowed', 409)).toMatch(/not allowed with HTTP 409/)
  })

  it('returns null for unconstrained status (e.g. 200 with no error field check needed)', () => {
    // Statuses not in ALLOWED_STATUS_TOKENS are unconstrained -- any valid token passes.
    expect(checkErrorResponse('not_found', 200)).toBeNull()
  })
})
