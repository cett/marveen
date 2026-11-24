// The canonical tokens of the copy's read-back fingerprint (P-G1 c3 fixup), with no PostgreSQL: a boundary shift between two
// text columns, NULL against the empty string, a double against the same double rounded to float4, a bigint above 2^53 one
// step from its neighbour, and two identical rows (the fold must not cancel them).
import { describe, expect, it } from 'vitest'
import { canonicalToken, Fingerprint, rowDigest } from '../db/pg-copy/fingerprint.js'

const text = (value: string | null): { value: string | null; pgType: string } => ({ value, pgType: 'text' })

describe('the canonical token is self-delimiting and tells every value class apart', () => {
  it('a boundary shift between two text columns gives a different row digest, and each text token carries its byte length', () => {
    expect(rowDigest([text('ab'), text('c')])).not.toBe(rowDigest([text('a'), text('bc')]))
    expect(canonicalToken('ab', 'text') + canonicalToken('c', 'text')).toBe('T2:ab;T1:c;')
  })

  it('NULL and the empty string are different tokens', () => {
    expect(canonicalToken(null, 'text')).not.toBe(canonicalToken('', 'text'))
  })

  it('a double and the same double rounded to float4 are different tokens', () => {
    const v = 0.1234567890123456
    expect(canonicalToken(v, 'double precision')).not.toBe(canonicalToken(Math.fround(v), 'double precision'))
  })

  it('a bigint above 2^53 and the bigint one lower are different tokens', () => {
    expect(canonicalToken(9007199254740993n, 'bigint')).not.toBe(canonicalToken(9007199254740992n, 'bigint'))
  })

  it('two identical rows do not cancel in the fold', () => {
    const digest = rowDigest([text('same')])
    const folded = new Fingerprint()
    folded.add(digest)
    folded.add(digest)
    expect(folded.rows).toBe(2)
    expect(folded.equals(new Fingerprint())).toBe(false)
    expect(folded.hexString).not.toBe(new Fingerprint().hexString)
  })
})
