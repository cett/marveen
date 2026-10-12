import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// A single bearer token gates every /api/* route. It is loaded from
// DASHBOARD_TOKEN if set, otherwise persisted at store/.dashboard-token
// (mode 0600) and auto-generated on first run. Static assets (/, /index.html,
// /style.css, /app.js, /avatars/*) and the auth-status endpoint stay public
// so the UI can bootstrap itself.
const DASHBOARD_TOKEN_FILE = '.dashboard-token'
const DASHBOARD_TOKEN_PATH = join(STORE_DIR, DASHBOARD_TOKEN_FILE)

/** Where the shared dashboard token file lives (store/.dashboard-token); for callers that only look at the file's hash. */
export function dashboardTokenFilePath(storeDir: string = STORE_DIR): string {
  return join(storeDir, DASHBOARD_TOKEN_FILE)
}

/**
 * The active dashboard token, read-only: DASHBOARD_TOKEN env first, then the token file of
 * storeDir. '' when there is none -- unlike loadOrCreateDashboardToken it never mints one. The
 * token file belongs to this module: other server code that needs the value (a scrub list) asks
 * here instead of opening the file.
 */
export function readDashboardToken(storeDir: string = STORE_DIR): string {
  const fromEnv = process.env.DASHBOARD_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = storeDir === STORE_DIR ? DASHBOARD_TOKEN_PATH : join(storeDir, DASHBOARD_TOKEN_FILE)
  try {
    return existsSync(file) ? readFileSync(file, 'utf-8').trim() : ''
  } catch {
    return ''
  }
}

export function loadOrCreateDashboardToken(): string {
  const existing = readDashboardToken()
  if (existing) return existing
  const fresh = randomBytes(32).toString('hex')
  mkdirSync(STORE_DIR, { recursive: true })
  atomicWriteFileSync(DASHBOARD_TOKEN_PATH, fresh, { mode: 0o600 })
  return fresh
}

export function checkBearerToken(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const m = /^Bearer\s+(.+)$/.exec(header)
  if (!m) return false
  const provided = Buffer.from(m[1].trim())
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length) return false
  return timingSafeEqual(provided, wanted)
}
