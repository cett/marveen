// Per-agent API token administration, the body of scripts/agent-tokens.ts (the machine owner's command).
//
//   npm run agent-tokens -- issue [--rotate] [--dry-run] [<agent>...]   # default: the main agent and every agent
//   npm run agent-tokens -- issue-operator [--rotate]
//   npm run agent-tokens -- rotate-shared                               # new shared dashboard token; refuses when DASHBOARD_TOKEN is set
//   npm run agent-tokens -- check [<agent>...]                          # read-only; exit 1 if any file is not ok
//   npm run agent-tokens -- archive-shared-age <extracted-archive.db>   # read-only; predates | current | unknown
//   npm run agent-tokens -- list
//   npm run agent-tokens -- revoke <agent>
//
// It talks to the database of this install directly (SQLite, or PostgreSQL when MARVEEN_PG_URL is set), so it works with
// the dashboard stopped. The token files are written 0600 next to each agent's files; this command prints the agent, what
// happened and the FILE, never a token (not on stdout, not on stderr, not in the log line, not in an error).
//
//   PostgreSQL  bootPgBackend({ migrateUrl: '' }): the serving pool on the application role, no migrate URL, so no DDL from
//               this process and the owner credential is never read here (the same boot as the dashboard-user CLI).
//   SQLite      otherwise: the unchanged initDatabase() chain.
//
// The whole command runs inside the system job `agent-tokens-cli`. api_tokens is row-level-security class A (the context
// tenant, or a privileged role), so a run without that context sees ZERO rows, and for `issue` that is destructive, not
// just misleading: issue() writes the token FILE first and the row second. A blind `issue` finds no active row, overwrites
// the file with a new value, and the insert is then refused: the old row stays active, the file holds a token nothing
// recognises, and the agent is locked out. The job is opened before the first command touches anything, and the info line
// on stderr (backend, command, active rows seen) separates "ran and saw N" from "ran blind".
//
// A run that sees 0 active rows is NOT special-cased: a fresh install legitimately has none before the first dashboard
// boot (the dashboard enrols its own `dashboard` row then), and `issue` is allowed to be the first writer there. The count
// is on the line so the operator can tell.
//
// This module is one of the legitimate writers of api_tokens. It runs no command in a tenant context; the narrow
// token-writer context (a later phase) will replace the broad system job here, not the other way round.
//
// The script loads the config snapshot before it imports this module (config.ts reads it at import). A failure is never
// thrown to the caller: it is printed, and the exit code says what happened: 0 ok, 1 failed, 2 usage.
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolvePgUrl } from '../db/pg/url.js'
import { bootPgBackend, closePgBackend } from '../db/pg-boot.js'
import { initDatabase, listApiTokenRows, revokeApiTokensForAgent } from '../db.js'
import { systemJob } from '../db/background-jobs.js'
import { listAgentNames } from '../web/agent-config.js'
import {
  agentTokenPath, archiveSharedTokenAge, checkAgentTokens, issueAgentToken, issueOperatorToken, rotateSharedToken,
} from '../agent-tokens.js'

/** The output of one run. The script passes the process streams; a test passes its own. */
export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** The streams of the real process: what the script passes. */
export const processIo: CliIo = {
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
}

/** A command that ends with its exit code (1 failed). Thrown inside the run, caught by runAgentTokensCli. */
export class CliExit extends Error {
  readonly code: 1
  constructor(code: 1) {
    super(`agent-tokens exit ${code}`)
    this.name = 'CliExit'
    this.code = code
  }
}

const USAGE =
  'Usage:\n' +
  '  agent-tokens issue [--rotate] [--dry-run] [<agent>...]\n' +
  '  agent-tokens issue-operator [--rotate]\n' +
  '  agent-tokens rotate-shared\n' +
  '  agent-tokens check [<agent>...]\n' +
  '  agent-tokens archive-shared-age <extracted-archive.db>\n' +
  '  agent-tokens list\n' +
  '  agent-tokens revoke <agent>\n'

type Parsed =
  | { cmd: 'issue'; rotate: boolean; dryRun: boolean; names: string[] }
  | { cmd: 'issue-operator'; rotate: boolean }
  | { cmd: 'rotate-shared' }
  | { cmd: 'check'; names: string[] }
  | { cmd: 'archive-shared-age'; path: string }
  | { cmd: 'list' }
  | { cmd: 'revoke'; name: string }

/**
 * The command line, checked BEFORE anything is opened: a usage error must not boot the backend (the old script opened the
 * database first). The shapes are the old script's: flags are every `--x` argument, names every other argument; the verbs
 * that took no name argument still ignore stray ones, `archive-shared-age` and `revoke` take exactly one.
 */
function parse(argv: string[]): Parsed | undefined {
  const [cmd, ...rest] = argv
  const flags = new Set(rest.filter((a) => a.startsWith('--')))
  const names = rest.filter((a) => !a.startsWith('--'))
  switch (cmd) {
    case 'issue': return { cmd, rotate: flags.has('--rotate'), dryRun: flags.has('--dry-run'), names }
    case 'issue-operator': return { cmd, rotate: flags.has('--rotate') }
    case 'rotate-shared': return { cmd }
    case 'check': return { cmd, names }
    case 'archive-shared-age': return names.length === 1 ? { cmd, path: names[0]! } : undefined
    case 'list': return { cmd }
    case 'revoke': return names.length === 1 ? { cmd, name: names[0]! } : undefined
    default: return undefined
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The main agent first, then every agent with a directory: the default target set of `issue` and `check`. */
const allAgents = (): string[] => [MAIN_AGENT_ID, ...listAgentNames().filter((n) => n !== MAIN_AGENT_ID)]

async function command(p: Parsed, io: CliIo, backend: 'sqlite' | 'pg'): Promise<void> {
  // Active rows as the auth gate counts them: not revoked, not expired. A count only: no name, no hash, no id.
  const now = Math.floor(Date.now() / 1000)
  const seen = (await listApiTokenRows()).filter((r) => r.revoked_at === null && (r.expires_at === null || r.expires_at > now)).length
  // The verb is one of the parsed ones by construction (an unknown first argument never gets here).
  logger.info({ backend, command: p.cmd, activeTokens: seen }, 'agent-tokens: run')

  switch (p.cmd) {
    case 'issue': {
      const targets = p.names.length > 0 ? p.names : allAgents()
      let failed = 0
      for (const agent of targets) {
        if (p.dryRun) {
          io.stdout(`${agent}\twould ${p.rotate ? 'rotate' : 'issue or keep'}\t${agentTokenPath(agent)}\n`)
          continue
        }
        try {
          const r = await issueAgentToken(agent, { rotate: p.rotate })
          io.stdout(`${r.subject}\t${r.status}\t${r.role}\t${r.path}\n`)
        } catch (err) {
          failed++
          io.stderr(`${agent}\tFAILED\t${errMessage(err)}\n`)
        }
      }
      if (failed > 0) throw new CliExit(1)
      break
    }
    case 'issue-operator': {
      try {
        const r = await issueOperatorToken({ rotate: p.rotate })
        io.stdout(`${r.subject}\t${r.status}\t${r.role}\t${r.path}\n`)
      } catch (err) {
        io.stderr(`operator\tFAILED\t${errMessage(err)}\n`)
        throw new CliExit(1)
      }
      break
    }
    case 'rotate-shared': {
      // Always mints a new shared token (no `kept`), writes store/.dashboard-token and revokes the old row with its hash.
      // Refuses, changing nothing, when DASHBOARD_TOKEN is set (it would override the file).
      try {
        const r = await rotateSharedToken()
        io.stdout(`shared\t${r.status}\tadmin\t${r.path}\n`)
        io.stderr(
          'The old shared token is revoked. Restart the dashboard so the in-memory copy is replaced, ' +
          're-enrol every browser that was enrolled with the shared token (npm run dashboard-url), and ' +
          'run `agent-tokens check` and doctor.sh.\n',
        )
      } catch (err) {
        io.stderr(`shared\tFAILED\t${errMessage(err)}\n`)
        throw new CliExit(1)
      }
      break
    }
    case 'check': {
      // Read-only: one line per expected token file, exit 1 when any is not `ok`.
      const { rows, ok } = await checkAgentTokens(p.names.length > 0 ? p.names : allAgents())
      for (const r of rows) io.stdout(`${r.subject}\t${r.status}\t${r.role}\t${r.path}${r.detail ? `\t${r.detail}` : ''}\n`)
      if (!ok) throw new CliExit(1)
      break
    }
    case 'archive-shared-age':
      // Used by verify-restore.sh on its extracted copy of an archive's database: predates | current | unknown. The archive
      // is read with its own SQLite handle (a throwaway copy); only the live side goes through the backend.
      io.stdout(`${await archiveSharedTokenAge(p.path)}\n`)
      break
    case 'list':
      for (const t of (await listApiTokenRows()).filter((r) => r.revoked_at === null)) {
        io.stdout(`${t.id}\t${t.name}\t${t.role}\t${t.agent_id ?? '-'}\t${t.tenant_id}\t${new Date(t.created_at * 1000).toISOString()}\n`)
      }
      break
    case 'revoke':
      io.stdout(`revoked ${await revokeApiTokensForAgent(p.name, Math.floor(Date.now() / 1000))} token(s) of ${p.name}\n`)
      break
  }
}

/**
 * One run of the CLI on the database of this process. Returns the exit code: 0 ok, 1 failed (the error is printed, the
 * pool is ended), 2 usage (nothing was opened). Never throws.
 */
export async function runAgentTokensCli(argv: string[], io: CliIo = processIo): Promise<0 | 1 | 2> {
  const parsed = parse(argv)
  if (parsed === undefined) {
    io.stderr(USAGE)
    return 2
  }
  try {
    const backend = resolvePgUrl() === undefined ? 'sqlite' : 'pg'
    try {
      if (backend === 'pg') await bootPgBackend({ migrateUrl: '' })
      else initDatabase()
      await systemJob('agent-tokens-cli', () => command(parsed, io, backend))()
      return 0
    } finally {
      await closePgBackend()
    }
  } catch (err) {
    if (err instanceof CliExit) return err.code
    io.stderr(`Error: ${errMessage(err)}\n`)
    return 1
  }
}
