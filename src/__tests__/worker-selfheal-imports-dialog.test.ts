// The worker boot self-heal sends a bounded Escape to a pane parked on "modal" chrome and restarts the session if that
// does not clear it. On the external CLAUDE.md imports dialog the Escape picks the highlighted "No" (an explicit
// refusal of the persona imports) and the restart only respawns into the same dialog, so that dialog must classify
// apart from 'modal' and never be a self-heal target. Measured before the fix on the verbatim 80-column frame, padded
// or not: classifyWorkerPane -> 'modal', shouldSelfHeal -> true (Escape sent).
// The fixtures are verbatim `tmux capture-pane -p` frames (80 and 60 columns), box rule / cursor / ellipsis as \u escapes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classifyWorkerPane, shouldSelfHeal } from '../web/agent-worker.js'

const RULE = (n: number) => '─'.repeat(n)

const WIDTH_80 = [
  RULE(80),
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files outside the current",
  '  working directory. Never allow this for third-party repositories.',
  '',
  '  External imports:',
  '    /private/tmp/sandbox/-home-user…hpad/imports-probe/outside-persona.md',
  '',
  '  Important: Only use Claude Code with files you trust. Accessing untrusted',
  '  files may pose security risks https://code.claude.com/docs/en/security',
  '',
  '  ❯ No, disable external imports',
  '    Yes, allow external imports',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n')

const WIDTH_60 = [
  RULE(60),
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files",
  '  outside the current working directory. Never allow this',
  '  for third-party repositories.',
  '',
  '  External imports:',
  '    /private/tmp/sandbox/-h…ts-probe/outside-persona.md',
  '',
  '  Important: Only use Claude Code with files you trust.',
  '  Accessing untrusted files may pose security risks',
  '  https://code.claude.com/docs/en/security',
  '',
  '  ❯ No, disable external imports',
  '    Yes, allow external imports',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n')

const FRAMES: Array<[string, string]> = [
  ['80 unpadded', WIDTH_80],
  ['80 padded (8 empty rows)', WIDTH_80 + '\n'.repeat(8)],
  ['80 tall (30 empty rows)', WIDTH_80 + '\n'.repeat(30)],
  ['60 unpadded', WIDTH_60],
  ['60 padded (8 empty rows)', WIDTH_60 + '\n'.repeat(8)],
]

describe('worker pane classification of the external imports dialog', () => {
  it.each(FRAMES)('%s is imports-dialog, never modal, and not a self-heal target', (_n, frame) => {
    const cls = classifyWorkerPane(frame)
    expect(cls).toBe('imports-dialog')
    expect(shouldSelfHeal(cls)).toBe(false)
  })

  it('the other modal chrome is unchanged: a generic option-list dialog is still modal and healed', () => {
    const FULLSCREEN = ['  Try the new fullscreen renderer?', '', '  ❯ 1. Yes, try it', '    2. Not now', '', '  Enter to confirm · Esc to cancel'].join('\n')
    expect(classifyWorkerPane(FULLSCREEN)).toBe('modal')
    expect(shouldSelfHeal('modal')).toBe(true)
  })

  it('a live turn or a healthy prompt quoting the dialog text is not the dialog', () => {
    const idle = [RULE(80), '❯ ', RULE(80), '  ? for shortcuts'].join('\n')
    const busy = ['✶ Working… (12s · ↓ 1.2k tokens)', '  esc to interrupt'].join('\n')
    expect(classifyWorkerPane(WIDTH_80 + '\n' + idle)).toBe('idle')
    expect(classifyWorkerPane(WIDTH_80 + '\n' + busy)).toBe('busy')
  })

  it('imports-dialog is never in the self-heal set', () => {
    expect(shouldSelfHeal('imports-dialog')).toBe(false)
  })
})

// selfHealWorkerOnce talks to tmux directly and is not exported, so the structural fact is read from the source: the
// imports-dialog branch returns before any key is sent and before the restart.
describe('selfHealWorkerOnce on the imports dialog (structure)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'agent-worker.ts'), 'utf-8')
  const start = src.indexOf('function selfHealWorkerOnce')
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end)

  it('handles imports-dialog first and returns before the Escape loop and the restart', () => {
    expect(start).toBeGreaterThan(0)
    const branch = body.indexOf("cls === 'imports-dialog'")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(body.indexOf('send-keys'))
    expect(branch).toBeLessThan(body.indexOf('restartWorkerSession'))
    const branchBody = body.slice(branch, body.indexOf('shouldSelfHeal(cls)'))
    expect(branchBody).toContain('alertWorkerImportsDialog(ctx)')
    expect(branchBody).toContain('return false')
    expect(branchBody).not.toMatch(/send-keys|restartWorkerSession|execFileSync/)
  })
})
