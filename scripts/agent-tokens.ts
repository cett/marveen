#!/usr/bin/env tsx
// Per-agent API token administration (operator, on the machine that hosts the install).
//
//   npm run agent-tokens -- issue [--rotate] [--dry-run] [<agent>...]   # default: the main agent and every agent
//   npm run agent-tokens -- issue-operator [--rotate]
//   npm run agent-tokens -- list
//   npm run agent-tokens -- revoke <agent>
//
// It talks to SQLite directly (like dashboard-user.ts), so it works with the dashboard stopped. The
// token files are written 0600 next to each agent's files; this command prints the agent, what
// happened and the FILE, never a token.

import { MAIN_AGENT_ID } from '../src/config.js'
import { initDatabase, listApiTokenRows, revokeApiTokensForAgent } from '../src/db.js'
import { listAgentNames } from '../src/web/agent-config.js'
import { agentTokenPath, issueAgentToken, issueOperatorToken } from '../src/agent-tokens.js'

function usage(): never {
  process.stderr.write(
    'Usage:\n' +
    '  agent-tokens issue [--rotate] [--dry-run] [<agent>...]\n' +
    '  agent-tokens issue-operator [--rotate]\n' +
    '  agent-tokens list\n' +
    '  agent-tokens revoke <agent>\n',
  )
  process.exit(2)
}

const [cmd, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter(a => a.startsWith('--')))
const names = rest.filter(a => !a.startsWith('--'))

initDatabase()

if (cmd === 'issue') {
  const rotate = flags.has('--rotate')
  const targets = names.length > 0 ? names : [MAIN_AGENT_ID, ...listAgentNames().filter(n => n !== MAIN_AGENT_ID)]
  let failed = 0
  for (const agent of targets) {
    if (flags.has('--dry-run')) {
      process.stdout.write(`${agent}\twould ${rotate ? 'rotate' : 'issue or keep'}\t${agentTokenPath(agent)}\n`)
      continue
    }
    try {
      const r = issueAgentToken(agent, { rotate })
      process.stdout.write(`${r.subject}\t${r.status}\t${r.role}\t${r.path}\n`)
    } catch (err) {
      failed++
      process.stderr.write(`${agent}\tFAILED\t${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  process.exit(failed > 0 ? 1 : 0)
} else if (cmd === 'issue-operator') {
  const r = issueOperatorToken({ rotate: flags.has('--rotate') })
  process.stdout.write(`${r.subject}\t${r.status}\t${r.role}\t${r.path}\n`)
} else if (cmd === 'list') {
  for (const t of listApiTokenRows().filter(r => r.revoked_at === null)) {
    process.stdout.write(`${t.id}\t${t.name}\t${t.role}\t${t.agent_id ?? '-'}\t${t.tenant_id}\t${new Date(t.created_at * 1000).toISOString()}\n`)
  }
} else if (cmd === 'revoke' && names.length === 1) {
  process.stdout.write(`revoked ${revokeApiTokensForAgent(names[0]!, Math.floor(Date.now() / 1000))} token(s) of ${names[0]}\n`)
} else {
  usage()
}
