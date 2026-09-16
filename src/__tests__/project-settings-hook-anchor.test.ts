// #1305 (ISSUE1305HOOKSCOPE): the tracked .claude/settings.json is the
// AUTHORITATIVE registration surface for the main agent's fleet hooks. The
// scaffold refuses to write them anywhere else (hook-scope-main-refusal
// pins that), so if an entry silently falls out of this file, nothing
// re-adds it -- the hook just stops firing. This anchor makes such a drop
// loud: the full expected set is spelled out, per event.
//
// Portability is part of the contract: every command must resolve through
// $CLAUDE_PROJECT_DIR (the file ships to every install), and the WebFetch
// egress gate must keep its fail-CLOSED preamble -- the user-global variant
// pinned a machine-local node path, which is exactly what broke in the
// owner's own sessions (#1305) and what a "simplifying" edit would
// reintroduce.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SETTINGS_PATH = join(ROOT, '.claude', 'settings.json')

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }
type Hooks = Record<string, HookEntry[]>

const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as { hooks?: Hooks }
const hooks: Hooks = settings.hooks ?? {}

// The full expected registration: event -> script basenames (order-free).
// A change here is a REVIEWED decision about what runs in the main session,
// never a side effect.
// Fork deviation from upstream (#885 B3 review, Rick + Zack, kanban 1a512e21):
// claude-usage.py, telegram-reply-directive.py, provenance-gate.py,
// clear-replay.py and clear-capture.py (SessionEnd) don't exist as scripts on
// this fork -- registering them would fail-closed every prompt/session event.
// Excluded here on purpose; do not "complete" this list without adding the
// matching scripts/hooks/*.py files first.
const EXPECTED: Record<string, string[]> = {
  UserPromptSubmit: [
    'ledger-capture.py', 'inbox-drain.py',
    'staleness-guard.py', 'channel-inbox-drain.py',
    'voice-reply-directive.py', 'telegram_progress.py',
  ],
  PostToolUse: [
    'ledger-outbound.py', 'post-tool-injection-gate.py', 'tool-log-capture.py',
    'context-watchdog.py', 'artifact-store-sync.py', 'skill-sql-sync.py',
    'telegram_progress_reply_clear.py', 'skill-usage-capture.py',
  ],
  PreToolUse: [
    'channel-image-resize.sh', 'egress-gate.mjs',
  ],
  Stop: ['telegram_progress_clear.py'],
  SessionStart: ['ledger-replay.py', 'taskstate-replay.py'],
}

function commands(event: string): string[] {
  return (hooks[event] ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command ?? '')
}

function scriptNames(event: string): Set<string> {
  return new Set(
    commands(event)
      .map((c) => c.match(/scripts\/hooks\/([^/\s'"]+?\.(?:py|sh|mjs))/)?.[1] ?? '')
      .filter(Boolean),
  )
}

describe('tracked .claude/settings.json hook anchor (#1305)', () => {
  it('registers exactly the expected script set per event', () => {
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const [event, expected] of Object.entries(EXPECTED)) {
      expect([...scriptNames(event)].sort(), `event ${event}`).toEqual([...new Set(expected)].sort())
    }
  })

  it('every referenced script exists in scripts/hooks/', () => {
    for (const event of Object.keys(EXPECTED)) {
      for (const name of scriptNames(event)) {
        expect(existsSync(join(ROOT, 'scripts', 'hooks', name)), `missing scripts/hooks/${name}`).toBe(true)
      }
    }
  })

  it('every command is portable: $CLAUDE_PROJECT_DIR, no machine-local paths', () => {
    for (const event of Object.keys(hooks)) {
      for (const cmd of commands(event)) {
        expect(cmd, `event ${event}`).toContain('$CLAUDE_PROJECT_DIR')
        expect(cmd).not.toMatch(/\/(Users|home|opt|var)\//)
      }
    }
  })

  it('the WebFetch egress gate keeps its fail-closed preamble', () => {
    const webfetch = (hooks.PreToolUse ?? []).filter((e) => e.matcher === 'WebFetch')
    expect(webfetch).toHaveLength(1)
    const cmd = webfetch[0].hooks?.[0]?.command ?? ''
    // No node -> BLOCK (exit 2), never fail-open silence.
    expect(cmd).toMatch(/command -v node[^;]*\|\|\s*\{[^}]*exit 2/)
    expect(cmd).toContain('egress-gate.mjs')
  })
})
