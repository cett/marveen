// The headersHelper core: one header from one vault secret, fail closed. Every failure is exit code 1 with an
// EMPTY stdout (so Claude Code sends no Authorization), described by outcome and secret id and never by value.
//
// Privacy: neutral fixtures only; every secret value is invented.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../web/vault.js', () => ({ getSecret: vi.fn(() => null) }))

import { parseHelperArgs, runHeaderHelper } from '../web/http-mcp-header-helper.js'

const VALUE = 'fixture-secret-value-0123456789'
const found = (id: string) => (id === 'fixture-secret-a' ? VALUE : null)
const ARGS = ['--secret', 'fixture-secret-a', '--header', 'Authorization', '--prefix', 'Bearer ']

describe('parseHelperArgs', () => {
  it('reads the three flags in any order; the prefix is optional', () => {
    expect(parseHelperArgs(ARGS)).toEqual({ secretId: 'fixture-secret-a', header: 'Authorization', prefix: 'Bearer ' })
    expect(parseHelperArgs(['--header', 'X-Key', '--secret', 'fixture-secret-a'])).toEqual({ secretId: 'fixture-secret-a', header: 'X-Key', prefix: '' })
  })

  it.each([
    ['no arguments', []],
    ['no header', ['--secret', 'fixture-secret-a']],
    ['no secret', ['--header', 'Authorization']],
    ['an unknown flag', [...ARGS, '--extra', 'x']],
    ['a flag with no value', ['--secret', 'fixture-secret-a', '--header']],
    ['a repeated flag', [...ARGS, '--secret', 'fixture-secret-b']],
    ['a bare word', ['fixture-secret-a']],
    ['an id with a space', ['--secret', 'fixture secret', '--header', 'Authorization']],
    ['an id with a path', ['--secret', '../fixture-secret-a', '--header', 'Authorization']],
    ['an id of 129 characters', ['--secret', 'a'.repeat(129), '--header', 'Authorization']],
    ['an empty id', ['--secret', '', '--header', 'Authorization']],
    ['a header name with a colon', ['--secret', 'fixture-secret-a', '--header', 'X:Key']],
    ['a header name with a newline', ['--secret', 'fixture-secret-a', '--header', 'X\nKey']],
    ['an empty header name', ['--secret', 'fixture-secret-a', '--header', '']],
    ['a prefix with a newline (header injection)', [...ARGS.slice(0, 4), '--prefix', 'Bearer \nX-Evil: 1']],
    ['a prefix with a tab', [...ARGS.slice(0, 4), '--prefix', 'Bearer\t']],
    ['a prefix of 33 characters', [...ARGS.slice(0, 4), '--prefix', 'a'.repeat(33)]],
  ])('refuses %s', (_label, argv) => {
    expect(parseHelperArgs(argv)).toBeNull()
  })

  it('128-character id and 32-character prefix are the largest allowed', () => {
    expect(parseHelperArgs(['--secret', 'a'.repeat(128), '--header', 'A', '--prefix', 'p'.repeat(32)])).not.toBeNull()
  })
})

describe('runHeaderHelper: success', () => {
  it('prints exactly one JSON object with the header, prefix + value', () => {
    const r = runHeaderHelper(ARGS, found)
    expect(r.code).toBe(0)
    expect(r.stdout.endsWith('\n')).toBe(true)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${VALUE}` })
    expect(r.event).toEqual({ outcome: 'ok', secretId: 'fixture-secret-a' })
  })

  it('the event never carries the value', () => {
    expect(JSON.stringify(runHeaderHelper(ARGS, found).event)).not.toContain(VALUE)
  })

  it('a vault value replaced between two calls is what the next call prints (rotation needs no restart)', () => {
    const OLD = 'fixture-old-value-0123456789'
    const NEW = 'fixture-new-value-9876543210'
    let current = OLD
    const lookup = () => current
    expect(JSON.parse(runHeaderHelper(ARGS, lookup).stdout).Authorization).toBe(`Bearer ${OLD}`)
    current = NEW
    expect(JSON.parse(runHeaderHelper(ARGS, lookup).stdout).Authorization).toBe(`Bearer ${NEW}`)
  })

  it('a value with quotes and backslashes survives the JSON round trip', () => {
    const tricky = 'a"b\\c\'d-0123456789'
    const r = runHeaderHelper(ARGS, () => tricky)
    expect(JSON.parse(r.stdout).Authorization).toBe(`Bearer ${tricky}`)
  })
})

describe('runHeaderHelper: every failure is exit 1 with an empty stdout', () => {
  const FAILS: Array<[string, readonly string[], (id: string) => string | null, string, string | undefined]> = [
    ['bad arguments', ['--secret', 'x y', '--header', 'Authorization'], found, 'bad-args', undefined],
    ['an SSH key id', ['--secret', 'ssh-key-fixture', '--header', 'Authorization'], () => VALUE, 'ssh-key', 'ssh-key-fixture'],
    ['an id that is not in the vault', ['--secret', 'fixture-secret-missing', '--header', 'Authorization'], found, 'unresolved', 'fixture-secret-missing'],
    ['a vault that throws', ARGS, () => { throw new Error(`boom ${VALUE}`) }, 'vault-error', 'fixture-secret-a'],
    ['an empty value', ARGS, () => '', 'bad-value', 'fixture-secret-a'],
    ['a value with a line feed', ARGS, () => 'abc\nX-Evil: 1', 'bad-value', 'fixture-secret-a'],
    ['a value with a carriage return', ARGS, () => 'abc\rdef', 'bad-value', 'fixture-secret-a'],
    ['a value with a NUL', ARGS, () => 'abc\0def', 'bad-value', 'fixture-secret-a'],
  ]
  it.each(FAILS)('%s', (_label, argv, lookup, outcome, secretId) => {
    const r = runHeaderHelper(argv, lookup)
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.event).toEqual(secretId === undefined ? { outcome } : { outcome, secretId })
    expect(JSON.stringify(r)).not.toContain(VALUE)
  })

  it('the SSH key is refused before the vault is asked at all', () => {
    const lookup = vi.fn(() => VALUE)
    runHeaderHelper(['--secret', 'ssh-key-fixture', '--header', 'Authorization'], lookup)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('bad arguments never reach the vault', () => {
    const lookup = vi.fn(() => VALUE)
    runHeaderHelper(['--secret', 'x y', '--header', 'Authorization'], lookup)
    expect(lookup).not.toHaveBeenCalled()
  })
})
