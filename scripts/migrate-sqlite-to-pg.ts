// The SQLite -> PostgreSQL copy tool (P-G1): an operator command, run by the owner of the cutover, never by
// a sub-agent. It reads the whole SQLite database, so it is not part of the dashboard boot.
//
//   tsx scripts/migrate-sqlite-to-pg.ts check --sqlite <file>
//   tsx scripts/migrate-sqlite-to-pg.ts copy --sqlite <file> [--dry-run]
//   tsx scripts/with-config.ts migrate-sqlite-to-pg embeddings
//
// The check and copy connect with the migration URL (MARVEEN_PG_MIGRATE_URL: the owner role, resolved from the secret mount,
// the environment or .env). The embeddings stage boots the serving backend with the app URL (MARVEEN_PG_URL), the same role
// the dashboard runs as. It goes through the with-config runner: config.ts reads the system_config snapshot at import time,
// and the runner loads it before this file is imported. The URL is never printed; the report names tables, columns and
// counts, never a value. The embeddings run through the runner, which sends the log lines to stderr (with-config.ts).
// Exit codes: 0 green (embeddings: also when the embedder left rows pending), 1 refused (the report lists every refusal),
// 2 usage or connection error.

import { runCheck } from '../src/db/pg-copy/check.js'
import { runCopy } from '../src/db/pg-copy/copy.js'
import type { OrphanMode } from '../src/db/pg-copy/orphans.js'
import { resolvePgMigrateUrl, resolvePgUrl } from '../src/db/pg/url.js'
import { bootPgBackend, closePgBackend, sanitizeError } from '../src/db/pg-boot.js'

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  return args[i + 1]
}

const USAGE =
  'usage: migrate-sqlite-to-pg.ts check --sqlite <file> [--orphans refuse|skip]\n' +
  '       migrate-sqlite-to-pg.ts copy --sqlite <file> [--dry-run] [--orphans refuse|skip]\n' +
  '       migrate-sqlite-to-pg.ts embeddings\n'

/** `--orphans`: refuse (the default) names every orphan row; skip leaves them out of the copy, and the report says so. */
function orphanMode(args: string[]): OrphanMode | undefined {
  const v = argValue(args, '--orphans')
  if (v === undefined) return 'refuse'
  return v === 'refuse' || v === 'skip' ? v : undefined
}

/** The URLs of this run. Every error that leaves the script is redacted for all of them (sanitizeError), whichever path it took. */
const runUrls: string[] = []

/** The one exit for an error: redacted for every URL of the run, and the command name leads the line. Returns the exit code. */
function fail(command: string, err: unknown): number {
  const [first, ...more] = runUrls
  const message = first === undefined ? (err instanceof Error ? err.message : String(err)) : sanitizeError(err, first, ...more).message
  process.stderr.write(`${command}: ${message}\n`)
  return 2
}

/** The embeddings stage: boots the serving backend as the app role, fills the side tables, prints the counts. */
async function embeddings(): Promise<number> {
  const appUrl = resolvePgUrl()
  if (!appUrl) {
    process.stderr.write('embeddings: MARVEEN_PG_URL is not set (the app role of the target)\n')
    return 2
  }
  runUrls.push(appUrl)
  try {
    // migrateUrl '' : the boot only checks that the schema is current; this stage never changes it
    await bootPgBackend({ migrateUrl: '' })
    // dynamic: the stage reaches config.ts, which must not load for check and copy (the runner loads the snapshot first)
    const { runEmbeddingsStage } = await import('../src/db/pg-copy/embeddings.js')
    const report = await runEmbeddingsStage()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  } catch (err) {
    return fail('embeddings', err)
  } finally {
    await closePgBackend().catch(() => undefined)
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === 'embeddings') return await embeddings()
    if (command !== 'check' && command !== 'copy') {
      process.stderr.write(USAGE)
      return 2
    }
    const sqlitePath = argValue(rest, '--sqlite')
    if (!sqlitePath) {
      process.stderr.write(`${command}: --sqlite <file> is required\n`)
      return 2
    }
    const orphans = orphanMode(rest)
    if (!orphans) {
      process.stderr.write(`${command}: --orphans takes refuse or skip\n`)
      return 2
    }
    const pgUrl = resolvePgMigrateUrl()
    if (!pgUrl) {
      process.stderr.write(`${command}: MARVEEN_PG_MIGRATE_URL is not set (the owner role of the target)\n`)
      return 2
    }
    runUrls.push(pgUrl)
    if (command === 'check') {
      const report = await runCheck({ sqlitePath, pgUrl, orphans })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return report.ok ? 0 : 1
    }
    const dryRun = rest.includes('--dry-run')
    const report = await runCopy({ sqlitePath, pgUrl, dryRun, orphans })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.ok ? 0 : 1
  } catch (err) {
    return fail(command ?? 'check', err)
  }
}

// main() catches everything it can reach; this is the last net, and it redacts the same way (a rejection is never printed raw).
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.exitCode = fail(process.argv[2] ?? 'check', err)
  },
)
