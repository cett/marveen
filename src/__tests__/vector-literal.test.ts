// The float32 embedding blob as the pgvector text literal (phase 3, step 6b, c3): a pure helper, no database. The
// PostgreSQL half of the round trip (text -> pgvector -> text) runs in the PostgreSQL suite; here the decimal text must
// parse back to exactly the float32 it came from, for every component of every vector.
import { describe, expect, it } from 'vitest'
import { blobToVectorLiteral, EMBEDDING_DIM, floatsToBlob } from '../db/vector.js'

/** A deterministic pseudo-random stream (LCG), so a failure can be reproduced. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** One float32 vector with a mix of magnitudes: tiny, unit, large, and both signs. */
function randomVector(next: () => number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, () => {
    const sign = next() < 0.5 ? -1 : 1
    const scale = [1e-6, 1e-2, 1, 1e3, 1e6][Math.floor(next() * 5)]!
    return sign * next() * scale
  })
}

describe('blobToVectorLiteral: the pgvector text of a float32 embedding', () => {
  it('a 768-float blob gives a bracketed list of 768 decimals (positive control)', () => {
    const blob = floatsToBlob(Array.from({ length: EMBEDDING_DIM }, (_, i) => i / 1000))
    const literal = blobToVectorLiteral(blob)
    expect(literal.startsWith('[')).toBe(true)
    expect(literal.endsWith(']')).toBe(true)
    expect(literal.slice(1, -1).split(',')).toHaveLength(EMBEDDING_DIM)
  })

  it('round trip: 1000 random vectors, every component parses back to the same float32 (JS side of the pgvector round trip)', () => {
    const next = prng(20261122)
    for (let v = 0; v < 1000; v++) {
      const blob = floatsToBlob(randomVector(next))
      const parts = blobToVectorLiteral(blob).slice(1, -1).split(',')
      expect(parts).toHaveLength(EMBEDDING_DIM)
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        const back = Math.fround(Number(parts[i]))
        if (back !== blob.readFloatLE(i * 4)) {
          throw new Error(`vector ${v} component ${i}: ${parts[i]} parses to ${back}, the float32 is ${blob.readFloatLE(i * 4)}`)
        }
      }
    }
  })

  it('a float32 value prints as its double, which parses back to the same float32 (0.1 is the float32 0.10000000149011612)', () => {
    const values = [0.1, ...new Array<number>(EMBEDDING_DIM - 1).fill(0)]
    const literal = blobToVectorLiteral(floatsToBlob(values))
    const first = literal.slice(1).split(',')[0]
    expect(first).toBe(String(Math.fround(0.1)))
    expect(Math.fround(Number(first))).toBe(Math.fround(0.1))
  })

  it('a blob of 767 floats is refused', () => {
    expect(() => blobToVectorLiteral(floatsToBlob(new Array<number>(EMBEDDING_DIM - 1).fill(0.5)))).toThrow(/expected 3072 \(768 float32 values\)/)
  })

  it('a blob of 769 floats is refused', () => {
    expect(() => blobToVectorLiteral(floatsToBlob(new Array<number>(EMBEDDING_DIM + 1).fill(0.5)))).toThrow(/expected 3072 \(768 float32 values\)/)
  })

  it('an empty blob is refused', () => {
    expect(() => blobToVectorLiteral(Buffer.alloc(0))).toThrow(/expected 3072 \(768 float32 values\)/)
  })

  it('a blob whose length is not a whole number of floats is refused', () => {
    expect(() => blobToVectorLiteral(Buffer.alloc(EMBEDDING_DIM * 4 + 2))).toThrow(/expected 3072 \(768 float32 values\)/)
  })

  it('a NaN component is refused, and the message names the component', () => {
    const values = new Array<number>(EMBEDDING_DIM).fill(0.25)
    values[5] = Number.NaN
    expect(() => blobToVectorLiteral(floatsToBlob(values))).toThrow(/component 5 is NaN/)
  })

  it('an Infinity and a -Infinity component are refused', () => {
    const plus = new Array<number>(EMBEDDING_DIM).fill(0.25)
    plus[0] = Number.POSITIVE_INFINITY
    expect(() => blobToVectorLiteral(floatsToBlob(plus))).toThrow(/component 0 is Infinity/)
    const minus = new Array<number>(EMBEDDING_DIM).fill(0.25)
    minus[EMBEDDING_DIM - 1] = Number.NEGATIVE_INFINITY
    expect(() => blobToVectorLiteral(floatsToBlob(minus))).toThrow(/component 767 is -Infinity/)
  })

  it('the helper does not change the blob it reads', () => {
    const blob = floatsToBlob(Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i)))
    const before = Buffer.from(blob)
    blobToVectorLiteral(blob)
    expect(blob.equals(before)).toBe(true)
  })

  it('the SQLite encoding is untouched (pin): 0.5 is the little-endian float32 00 00 00 3f', () => {
    expect(floatsToBlob([0.5]).equals(Buffer.from([0x00, 0x00, 0x00, 0x3f]))).toBe(true)
  })
})
