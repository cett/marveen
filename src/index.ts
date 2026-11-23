// The process entry (package.json start and dev, the launchers and the watchdog all name dist/index.js). It is the bootstrap:
// on a PostgreSQL install it loads the system_config snapshot BEFORE the application (main.ts) is imported, because config.ts
// reads its overrides when it evaluates. An install on SQLite skips the snapshot and starts exactly as before.
//
// This file imports nothing that imports config.ts: env.ts, the secret resolver, db/pg/url.ts, and the snapshot modules only.
// Keep it that way: a static import of config.ts here would evaluate it before the snapshot is set.
//
// A failed snapshot read throws here, before main.ts is imported: the process exits non-zero and nothing else starts.
import { resolvePgUrl } from './db/pg/url.js'
import { setConfigSnapshot } from './config-snapshot.js'
import { loadSystemConfigSnapshot } from './config-snapshot-loader.js'

const pgUrl = resolvePgUrl()
if (pgUrl !== undefined) {
  setConfigSnapshot(await loadSystemConfigSnapshot(pgUrl))
}

await import('./main.js')
