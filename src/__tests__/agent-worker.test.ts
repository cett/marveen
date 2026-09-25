import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildWorkerPrompt,
  decidePoll,
  configDirKeychainService,
  workerHomeFor,
  workerStartAllowed,
  makeWorkerCtx,
  classifyPriority,
  classifyWorkerPane,
  shouldSelfHeal,
  stampWorkerFirstRun,
  workerContexts,
} from '../web/agent-worker.js'

// Pure-logic tests for the interactive-tmux worker that backs runAgent on the
// subscription (jun.15 migration). The live-session orchestration is exercised
// by the heartbeat-path integration check; these cover the decision core.

describe('buildWorkerPrompt', () => {
  const out = '/w/scratch/abc.out'
  const done = '/w/scratch/abc.done'

  it('keeps the caller prompt verbatim and first (only content instruction)', () => {
    const caller = 'Summarize today in 5 sentences. Magyarul.'
    const p = buildWorkerPrompt(caller, out, done)
    expect(p.startsWith(caller)).toBe(true)
  })

  it('directs the answer to the .out file and a done marker to the .done file', () => {
    const p = buildWorkerPrompt('x', out, done)
    expect(p).toContain(out)
    expect(p).toContain(done)
    expect(p).toMatch(/Write tool/)
    expect(p).toMatch(/do not print the response|Do not print the response/i)
  })

  it('does not inject any persona / project voice', () => {
    const p = buildWorkerPrompt('TASK', out, done)
    expect(p).not.toMatch(/Marveen|Szabolcs|asszisztens/i)
  })
})

describe('decidePoll', () => {
  const base = { doneExists: false, sessionAlive: true, elapsedMs: 0, timeoutMs: 1000 }

  it('returns ready as soon as the done sentinel exists', () => {
    expect(decidePoll({ ...base, doneExists: true })).toBe('ready')
  })

  it('done takes priority even if the deadline passed and the session died', () => {
    // A request that completed in the same tick the session died must still
    // return its result, not be reported dead/timeout.
    expect(decidePoll({ doneExists: true, sessionAlive: false, elapsedMs: 9999, timeoutMs: 1000 })).toBe('ready')
  })

  it('times out once past the deadline (no done yet)', () => {
    expect(decidePoll({ ...base, elapsedMs: 1000 })).toBe('timeout')
    expect(decidePoll({ ...base, elapsedMs: 1500 })).toBe('timeout')
  })

  it('fails fast (dead) when the session vanishes mid-run, before the deadline', () => {
    expect(decidePoll({ ...base, sessionAlive: false, elapsedMs: 10 })).toBe('dead')
  })

  it('keeps waiting while alive, before the deadline, with no done yet', () => {
    expect(decidePoll({ ...base, elapsedMs: 500 })).toBe('wait')
  })
})

describe('configDirKeychainService', () => {
  // Locked vector: macOS Claude Code reads the OAuth token from a Keychain
  // service named "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>"
  // and it SHADOWS <CONFIG_DIR>/.credentials.json. The worker auth-recovery
  // deletes this exact entry so the freshly-seeded file becomes authoritative.
  // Verified live 2026-06-10 against the marveen-worker config dir.
  it('derives the sha256[0:8] service suffix (verified live vector)', () => {
    expect(configDirKeychainService('/Users/marvin/.marveen-worker/.claude-config'))
      .toBe('Claude Code-credentials-1d2e1367')
  })

  it('is path-specific: a different config dir hashes to a different service', () => {
    const a = configDirKeychainService('/Users/marvin/.marveen-worker/.claude-config')
    const b = configDirKeychainService('/tmp/some-other-config')
    expect(a).not.toBe(b)
    expect(b.startsWith('Claude Code-credentials-')).toBe(true)
  })
})

describe('workerHomeFor (WORKERHOME1: worker home derives from MAIN_AGENT_ID)', () => {
  it('default install keeps the historical paths -- zero migration, unchanged Keychain hash', () => {
    expect(workerHomeFor('marveen', 'slow').endsWith('/.marveen-worker')).toBe(true)
    expect(workerHomeFor('marveen', 'fast').endsWith('/.marveen-worker-fast')).toBe(true)
  })
  it('a non-default id derives its own isolated dirs (sandbox/renamed install)', () => {
    expect(workerHomeFor('agent-a', 'slow').endsWith('/.agent-a-worker')).toBe(true)
    expect(workerHomeFor('agent-a', 'fast').endsWith('/.agent-a-worker-fast')).toBe(true)
  })
  it('never collides with the default install dir for a different id', () => {
    expect(workerHomeFor('agent-b', 'slow')).not.toBe(workerHomeFor('marveen', 'slow'))
    expect(workerHomeFor('agent-b', 'fast')).not.toBe(workerHomeFor('marveen', 'fast'))
  })
  it('slow and fast variants of the same id never share a home', () => {
    expect(workerHomeFor('marveen', 'slow')).not.toBe(workerHomeFor('marveen', 'fast'))
  })
})

describe('workerStartAllowed (WORKERHOME1: WEB_ONLY must suppress every worker start)', () => {
  it('blocks in WEB_ONLY staging', () => {
    expect(workerStartAllowed({ WEB_ONLY: 'true' })).toBe(false)
  })
  it('allows on a normal install (unset or explicit false)', () => {
    expect(workerStartAllowed({})).toBe(true)
    expect(workerStartAllowed({ WEB_ONLY: 'false' })).toBe(true)
    expect(workerStartAllowed({ WEB_ONLY: '' })).toBe(true)
  })
  // String-contract wiring guard (house idiom: the pure predicate alone cannot
  // prove the choke points consult it). Every function that creates, kills or
  // configures a live worker session must check the gate: the lazy-start path
  // (startWorkerSessionFor covers ensureWorkerCwd + tmux new-session), the
  // readiness poll (ensureWorkerReady would otherwise spin 90s then page the
  // LIVE channel via alertWorkerStuck from a staging instance) and the restart
  // path (kill-session against a live worker). This is exactly how the
  // 2026-07-28 sandbox boot wrote into the live worker config dir.
  it('the three session-lifecycle choke points are wired to the gate', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(__dirname, '../web/agent-worker.ts'), 'utf-8')
    const gated = (fnName: string) => {
      const start = src.indexOf(`function ${fnName}(`)
      expect(start, `${fnName} not found`).toBeGreaterThan(-1)
      const body = src.slice(start, start + 700)
      return body.includes('workerStartAllowed()')
    }
    expect(gated('startWorkerSessionFor')).toBe(true)
    expect(gated('ensureWorkerReady')).toBe(true)
    expect(gated('restartWorkerSession')).toBe(true)
  })
  // The worker launch line must invoke claude by RESOLVED path, never by bare
  // name: `bash -lc` login shells on stock Debian/Ubuntu roots lack
  // ~/.local/bin (the native installer target), which killed the worker within
  // seconds of every boot on such installs (vps47 cold-start probe, WORKERHOME1).
  it('the tmux launch line resolves the claude binary instead of relying on login-shell PATH', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(__dirname, '../web/agent-worker.ts'), 'utf-8')
    expect(src).toContain("tryResolveFromPath('claude')")
    expect(src).not.toMatch(/`claude --dangerously-skip-permissions/)
  })
})

describe('makeWorkerCtx', () => {
  it('derives configDir and scratchDir from the given home, and seeds a fresh, unlocked chain', () => {
    const ctx = makeWorkerCtx('some-session', '/home/x/.some-worker')
    expect(ctx.session).toBe('some-session')
    expect(ctx.home).toBe('/home/x/.some-worker')
    expect(ctx.configDir).toBe(join('/home/x/.some-worker', '.claude-config'))
    expect(ctx.scratchDir).toBe(join('/home/x/.some-worker', 'scratch'))
    expect(ctx.lastStuckAlert).toBe(0)
  })

  it('two contexts for different homes never share configDir/scratchDir', () => {
    const a = makeWorkerCtx('a', '/home/a')
    const b = makeWorkerCtx('b', '/home/b')
    expect(a.configDir).not.toBe(b.configDir)
    expect(a.scratchDir).not.toBe(b.scratchDir)
  })
})

describe('classifyPriority (fast vs slow worker routing)', () => {
  it('routes a short, plain message to fast', () => {
    expect(classifyPriority('szia, mi ujsag?')).toBe('fast')
  })

  it('routes a message at/over the length cutoff to slow, regardless of content', () => {
    const long = 'x'.repeat(300)
    expect(classifyPriority(long)).toBe('slow')
    expect(classifyPriority('x'.repeat(299))).toBe('fast')
  })

  it('routes on an analysis/search keyword even when short (HU)', () => {
    expect(classifyPriority('elemezd ezt')).toBe('slow')
    expect(classifyPriority('keresd meg a fajlt')).toBe('slow')
  })

  it('routes on an analysis/search keyword even when short (EN), case-insensitively', () => {
    expect(classifyPriority('please Analyze this')).toBe('slow')
    expect(classifyPriority('SEARCH for it')).toBe('slow')
  })

  it('a keyword match still wins even right at the fast length boundary', () => {
    expect(classifyPriority('summary please')).toBe('slow')
  })
})

describe('classifyWorkerPane', () => {
  const SEP = '─'.repeat(80)

  it('null or blank pane is empty (still booting)', () => {
    expect(classifyWorkerPane(null)).toBe('empty')
    expect(classifyWorkerPane('')).toBe('empty')
    expect(classifyWorkerPane('   \n  ')).toBe('empty')
  })

  it('a healthy idle footer classifies idle', () => {
    const pane = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(classifyWorkerPane(pane)).toBe('idle')
  })

  it('a live spinner + esc-to-interrupt footer classifies busy, never a self-heal target', () => {
    const pane = [
      '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
      '', SEP, '❯ ', SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(classifyWorkerPane(pane)).toBe('busy')
  })

  it('auth-failure chrome in the tail classifies auth (handled by auth recovery, not self-heal)', () => {
    const pane = ['some earlier scrollback', '', 'Invalid bearer token', 'Please run /login'].join('\n')
    expect(classifyWorkerPane(pane)).toBe('auth')
  })

  it('a confirm/option-list dialog with no idle footer classifies modal', () => {
    const pane = ['Trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No', 'Enter to confirm · Esc to cancel'].join('\n')
    expect(classifyWorkerPane(pane)).toBe('modal')
  })

  it('unrecognised full-screen chrome (no footer, no modal markers) classifies unknown', () => {
    const pane = ['Some unrecognised future dialog text', 'with no known markers at all'].join('\n')
    expect(classifyWorkerPane(pane)).toBe('unknown')
  })
})

describe('shouldSelfHeal', () => {
  it('targets modal and unknown pane classes for self-heal', () => {
    expect(shouldSelfHeal('modal')).toBe(true)
    expect(shouldSelfHeal('unknown')).toBe(true)
  })

  it('never self-heals idle, busy, auth or empty (auth has its own recovery path)', () => {
    expect(shouldSelfHeal('idle')).toBe(false)
    expect(shouldSelfHeal('busy')).toBe(false)
    expect(shouldSelfHeal('auth')).toBe(false)
    expect(shouldSelfHeal('empty')).toBe(false)
  })
})

describe('stampWorkerFirstRun', () => {
  it('marks onboarding complete and sets the upsell-seen counter past the threshold', () => {
    const parsed: { hasCompletedOnboarding?: boolean; fullscreenUpsellSeenCount?: unknown } = {}
    stampWorkerFirstRun(parsed)
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.fullscreenUpsellSeenCount).toBe(99)
  })

  it('never lowers an already-higher seen-count (idempotent, monotonic)', () => {
    const parsed = { fullscreenUpsellSeenCount: 500 }
    stampWorkerFirstRun(parsed)
    expect(parsed.fullscreenUpsellSeenCount).toBe(500)
  })

  it('treats a non-numeric / missing counter as unseen, clamping to 99', () => {
    const parsed = { fullscreenUpsellSeenCount: 'not-a-number' as unknown }
    stampWorkerFirstRun(parsed)
    expect(parsed.fullscreenUpsellSeenCount).toBe(99)
  })

  it('preserves unrelated keys on the parsed settings object', () => {
    const parsed: Record<string, unknown> = { someOtherKey: 'kept' }
    stampWorkerFirstRun(parsed)
    expect(parsed.someOtherKey).toBe('kept')
  })
})

describe('workerContexts', () => {
  it('returns exactly the slow and fast contexts, with distinct sessions and homes', () => {
    const ctxs = workerContexts()
    expect(ctxs).toHaveLength(2)
    const [slow, fast] = ctxs
    expect(slow.session).not.toBe(fast.session)
    expect(slow.home).not.toBe(fast.home)
    expect(slow.configDir).not.toBe(fast.configDir)
  })

  it('is stable across calls (same underlying contexts, not freshly rebuilt)', () => {
    const [a] = workerContexts()
    const [b] = workerContexts()
    expect(a).toBe(b)
  })
})
