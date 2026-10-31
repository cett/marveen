// interpreterWithCodeFlag() replaces the lazy `\b(?:python|node|...sh)\b[^\n]*?\s-[A-Za-z]*[cerEp]\b` part of
// NETWORK_TOKEN. That pattern searched the rest of the line again from every interpreter word (`sh ` x N:
// 55 kB 0.4 s, quadratic). The two parts are separate patterns now; the answer must not change.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { interpreterWithCodeFlag, networkCapable, classify } from '../../scripts/hooks/bash-egress-parser.mjs'

// The pre-fix pattern, kept here as the oracle for the differential test only.
const OLD = /\b(?:python[\d.]*|node(?:js)?|perl|ruby|php|deno|bun|(?:ba|z|da|k|c|tc)?sh)\b[^\n]*?\s-[A-Za-z]*[cerEp]\b/i

function fuzz(seed: number, tokens: string[], count: number): string {
  let s = seed
  let out = ''
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out += tokens[s % tokens.length]
  }
  return out
}

const BIG = 550_000
function timeMs(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

describe('interpreterWithCodeFlag', () => {
  it('gives what the old pattern gave on hand-written cases', () => {
    for (const t of [
      '', 'ls -la', 'sh -c "x"', 'python3 -c "import os"', 'node -e 1', 'bash script.sh -x', 'perl -pe s/a/b/',
      'echo sh\n x -c', 'sh\n-c', 'python3.11 -c x', 'nodejs --eval y', 'shx -c', 'xsh -c', 'ruby -e 1', 'dash -c y',
      'bash -lc x', 'zsh -ic x', 'tcsh -c z', 'SH -C X', 'python -m http.server', 'sh a b c -r', 'sh -x',
    ]) {
      expect(interpreterWithCodeFlag(t), JSON.stringify(t)).toBe(OLD.test(t))
    }
  })

  it('gives what the old pattern gave on 200000 random strings', () => {
    const tokens = ['sh', ' ', '-c', '-x', 'python3.11', 'node', '\n', 'x', '-', 'Perl', ' -e', 'bash', '.', '1', '-ce', 'shx', 'eval']
    for (let seed = 1; seed <= 200_000; seed++) {
      const t = fuzz(seed, tokens, seed % 12)
      if (interpreterWithCodeFlag(t) !== OLD.test(t)) throw new Error(`mismatch on ${JSON.stringify(t)}`)
    }
  })

  it('stays linear on 550 kB of hostile shapes', () => {
    const shapes: Record<string, string> = {
      'sh x N': 'sh '.repeat(BIG / 3),
      'python x N': 'python '.repeat(BIG / 7),
      'sh x N, flag at the end': 'sh '.repeat(BIG / 3) + ' -c',
      'sh lines': 'sh x\n'.repeat(BIG / 5),
      'sh and flags interleaved': 'sh -x '.repeat(BIG / 6),
      'long flag run': 'sh -' + 'a'.repeat(BIG),
    }
    for (const [name, text] of Object.entries(shapes)) {
      expect(text.length, name).toBeGreaterThan(BIG * 0.98)
      expect(timeMs(() => interpreterWithCodeFlag(text)), name).toBeLessThan(300)
    }
  })
})

describe('networkCapable', () => {
  it('still sees the other network-capable shapes and an interpreter with a code flag', () => {
    expect(networkCapable('curl https://example.test/x')).toBe(true)
    expect(networkCapable('echo hi > /dev/tcp/host/80')).toBe(true)
    expect(networkCapable('python3 -c "x"')).toBe(true)
    expect(networkCapable('node --eval y')).toBe(true)
    expect(networkCapable('ls -la')).toBe(false)
  })

  it('the unparseable branch of classify() denies a network-capable command and passes a plain one', () => {
    expect(classify('python3 -c "unterminated').deny).toBe(true)
    expect(classify('echo "unterminated').deny).toBe(false)
  })

  it('answers a 550 kB unparseable command in under 300 ms', () => {
    const text = '"' + 'sh '.repeat(BIG / 3)
    expect(timeMs(() => classify(text))).toBeLessThan(300)
  })
})
