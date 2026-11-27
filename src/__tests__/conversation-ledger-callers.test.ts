import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// recentLedgerTurns and openLedgerQuestion run in the named `ledger-read` system context and do not authorise their `agentId`: the
// CALLER does (the route: a registered agent, the caller's own token or an admin token, before the call). They are safe only for as
// long as the route is the only caller. A second caller is a new unauthorised read of one agent's chats, so it fails here and has
// to be decided: authorise before the call, and add the file to the list below with the reason.

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function productionFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'generated' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...productionFiles(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const CALL = /\b(recentLedgerTurns|openLedgerQuestion)\(/
const ALLOWED = [
  'db/conversation-ledger.ts', // the definitions
  'web/routes/conversation-ledger.ts', // authorises (denyForeignAgent, registered agent) before the call
]

describe('callers of the ledger read functions', () => {
  it('only the definitions and the authorising route call them', () => {
    const callers = productionFiles(srcDir).filter((f) => CALL.test(readFileSync(f, 'utf8'))).map((f) => relative(srcDir, f)).sort()
    expect(callers).toEqual([...ALLOWED].sort())
  })

  it('the route authorises the agent BEFORE it reads (the foreign-agent refusal and the registered check come first in the source)', () => {
    const src = readFileSync(join(srcDir, 'web/routes/conversation-ledger.ts'), 'utf8')
    const deny = src.indexOf('denyForeignAgent(ctx, agentId)')
    const registered = src.indexOf('!isRegisteredLedgerAgent(agentId)', deny)
    const read = src.indexOf('await recentLedgerTurns(')
    const open = src.indexOf('await openLedgerQuestion(')
    expect(deny).toBeGreaterThan(-1)
    expect(registered).toBeGreaterThan(deny)
    expect(read).toBeGreaterThan(registered)
    expect(open).toBeGreaterThan(registered)
  })
})
