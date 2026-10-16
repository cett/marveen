// The scrub rules shared by the input summary and the application log export (src/otel-scrub.ts): provider
// credentials in their own shape, and what must stay readable. Fixtures are assembled from parts, so no file in
// the repository holds a complete key-shaped string.

import { describe, it, expect } from 'vitest'
import { scrubText, scrubLogText, scrubBlobs } from '../otel-scrub.js'

const A = (n: number) => 'A'.repeat(n)
const j = (...parts: string[]) => parts.join('')

const KEYS: Array<[string, string]> = [
  ['an Anthropic key', j('sk-', 'ant-', 'api03-', A(40))],
  ['an OpenAI style key', j('sk-', 'proj-', A(30), '1234')],
  ['a GitHub personal token', j('gh', 'p_', A(36))],
  ['a GitHub OAuth token', j('gh', 'o_', A(36))],
  ['a GitHub server token', j('gh', 's_', A(36))],
  ['a GitHub fine-grained token', j('github', '_pat_', A(30), '_', A(20))],
  ['a Slack bot token', j('xo', 'xb-', '123456789012-', A(24))],
  ['a Slack user token', j('xo', 'xp-', '123456789012-', A(24))],
  ['a Slack app token', j('xa', 'pp-', '1-', A(20), '-12345')],
  ['a JSON web token', j('ey', 'Jhbc', 'GciOi.', 'ey', 'Jzd', 'WIiOi.', A(20))],
  ['an AWS access key id', j('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
  ['an AWS temporary key id', j('AS', 'IA', 'ABCDEFGHIJKLMNOP')],
]

describe('provider credentials with no keyword next to them', () => {
  for (const [name, key] of KEYS) {
    it(`removes ${name} from a log message and from a tool input summary`, () => {
      for (const scrub of [scrubText, scrubLogText]) {
        const out = scrub(`call failed with ${key} in the request`, 200)
        expect(out).not.toContain(key.slice(0, 14))
        expect(out).not.toContain(key.slice(-10))
        expect(out).toContain('call failed with')
        expect(out).toContain('in the request')
      }
    })
  }

  it('removes a key at the very start and at the very end of the text', () => {
    const key = j('gh', 'p_', A(36))
    expect(scrubLogText(key, 100)).toBe('***')
    expect(scrubLogText(`x ${key}`, 100)).toBe('x ***')
  })

  it('cuts last, so a cut never leaves half a key', () => {
    const key = j('sk-', 'ant-', 'api03-', A(40))
    // cut first, the 12 characters that would survive ("sk-ant-api03") are too short for the rule to see a key
    const out = scrubLogText(`${'x '.repeat(30)}${key}`, 72)
    expect(out).not.toContain('sk-ant')
    expect(out).not.toContain('api03')
    expect(out.endsWith('***')).toBe(true)
  })
})

describe('a long run of base64-looking characters in a log message', () => {
  it('is removed when it mixes letters and digits and is 32 characters or more', () => {
    const blob = 'Zm9vYmFy0123456789abcdefGHIJKLMNopqrstuv=='
    const out = scrubLogText(`signature ${blob} rejected`, 200)
    expect(out).toBe('signature *** rejected')
  })

  it('leaves ordinary long words, version strings and short mixed tokens alone', () => {
    for (const text of [
      'internationalizationlocalizationconfiguration failed',   // letters only
      'v1.2.3-build.45 started',
      'abc123 x9 retry',                                         // short
      '0123456789012345678901234567890123456789 count',          // digits only: the id rule has it, not the blob rule
    ]) {
      const out = scrubLogText(text, 200)
      expect(out.includes('***'), text).toBe(false)
    }
  })

  it('is not applied to the tool input summary, where a long path is legitimate', () => {
    const path = 'src/some/directory/with-a-quite-long-name-1234567890/and/more/file.ts'
    expect(scrubText(`edit ${path}`, 200)).toContain('with-a-quite-long-name-1234567890')
  })
})

describe('the long-run rule is one linear pass', () => {
  // The rule as it was before: both conditions as lookaheads in front of the run. Kept here as the reference for
  // the behaviour (which shapes become ***), not for speed.
  const REFERENCE = /(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/g

  it('stars out exactly what the lookahead form starred out', () => {
    // A small deterministic generator (no Math.random), so a failure repeats.
    let seed = 20261016
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const alphabets = ['ab', 'aB1', 'a1', 'a1+/_-=', 'abc1 ', 'a1/ .=-', '09az_-', 'Zz9+= \n']
    for (let i = 0; i < 4000; i++) {
      const alphabet = alphabets[next(alphabets.length)]
      const len = next(120)
      let text = ''
      for (let k = 0; k < len; k++) text += alphabet[next(alphabet.length)]
      expect(scrubBlobs(text), JSON.stringify(text)).toBe(text.replace(REFERENCE, '***'))
    }
  })

  it('keeps the boundary cases of the length, the padding and the two conditions', () => {
    const run = (n: number, fill = 'a1') => fill.repeat(Math.ceil(n / fill.length)).slice(0, n)
    for (const text of [
      run(31), run(32), run(33), `${run(32)}=`, `${run(32)}==`, `${run(32)}===`, `x ${run(32)}== y`,
      run(40, 'a'), run(40, '7'), `${run(31, 'a')}7`, `7${run(31, 'a')}`, `${run(20, 'a')} ${run(20, '7')}`,
      `${run(16, 'a')}/${run(16, '7')}`, `${run(40)}+${run(40)}`, '', 'x',
    ]) {
      expect(scrubBlobs(text), JSON.stringify(text)).toBe(text.replace(REFERENCE, '***'))
    }
    expect(scrubBlobs(run(32))).toBe('***')
    expect(scrubBlobs(`${run(32)}==`)).toBe('***')
    expect(scrubBlobs(run(31))).toBe(run(31))
    expect(scrubBlobs(run(40, 'a'))).toBe(run(40, 'a'))
    expect(scrubBlobs(run(40, '7'))).toBe(run(40, '7'))
  })

  it('does not slow down on a very long run that is left alone', () => {
    // 300k characters with no digit, or with no letter: the lookahead form rescanned the rest of the run from
    // every position (minutes); one pass takes a few milliseconds. The bound is loose enough for a loaded CI host.
    for (const text of ['ab/'.repeat(100_000), 'a'.repeat(300_000), '7'.repeat(300_000), 'a-b_c+d/'.repeat(40_000)]) {
      const start = performance.now()
      const out = scrubBlobs(text)
      const ms = performance.now() - start
      expect(out === text, 'left alone').toBe(true)
      expect(ms).toBeLessThan(500)
    }
  })

  it('does not slow down on a very long run that is starred out, or on many runs just under the limit', () => {
    for (const text of ['aB3'.repeat(100_000), 'aB3'.repeat(10) + ' ', `${'a1'.repeat(15)} `.repeat(20_000)]) {
      const start = performance.now()
      scrubBlobs(text)
      expect(performance.now() - start).toBeLessThan(500)
    }
  })

  it('stays quick through the log text scrub on a long slash separated message', () => {
    const start = performance.now()
    const out = scrubLogText('ab/'.repeat(100_000), 160)
    expect(performance.now() - start).toBeLessThan(500)
    expect(out).toBe('ab[path]/')
  })
})

describe('what stays readable', () => {
  it('keeps ordinary messages and the markers the earlier rules produce', () => {
    expect(scrubLogText('schedule runner started (15 s tick)', 160)).toBe('schedule runner started (15 s tick)')
    expect(scrubLogText('login with password=hunter2 failed', 160)).toBe('login with password=*** failed')
  })

  it('keeps a word that merely starts like a key prefix', () => {
    for (const text of ['sk-learn is a library', 'the ghp_ prefix is documented', 'xoxb- tokens', 'eyJ alone', 'AKIA alone']) {
      expect(scrubLogText(text, 100), text).toBe(text)
    }
  })
})
