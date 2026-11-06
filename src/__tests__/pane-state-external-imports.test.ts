// detectsExternalImportsDialog: the "Allow external CLAUDE.md file imports?" dialog of Claude Code 2.1.316.
// The fixtures are verbatim `tmux capture-pane -p` frames of an isolated session (80, 120 and 60 columns; the wrapped
// text and the middle-truncated path line depend on the width), with the box-drawing rule, the cursor marker and the
// ellipsis written as \u escapes. A tall pane pads the dialog with empty rows: every fixture carries them.

import { describe, it, expect } from 'vitest'
import { detectsExternalImportsDialog, detectsModelConsentDialog, detectsFirstRunGate, detectPaneState } from '../pane-state.js'

const RULE = (n: number) => '\u2500'.repeat(n)
const PAD = '\n'.repeat(8)

const WIDTH_80 = [
  RULE(80),
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files outside the current",
  '  working directory. Never allow this for third-party repositories.',
  '',
  '  External imports:',
  '    /private/tmp/sandbox/-home-user\u2026hpad/imports-probe/outside-persona.md',
  '',
  '  Important: Only use Claude Code with files you trust. Accessing untrusted',
  '  files may pose security risks https://code.claude.com/docs/en/security',
  '',
  '  \u276f No, disable external imports',
  '    Yes, allow external imports',
  '',
  '  Enter to confirm \u00b7 Esc to cancel',
].join('\n') + PAD

const WIDTH_120 = [
  RULE(120),
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for",
  '  third-party repositories.',
  '',
  '  External imports:',
  '    /private/tmp/sandbox/-home-user-work-agents\u2026-0123456789ab/scratchpad/imports-probe/outside-persona.md',
  '',
  '  Important: Only use Claude Code with files you trust. Accessing untrusted files may pose security risks',
  '  https://code.claude.com/docs/en/security',
  '',
  '  \u276f No, disable external imports',
  '    Yes, allow external imports',
  '',
  '  Enter to confirm \u00b7 Esc to cancel',
].join('\n') + PAD

const WIDTH_60 = [
  RULE(60),
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files",
  '  outside the current working directory. Never allow this',
  '  for third-party repositories.',
  '',
  '  External imports:',
  '    /private/tmp/sandbox/-h\u2026ts-probe/outside-persona.md',
  '',
  '  Important: Only use Claude Code with files you trust.',
  '  Accessing untrusted files may pose security risks',
  '  https://code.claude.com/docs/en/security',
  '',
  '  \u276f No, disable external imports',
  '    Yes, allow external imports',
  '',
  '  Enter to confirm \u00b7 Esc to cancel',
].join('\n') + PAD

const IDLE_FOOTER = [RULE(80), '\u276f ', RULE(80), '  ? for shortcuts'].join('\n')
const BUSY_FOOTER = ['\u2736 Working\u2026 (12s \u00b7 \u2193 1.2k tokens)', '  esc to interrupt'].join('\n')

describe('detectsExternalImportsDialog', () => {
  it.each([['80', WIDTH_80], ['120', WIDTH_120], ['60', WIDTH_60]])('the verbatim %s-column frame is the dialog (with its trailing empty rows)', (_w, frame) => {
    expect(detectsExternalImportsDialog(frame)).toBe(true)
  })

  it('the cursor on the other option is still the dialog', () => {
    const moved = WIDTH_80.replace('\u276f No, disable external imports', '  No, disable external imports').replace('    Yes, allow external imports', '\u276f Yes, allow external imports')
    expect(detectsExternalImportsDialog(moved)).toBe(true)
  })

  it('an empty or blank pane is not the dialog', () => {
    expect(detectsExternalImportsDialog('')).toBe(false)
    expect(detectsExternalImportsDialog('   \n\n')).toBe(false)
  })

  it('a busy pane is never the dialog, even with the dialog text above the spinner', () => {
    expect(detectsExternalImportsDialog(WIDTH_80.trimEnd() + '\n' + BUSY_FOOTER)).toBe(false)
  })

  it('a visible idle footer means the real prompt is live: a message that quotes the dialog is not the dialog', () => {
    const quoted = [
      '\u23fa The dialog says:',
      '  Allow external CLAUDE.md file imports?',
      '  \u276f No, disable external imports',
      '    Yes, allow external imports',
      '  Enter to confirm \u00b7 Esc to cancel',
      IDLE_FOOTER,
    ].join('\n')
    expect(detectsExternalImportsDialog(quoted)).toBe(false)
  })

  it('the confirm hint must be in the live footer region: a quote far above a long unrelated tail is not the dialog', () => {
    const tail = Array.from({ length: 14 }, (_, i) => `  unrelated output line ${i}`).join('\n')
    expect(detectsExternalImportsDialog(WIDTH_80.trimEnd() + '\n' + tail)).toBe(false)
  })

  it('a title alone, one option alone or the options without the title are not the dialog', () => {
    expect(detectsExternalImportsDialog('  Allow external CLAUDE.md file imports?\n  Enter to confirm \u00b7 Esc to cancel')).toBe(false)
    expect(detectsExternalImportsDialog('\u276f No, disable external imports\n  Yes, allow external imports\n  Enter to confirm \u00b7 Esc to cancel')).toBe(false)
    expect(detectsExternalImportsDialog(WIDTH_80.replace('Yes, allow external imports', 'Yes, allow something')) ).toBe(false)
  })

  it('does not overlap the other detectors: the model-consent dialog and the first-run gates are not the imports dialog, and the reverse', () => {
    const modelConsent = ['  Fable 5 now uses usage credits', '    1. Continue with Fable 5', '  \u276f 2. Switch to Sonnet 5 and continue', '  Enter to confirm \u00b7 Esc to cancel'].join('\n')
    expect(detectsExternalImportsDialog(modelConsent)).toBe(false)
    expect(detectsModelConsentDialog(WIDTH_80)).toBe(false)
    expect(detectsFirstRunGate(WIDTH_80)).toBeNull()
    const trustGate = ['  Do you trust the files in this folder?', '  \u276f 1. Yes, proceed', '    2. No, exit', '  Enter to confirm \u00b7 Esc to cancel'].join('\n')
    expect(detectsExternalImportsDialog(trustGate)).toBe(false)
  })

  it('the dialog frame is not an idle pane for the sender (no idle footer), so the /name gate cannot take it for the prompt', () => {
    expect(detectPaneState(WIDTH_80)).not.toBe('idle')
    expect(detectPaneState(WIDTH_120)).not.toBe('idle')
    expect(detectPaneState(WIDTH_60)).not.toBe('idle')
  })
})
