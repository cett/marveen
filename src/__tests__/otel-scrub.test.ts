// The scrub rules shared by the input summary and the application log export (src/otel-scrub.ts): provider
// credentials in their own shape, and what must stay readable. Fixtures are assembled from parts, so no file in
// the repository holds a complete key-shaped string.

import { describe, it, expect } from 'vitest'
import { scrubText, scrubLogText } from '../otel-scrub.js'

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
