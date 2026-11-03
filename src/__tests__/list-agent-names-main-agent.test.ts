import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'list-agent-names-'))
})

vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
  MAIN_AGENT_ID: 'chief',
}))

import { listAgentNames, listAllAgentNames, HIDDEN_AGENT_SENTINEL } from '../web/agent-config.js'

// The overview built its agent grid as [main, ...listAgentNames()] and marked a sub-agent "not running" when its
// agent-<name> tmux session was absent. An agents/<main> directory (a leftover .claude / agent-config.json) made
// the running main agent appear a second time, as a stopped sub-agent: "1 ágens nem fut (Jarvis)".
describe('listAgentNames never lists the main agent', () => {
  const base = join(tmpRoot, 'agents')
  mkdirSync(join(base, 'chief', '.claude'), { recursive: true })
  writeFileSync(join(base, 'chief', 'agent-config.json'), '{}')
  mkdirSync(join(base, 'alpha'), { recursive: true })
  mkdirSync(join(base, 'beta'), { recursive: true })
  mkdirSync(join(base, 'worker'), { recursive: true })
  writeFileSync(join(base, 'worker', HIDDEN_AGENT_SENTINEL), '')
  writeFileSync(join(base, 'stray-file.txt'), 'x')

  it('lists the sub-agent directories only: not the main agent, a hidden worker or a plain file', () => {
    expect(listAgentNames().sort()).toEqual(['alpha', 'beta'])
  })

  it('an agent whose name merely contains the main id stays listed', () => {
    mkdirSync(join(base, 'chief-assistant'), { recursive: true })
    mkdirSync(join(base, 'subchief'), { recursive: true })
    expect(listAgentNames().sort()).toEqual(['alpha', 'beta', 'chief-assistant', 'subchief'])
  })

  it('listAllAgentNames is unchanged: it still reads every directory (the context guard needs hidden workers)', () => {
    const all = listAllAgentNames()
    expect(all).toContain('chief')
    expect(all).toContain('worker')
  })

  it('the overview grid built from [main, ...listAgentNames()] has the main agent exactly once', () => {
    const grid = ['chief', ...listAgentNames()]
    expect(grid.filter((n) => n === 'chief')).toHaveLength(1)
  })
})
