import { describe, it, expect } from 'vitest'
import { detectPaneState } from '../pane-state.js'

// A session that runs a background monitor or shell shows a footer with a count. Measured in a live
// session: `⏵⏵ bypass permissions on · 1 monitor`, with NOTHING after the count (no shift+tab hint, no
// ctrl+t / ↓ to manage / ← for agents tail). The idle-footer rule required one of those tails, so such a
// session read 'unknown' and the router would not deliver to it. These tests pin both directions: the
// tail-less shapes are idle, and prose that merely quotes a footer is not.

const RULE = '─'.repeat(150)

/** A pane: some output, the input box between two rules, then the footer lines given. */
function frame(...below: string[]): string {
  return ['', '⏺ ok', '', RULE, '❯ ', RULE, ...below].join('\n')
}

describe('idle footer with a background monitor or shell and no action hint', () => {
  it.each([
    '  ⏵⏵ bypass permissions on · 1 monitor',
    '  ⏵⏵ bypass permissions on · 2 monitors',
    '  ⏵⏵ bypass permissions on · 1 monitor · 2 monitors',
    '  ⏵⏵ accept edits on · 1 monitor',
    '  ⏸ plan mode on · 1 monitor',
    '⏵⏵ bypass permissions on · 1 monitor',
    '  ⏵⏵ bypass permissions on · 1 monitor   ',
  ])('reads idle: %j', (footer) => {
    expect(detectPaneState(frame(footer))).toBe('idle')
  })

  it('reads idle when the line ends with a carriage return (CRLF capture)', () => {
    expect(detectPaneState(frame('  ⏵⏵ bypass permissions on · 1 monitor\r'))).toBe('idle')
  })

  it('reads idle when a status line sits BELOW the footer (the footer is not always the last line)', () => {
    expect(detectPaneState(frame('  ⏵⏵ bypass permissions on · 1 monitor', '  Opus 5.5 | ctx 12% | main'))).toBe('idle')
  })

  it('reads idle when a status line sits ABOVE the footer', () => {
    expect(detectPaneState(frame('  Opus 5.5 | ctx 12% | main', '  ⏵⏵ bypass permissions on · 1 monitor'))).toBe('idle')
  })

  it('still reads busy when the spinner line is live, whatever the footer says', () => {
    const busy = ['', '✻ Cogitating… (12s · ↓ 1.2k tokens)', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · 1 monitor'].join('\n')
    expect(detectPaneState(busy)).toBe('busy')
  })
})

describe('footers that already read idle keep reading idle', () => {
  it.each([
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    '  ⏵⏵ bypass permissions on · 1 monitor · ← for agents',
    '  ⏵⏵ bypass permissions on · 1 monitor · ← for agents · ↓ to manage',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 monitor',
    '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
    '  ⏵⏵ bypass permissions on · 1 monitor · 1 shell · ↓ to manage',
    '  ⏵⏵ accept edits on (shift+tab to cycle) · 1 monitor · ← for agents',
  ])('%j', (footer) => {
    expect(detectPaneState(frame(footer))).toBe('idle')
  })
})

describe('prose that quotes the footer is NOT an idle footer', () => {
  // No real footer below the box in these panes, so the only thing that could make them idle is the quoted text.
  it.each([
    ['quoted inside a reply line', '⏺ the footer reads bypass permissions on · 1 monitor in that case'],
    ['quoted with a leading marker', '  > bypass permissions on · 1 monitor'],
    ['the footer text continues after the count', '  ⏵⏵ bypass permissions on · 1 monitor is what it printed'],
    ['no footer glyph at the line start', '  bypass permissions on · 1 monitor'],
    ['a bare shell count is a truncated frame (existing contract, pane-state.test.ts)', '  ⏵⏵ bypass permissions on · 1 shell'],
    ['a bare shell count, plural', '  ⏵⏵ bypass permissions on · 3 shells'],
    ['a monitor count followed by a bare shell count (not measured, not accepted)', '  ⏵⏵ bypass permissions on · 1 monitor · 1 shell'],
    ['count with no unit', '  ⏵⏵ bypass permissions on · 1'],
    ['unit with no count', '  ⏵⏵ bypass permissions on · monitor'],
  ])('%s', (_label, prose) => {
    const pane = ['', prose, '', RULE, '❯ ', RULE].join('\n')
    expect(detectPaneState(pane)).toBe('unknown')
  })

  it('a quoted footer in scrollback above a pane that has no footer stays unknown', () => {
    const pane = ['⏵⏵ bypass permissions on · 1 monitor was the line I meant', '', '⏺ done', RULE, '❯ ', RULE].join('\n')
    expect(detectPaneState(pane)).toBe('unknown')
  })
})
