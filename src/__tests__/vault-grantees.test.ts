import { describe, it, expect } from 'vitest'
import { parseAllowList, agentGrantee, MAX_ACL_ENTRIES, SCOPE_GRANTEES } from '../web/vault-grantees.js'

// Pure validation of the `allow` array of PUT /api/vault/:id/acl (vault_secret_acl, migration 0090).

const KNOWN = ['agent-a', 'agent-b', 'main-a']

describe('parseAllowList', () => {
  it('accepts an empty array (it opens the secret)', () => {
    expect(parseAllowList([], KNOWN)).toEqual({ ok: true, allow: [] })
  })

  it('accepts known agents and the three scopes, in the order sent', () => {
    const allow = ['scope:user', 'agent:agent-b', 'scope:project', 'agent:main-a', 'scope:external']
    expect(parseAllowList(allow, KNOWN)).toEqual({ ok: true, allow })
  })

  it('collapses a repeated entry to its first position', () => {
    expect(parseAllowList(['agent:agent-a', 'scope:user', 'agent:agent-a', 'scope:user'], KNOWN))
      .toEqual({ ok: true, allow: ['agent:agent-a', 'scope:user'] })
  })

  it('the cap is 50 entries: 50 pass, 51 are refused (repeats count, they are still sent)', () => {
    expect(MAX_ACL_ENTRIES).toBe(50)
    expect(parseAllowList(Array(50).fill('scope:user'), KNOWN).ok).toBe(true)
    const over = parseAllowList(Array(51).fill('scope:user'), KNOWN)
    expect(over.ok).toBe(false)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'agent:agent-a'],
    ['an object', { 0: 'agent:agent-a', length: 1 }],
    ['a number', 7],
  ])('refuses %s as the list', (_name, raw) => {
    expect(parseAllowList(raw, KNOWN).ok).toBe(false)
  })

  it.each([
    ['a number', 1],
    ['null', null],
    ['an object', {}],
    ['an array', ['scope:user']],
    ['the empty string', ''],
    ['a bare agent name', 'agent-a'],
    ['a prefix with no id', 'agent:'],
    ['an unknown scope', 'scope:all'],
    ['a scope with different case', 'scope:USER'],
    ['an unknown agent', 'agent:ghost'],
    ['an agent id with different case', 'agent:Agent-A'],
    ['an agent id with a slash', 'agent:agent-a/x'],
    ['an agent id with a dot-dot', 'agent:..'],
    ['an agent id longer than 64 characters', `agent:${'a'.repeat(65)}`],
    ['an agent id with a trailing space', 'agent:agent-a '],
  ])('refuses an entry that is %s, even among valid ones', (_name, bad) => {
    const result = parseAllowList(['agent:agent-a', bad, 'scope:user'], KNOWN)
    expect(result.ok).toBe(false)
  })

  it('an agent that is not in the known list is refused even when its id is well-formed', () => {
    expect(parseAllowList(['agent:agent-a'], ['agent-b']).ok).toBe(false)
    expect(parseAllowList(['agent:agent-a'], []).ok).toBe(false)
  })

  it('a known agent whose id is outside the id charset is not accepted (no path could ever carry that name)', () => {
    expect(parseAllowList(['agent:bad id'], ['bad id']).ok).toBe(false)
    expect(parseAllowList([`agent:${'a'.repeat(65)}`], ['a'.repeat(65)]).ok).toBe(false)
    expect(parseAllowList(['agent:ok_id-1'], ['ok_id-1']).ok).toBe(true)
  })

  it('a scope is accepted whatever the known agents are (an agent called "user" is agent:user, not scope:user)', () => {
    expect(parseAllowList(['scope:user'], []).ok).toBe(true)
    expect(parseAllowList(['agent:user'], ['user'])).toEqual({ ok: true, allow: ['agent:user'] })
    expect(parseAllowList(['agent:user'], KNOWN).ok).toBe(false)
  })

  it('the refusal hint never echoes the offending entry', () => {
    const result = parseAllowList(['agent:secret-looking-name'], KNOWN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.hint).not.toContain('secret-looking-name')
  })
})

describe('grantee names', () => {
  it('agentGrantee prefixes the id and the scopes cannot collide with it', () => {
    expect(agentGrantee('agent-a')).toBe('agent:agent-a')
    expect(SCOPE_GRANTEES).toEqual(['scope:project', 'scope:user', 'scope:external'])
    for (const s of SCOPE_GRANTEES) expect(s.startsWith('agent:')).toBe(false)
  })
})
