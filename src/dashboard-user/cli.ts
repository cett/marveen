// Dashboard browser-login user administration, the body of scripts/dashboard-user.ts (the break-glass path).
//
//   npm run dashboard-user -- add <username> [--password-stdin]
//   npm run dashboard-user -- reset-password <username> [--password-stdin]
//   npm run dashboard-user -- list
//   npm run dashboard-user -- remove <username>
//   npm run dashboard-user -- sessions:clear [<username>]
//   npm run dashboard-user -- security:reset
//
// THIS IS THE BREAK-GLASS PATH. It talks to the database directly -- no HTTP, no auth gate -- so it works even when the
// web login is misconfigured, throttled or unreachable. The operator can always run commands on the machine hosting the
// install, so "I can run this CLI" is the root credential.
//
//   PostgreSQL  MARVEEN_PG_URL set: bootPgBackend({ migrateUrl: '' }), as the budget check and the channel coordinator boot.
//               The serving pool on the application role; no migrate URL, so no DDL from this process and the owner
//               credential is never read here. The trust bound is the same as for every PostgreSQL CLI: whoever can read
//               the install environment (the 0600 .env or the secret mount) is the machine owner.
//   SQLite      otherwise: the unchanged initDatabase() chain.
//
// The whole command runs inside the system job `dashboard-user-cli`. This is the machine owner's command, and under
// row-level security an empty context sees zero dashboard users: a blind run would print "token-only mode" from `list`,
// "not found" from reset-password, and `security:reset` would count zero device keys. `add` on a table that looks empty
// would elect the admin role, but on PostgreSQL the row-level policy refuses that insert (an error, nothing written), so
// the blind add fails loudly instead of creating an admin. The info line on stderr (backend, command, users seen) tells
// "ran and saw N users" apart from "ran blind"; it carries no username, no password and no hash.
//
// The script loads the config snapshot before it imports this module (config.ts reads it at import). A failure is never
// thrown to the caller: it is printed, and the exit code says what happened: 0 ok, 1 failed, 2 usage.
import { logger } from '../logger.js'
import { resolvePgUrl } from '../db/pg/url.js'
import { bootPgBackend, closePgBackend } from '../db/pg-boot.js'
import { initDatabase, createDashboardUser, getDashboardUser, listDashboardUsers, deleteDashboardUser, updateDashboardUserPassword, logConfigChange } from '../db.js'
import { systemJob } from '../db/background-jobs.js'
import { hashPassword, assertPasswordPolicy, PasswordPolicyError } from '../web/password-hash.js'
import { revokeAllForUser, revokeAllSessions } from '../web/auth-sessions.js'
import { securityReset } from '../web/security-reset.js'
import { notifySecurityEvent } from '../notify.js'
import { createInterface } from 'node:readline'
import { formatUserLine } from './format.js'

/** The output and the input of one run. The script passes the process streams; a test passes its own. */
export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  readStdin: () => Promise<string>
  promptHidden: (question: string) => Promise<string>
}

/** A command that ends with its exit code (1 failed, 2 usage). Thrown inside the run, caught by runDashboardUserCli. */
export class CliExit extends Error {
  readonly code: 1 | 2
  constructor(code: 1 | 2) {
    super(`dashboard-user exit ${code}`)
    this.name = 'CliExit'
    this.code = code
  }
}

function usage(io: CliIo): never {
  io.stderr(
    'Usage:\n' +
    '  dashboard-user add <username> [--password-stdin]\n' +
    '  dashboard-user reset-password <username> [--password-stdin]\n' +
    '  dashboard-user list\n' +
    '  dashboard-user remove <username>\n' +
    '  dashboard-user sessions:clear [<username>]\n' +
    '  dashboard-user security:reset      # revoke ALL device keys + clear ALL browser sessions\n',
  )
  throw new CliExit(2)
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data.replace(/\n$/, '')))
  })
}

// Muted interactive prompt: echo is suppressed so the password is not shown.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void }
    process.stdout.write(question)
    let first = true
    out._writeToOutput = (str: string) => {
      // Let the first write (the question echo) through, mute keystrokes after.
      if (first) { first = false; process.stdout.write(str); return }
      // Print nothing for typed characters; keep newlines so Enter works.
      if (str.includes('\n')) process.stdout.write('\n')
    }
    rl.question('', (answer) => {
      out._writeToOutput = undefined
      rl.close()
      resolve(answer)
    })
  })
}

/** The streams of the real process: what the script passes. */
export const processIo: CliIo = {
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
  readStdin,
  promptHidden,
}

async function acquirePassword(fromStdin: boolean, io: CliIo): Promise<string> {
  if (fromStdin) {
    const pw = (await io.readStdin()).trim()
    assertPasswordPolicy(pw)
    return pw
  }
  const a = await io.promptHidden('New password: ')
  const b = await io.promptHidden('Repeat password: ')
  if (a !== b) {
    io.stderr('Passwords do not match.\n')
    throw new CliExit(1)
  }
  assertPasswordPolicy(a)
  return a
}

const KNOWN_VERBS = ['add', 'reset-password', 'list', 'remove', 'sessions:clear', 'security:reset']

async function command(argv: string[], io: CliIo, backend: 'sqlite' | 'pg'): Promise<void> {
  const [cmd, ...rest] = argv
  const fromStdin = rest.includes('--password-stdin')
  const positional = rest.filter((a) => !a.startsWith('--'))

  const seen = (await listDashboardUsers()).length
  // The verb only when it is one of the known ones: a password typed as the first argument must not reach the log.
  const verb = KNOWN_VERBS.includes(cmd ?? '') ? cmd : 'unknown'
  logger.info({ backend, command: verb, users: seen }, 'dashboard-user: run')

  switch (cmd) {
    case 'add': {
      const username = positional[0]
      if (!username) usage(io)
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) {
        io.stderr('Invalid username (1-64 chars: letters, digits, . _ -).\n')
        throw new CliExit(1)
      }
      if (await getDashboardUser(username)) {
        io.stderr(`User "${username}" already exists.\n`)
        throw new CliExit(1)
      }
      const pw = await acquirePassword(fromStdin, io)
      const hash = await hashPassword(pw)
      await createDashboardUser(username, hash)
      await logConfigChange('security.cli_user_add', null, username, 'cli')
      io.stdout(`Created dashboard login "${username}".\n`)
      break
    }
    case 'reset-password': {
      const username = positional[0]
      if (!username) usage(io)
      const user = await getDashboardUser(username)
      if (!user) {
        io.stderr(`User "${username}" not found.\n`)
        throw new CliExit(1)
      }
      const pw = await acquirePassword(fromStdin, io)
      const hash = await hashPassword(pw)
      await updateDashboardUserPassword(user.id, hash)
      await revokeAllForUser(user.id)
      // Same audit + channel ping as the HTTP break-glass: a password reset
      // that skipped the current-password proof must always leave a trace.
      await logConfigChange('security.break_glass_password_reset', null, user.username, 'cli')
      await notifySecurityEvent(`🔑 Jelszó-reset a dashboard CLI-ből (break-glass): "${user.username}". Ha nem te voltál, a gépen fut valami a nevedben.`)
      io.stdout(`Password reset for "${username}"; all their sessions were revoked.\n`)
      break
    }
    case 'list': {
      const users = await listDashboardUsers()
      if (users.length === 0) {
        io.stdout('No dashboard users (token-only mode).\n')
        break
      }
      for (const u of users) io.stdout(`${formatUserLine(u)}\n`)
      break
    }
    case 'remove': {
      const username = positional[0]
      if (!username) usage(io)
      const user = await getDashboardUser(username)
      if (!user) {
        io.stderr(`User "${username}" not found.\n`)
        throw new CliExit(1)
      }
      await revokeAllForUser(user.id)
      await deleteDashboardUser(username)
      // Neither engine has a foreign key from auth_sessions to dashboard_users, so the delete does not take the sessions
      // with it: a session opened between the two steps would survive. The second revoke closes that window (idempotent).
      await revokeAllForUser(user.id)
      await logConfigChange('security.cli_user_remove', null, username, 'cli')
      const remaining = (await listDashboardUsers()).length
      io.stdout(`Removed "${username}".${remaining === 0 ? ' No users left -- back to token-only mode.' : ''}\n`)
      break
    }
    case 'security:reset': {
      const r = await securityReset('cli')
      await notifySecurityEvent(`🚨 Biztonsági reset futott a dashboard CLI-ből: ${r.deviceKeysRevoked} eszközkulcs visszavonva, ${r.sessionsCleared} böngésző-munkamenet törölve. A hozzáférési token és a jelszavak változatlanok.`)
      io.stdout(
        `Security reset done: ${r.deviceKeysRevoked} device key(s) revoked, ${r.sessionsCleared} browser session(s) cleared.\n` +
        'Passwords and the dashboard token are untouched. Devices must be re-enrolled with new keys.\n',
      )
      break
    }
    case 'sessions:clear': {
      const username = positional[0]
      if (username) {
        const user = await getDashboardUser(username)
        if (!user) {
          io.stderr(`User "${username}" not found.\n`)
          throw new CliExit(1)
        }
        await revokeAllForUser(user.id)
        await logConfigChange('security.cli_sessions_clear', null, username, 'cli')
        io.stdout(`Cleared all sessions for "${username}".\n`)
      } else {
        // Cache and table together: the same call the dashboard's own revocation makes (a raw DELETE would leave the
        // cache of this process out of it, and has no PostgreSQL form).
        await revokeAllSessions()
        await logConfigChange('security.cli_sessions_clear', null, 'all', 'cli')
        io.stdout('Cleared ALL dashboard login sessions.\n')
      }
      break
    }
    default:
      usage(io)
  }
}

/**
 * One run of the CLI on the database of this process. Returns the exit code: 0 ok, 1 failed (the error is printed, the
 * pool is ended), 2 usage. Never throws.
 */
export async function runDashboardUserCli(argv: string[], io: CliIo = processIo): Promise<0 | 1 | 2> {
  try {
    if (argv[0] === undefined) usage(io)
    const backend = resolvePgUrl() === undefined ? 'sqlite' : 'pg'
    try {
      if (backend === 'pg') await bootPgBackend({ migrateUrl: '' })
      else initDatabase()
      await systemJob('dashboard-user-cli', () => command(argv, io, backend))()
      return 0
    } finally {
      await closePgBackend()
    }
  } catch (err) {
    if (err instanceof CliExit) return err.code
    if (err instanceof PasswordPolicyError) {
      io.stderr(`${err.message}\n`)
    } else {
      io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    return 1
  }
}
