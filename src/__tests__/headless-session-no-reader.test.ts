// Guards for the "nobody reads the tmux pane" rules: the feedback-survey modal
// is switched off at every place a claude session is launched, and the
// generated sub-agent CLAUDE.md carries the no-reader rules. Source-level on
// purpose, like agent-scaffold-claude-md-prompt.test.ts: the launch commands
// and the prompt body are strings, and a dropped export is silent at runtime.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

describe('feedback survey is disabled at every launch site', () => {
  it('sub-agent spawn command exports it and puts it in the launch command', () => {
    const src = read('src/web/agent-process-spawn.ts')
    expect(src).toContain("const surveyEnv = 'export CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 && '")
    expect(src).toMatch(/\$\{promptSuggestionEnv\}\$\{surveyEnv\}/)
  })

  it('channels.sh exports it, passes it to the channels session and sets it in the tmux global env', () => {
    const src = read('scripts/channels.sh')
    expect(src).toMatch(/^export CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1$/m)
    expect(src).toMatch(/MCP_BATCH_ENV="export [^"]*CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1/)
    expect(src).toMatch(/set-environment -g CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY 1/)
  })

  it('the watchdog respawn command carries it too', () => {
    expect(read('scripts/channel-watchdog.sh')).toMatch(/RESPAWN_CMD=.*CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1/)
  })
})

describe('generated sub-agent CLAUDE.md: no-reader rules', () => {
  const src = read('src/web/agent-scaffold-templates.ts')
  const start = src.indexOf('## Panel és döntéskérés (NINCS OLVASÓ)')
  const end = src.indexOf('## Delegálás és QA', start)
  const block = start >= 0 ? src.slice(start, end) : ''

  it('has the section, placed before the delegation section', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
  })

  it('says nobody reads the pane and to ask the coordinator through /api/messages', () => {
    expect(block).toContain('A tmux panelt senki nem olvassa')
    expect(block).toContain('/api/messages')
    expect(block).toContain('${BOT_NAME}')
  })

  it('treats a tool rejection without a human message as an interrupt, not a decision', () => {
    expect(block).toContain('emberi üzenet nélküli tool-elutasítás')
    expect(block).toContain('automatikus megszakítás')
  })

  it('forbids file paths assembled from variables', () => {
    expect(block).toContain('változóból')
    expect(block).toContain('literális utat')
  })
})
