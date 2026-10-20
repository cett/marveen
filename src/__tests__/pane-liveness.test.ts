// A tmux session that still exists is not proof that an agent lives in it. When the Claude CLI exits, tmux keeps the
// session alive with a bare shell prompt in the pane: list-sessions still lists it, so the run state says 'running' and
// the dashboard would show a perfectly idle agent that will never answer.
//
// The positive signal is the pane's FOREGROUND COMMAND: the CLI binary on a healthy agent, the shell's name on a
// session with no CLI in it. These tests pin that reading and, more importantly, the conjunction that keeps it honest:
// a shell reading alone never means dead while the pane still shows work in progress.

import { describe, it, expect } from 'vitest'
import { classifyPaneLiveness, activityState } from '../web/pane-liveness.js'
import { detectPaneState } from '../pane-state.js'

const SEP = '─'.repeat(40)
const IDLE_PANE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

describe('classifyPaneLiveness', () => {
  it('reads the CLI binary as alive', () => {
    expect(classifyPaneLiveness('claude.exe')).toBe('alive')
  })

  it('reads every common shell as a dead pane, a login shell with its leading dash too', () => {
    for (const shell of ['bash', 'zsh', 'sh', 'fish', 'ksh', 'dash', 'tcsh', 'csh', 'login', '-zsh', '-bash']) {
      expect(classifyPaneLiveness(shell)).toBe('dead-shell')
    }
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(classifyPaneLiveness('ZSH')).toBe('dead-shell')
    expect(classifyPaneLiveness('  zsh \n')).toBe('dead-shell')
  })

  it('calls any other foreground process alive: an unknown process is still a process', () => {
    expect(classifyPaneLiveness('node')).toBe('alive')
    expect(classifyPaneLiveness('claude')).toBe('alive')
    expect(classifyPaneLiveness('bashful')).toBe('alive') // a prefix of a shell name is not a shell
  })

  it('reports unknown when tmux gave nothing', () => {
    expect(classifyPaneLiveness(null)).toBe('unknown')
    expect(classifyPaneLiveness('')).toBe('unknown')
    expect(classifyPaneLiveness('   ')).toBe('unknown')
  })
})

describe('activityState', () => {
  it('a session that is not running is stopped, whatever the pane says', () => {
    expect(activityState({ running: false, pane: BUSY_PANE, paneCommand: 'claude.exe' })).toBe('stopped')
    expect(activityState({ running: false, pane: null, paneCommand: 'zsh' })).toBe('stopped')
  })

  it('names the failure this exists for: session alive, CLI gone, pane idle', () => {
    expect(activityState({ running: true, pane: IDLE_PANE, paneCommand: 'bash' })).toBe('dead')
  })

  it('does NOT call it dead while the pane still shows work in progress', () => {
    // pane_current_command follows whatever owns the terminal right now; a working pane outranks the reading, so no
    // future build can turn a busy agent into a corpse.
    expect(activityState({ running: true, pane: BUSY_PANE, paneCommand: 'bash' })).toBe('working')
  })

  it('a pane with text being typed is working too, so a shell reading cannot make it dead', () => {
    const typing = ['', SEP, '❯ draft of the next prompt', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(detectPaneState(typing)).toBe('typing') // the premise: this fixture really is the typing state
    expect(activityState({ running: true, pane: typing, paneCommand: 'zsh' })).toBe('working')
    expect(activityState({ running: true, pane: typing, paneCommand: 'claude.exe' })).toBe('working')
  })

  it('keeps a live CLI on an empty prompt as idle, not dead', () => {
    expect(activityState({ running: true, pane: IDLE_PANE, paneCommand: 'claude.exe' })).toBe('idle')
  })

  it('falls back to the pane text alone when no foreground command is known (a remote session): never dead', () => {
    expect(activityState({ running: true, pane: IDLE_PANE, paneCommand: null })).toBe('idle')
    expect(activityState({ running: true, pane: BUSY_PANE, paneCommand: null })).toBe('working')
  })

  it('reports unknown when there is no pane to read and the command does not say shell', () => {
    expect(activityState({ running: true, pane: null, paneCommand: 'claude.exe' })).toBe('unknown')
    expect(activityState({ running: true, pane: null, paneCommand: null })).toBe('unknown')
  })

  it('calls a shell with leftover output dead even when that output reads as unknown', () => {
    expect(activityState({ running: true, pane: 'zsh: command not found: claudee', paneCommand: 'zsh' })).toBe('dead')
  })

  it('passes the other pane states through unchanged', () => {
    expect(activityState({ running: true, pane: 'some unrecognised output', paneCommand: 'claude.exe' })).toBe('unknown')
  })
})
