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

describe('no-reader rules block (single source of truth)', () => {
  const src = read('src/web/agent-scaffold-templates.ts')

  it('is appended to a generated CLAUDE.md as a marker block, not left to the model', () => {
    expect(src).toMatch(/NO_READER_BEGIN \+ '\\n' \+ buildNoReaderBody\(\) \+ '\\n' \+ NO_READER_END/)
    // the LLM prompt no longer carries a hand-copied version of the section
    const promptStart = src.indexOf('export async function generateClaudeMd')
    const promptEnd = src.indexOf('Output ONLY the markdown content', promptStart)
    expect(src.slice(promptStart, promptEnd)).not.toContain('NINCS OLVASÓ')
  })

  it('is ensured on every sub-agent respawn', () => {
    const spawn = read('src/web/agent-process-spawn.ts')
    expect(spawn).toContain('ensureNoReaderSection(name)')
  })
})
