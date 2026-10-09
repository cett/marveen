import { describe, it, expect } from 'vitest'
import { decideMenuRecoveryAction, detectsApprovalPrompt, detectsBlockingMenu } from '../pane-state.js'

// A Bash tool-approval prompt as Claude Code renders it. The footer reads
// "Esc to cancel", so detectsBlockingMenu matches it -- but Escape on it is the
// "No" answer and rejects the pending tool call.
const BASH_APPROVAL = [
  ' Bash command',
  '',
  '   cd $S && python3 -I build.py',
  '   Build the payloads',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for python3 commands in /work",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

const EDIT_APPROVAL = [
  ' Edit file',
  ' src/web/foo.ts',
  '',
  ' Do you want to make this edit to foo.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel',
].join('\n')

// The real stuck-menu cases the Escape recovery exists for.
const MCP_MENU = [
  '   Manage MCP servers',
  '   5 servers',
  '',
  '   ❯ claude.ai Canva · ✔ connected · 39 tools',
  '',
  '   ↑/↓ to navigate · Enter to confirm · Esc to cancel',
].join('\n')

const MODEL_CONSENT = [
  '  Fable 5 now uses usage credits',
  '',
  '    1. Continue with Fable 5',
  '  ❯ 2. Switch to Sonnet 5 and continue',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n')

const SEP = '─'.repeat(40)
const IDLE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

describe('detectsApprovalPrompt', () => {
  it('detects the Bash approval prompt', () => {
    expect(detectsApprovalPrompt(BASH_APPROVAL)).toBe(true)
  })

  it('detects an edit approval prompt', () => {
    expect(detectsApprovalPrompt(EDIT_APPROVAL)).toBe(true)
  })

  it('is false for the /mcp menu and the model-consent dialog', () => {
    expect(detectsApprovalPrompt(MCP_MENU)).toBe(false)
    expect(detectsApprovalPrompt(MODEL_CONSENT)).toBe(false)
  })

  it('is false for an idle prompt and an empty pane', () => {
    expect(detectsApprovalPrompt(IDLE)).toBe(false)
    expect(detectsApprovalPrompt('')).toBe(false)
  })

  it('does not trigger on prose quoting the question far above a live prompt', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `  line ${i}`).join('\n')
    const quoted = ['  Do you want to proceed?', '  1. Yes', '  2. No', filler, IDLE].join('\n')
    expect(detectsApprovalPrompt(quoted)).toBe(false)
  })

  it('needs the numbered Yes option, not just the question', () => {
    const noOptions = [' Do you want to proceed?', '', ' Esc to cancel'].join('\n')
    expect(detectsApprovalPrompt(noOptions)).toBe(false)
  })

  it('is false while a tool is running (esc to interrupt in the footer)', () => {
    const running = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' esc to interrupt'].join('\n')
    expect(detectsApprovalPrompt(running)).toBe(false)
  })
})

describe('decideMenuRecoveryAction', () => {
  it('never sends Escape for an approval prompt, only alerts', () => {
    // Guards the precondition: the blocking-menu detector DOES match it.
    expect(detectsBlockingMenu(BASH_APPROVAL)).toBe(true)
    expect(decideMenuRecoveryAction(BASH_APPROVAL)).toBe('alert-approval')
    expect(decideMenuRecoveryAction(EDIT_APPROVAL)).toBe('alert-approval')
  })

  it('still sends Escape for a genuine stuck menu', () => {
    expect(decideMenuRecoveryAction(MCP_MENU)).toBe('escape')
  })

  it('answers the model-consent dialog instead of Escape', () => {
    expect(decideMenuRecoveryAction(MODEL_CONSENT)).toBe('answer-model-consent')
  })

  it('sends nothing when the menu is gone, the pane is idle, or the capture failed', () => {
    expect(decideMenuRecoveryAction(IDLE)).toBe('none')
    expect(decideMenuRecoveryAction('')).toBe('none')
    expect(decideMenuRecoveryAction(null)).toBe('none')
  })
})
