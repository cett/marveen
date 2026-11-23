// The launched entry of the channel coordinator (launchd runs dist/channel-coordinator.js with KeepAlive; the unit names this
// path and is unchanged). It is the bootstrap: on a PostgreSQL install it loads the system_config snapshot BEFORE the body
// (channel-coordinator-main.ts) is imported, because config.ts reads its overrides when it evaluates. An install on SQLite
// skips the snapshot and starts as before.
//
// This file imports nothing that imports config.ts (config-bootstrap.ts, logger.ts, the URL and snapshot modules only). A
// static import of the body here would evaluate config.ts before the snapshot is set.
//
// The entry guard lives here: the body does not run itself when imported (tests import it), the bootstrap runs its main().
import { pathToFileURL } from 'node:url'
import { ensureConfigSnapshot } from './config-bootstrap.js'
import { logger } from './logger.js'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureConfigSnapshot()
  } catch (err) {
    logger.error({ err }, 'channel-coordinator: snapshot step failed, exiting before the poller starts')
    process.exit(1)
  }
  const body = await import('./channel-coordinator-main.js')
  body.main().catch((err: unknown) => {
    logger.error({ err }, 'channel-coordinator: crashed')
    body.releaseLock()
    process.exit(1)
  })
}
