// The two path roots of the install: the project root and the store directory. A leaf module: it imports nothing of ours
// and it reads the environment and the file location only. config.ts re-exports these, so existing importers are unchanged.
//
// Why a leaf: a module that needs only a directory name (the vault file lives under STORE_DIR) must not import config.ts,
// because config.ts evaluates its system_config overrides at import time and throws on a PostgreSQL install without a
// snapshot. The vault (src/web/vault.ts) and the helpers that load it import from here instead.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = join(__dirname, '..')
export const STORE_DIR = process.env['MARVEEN_STORE_DIR'] ?? join(PROJECT_ROOT, 'store')
