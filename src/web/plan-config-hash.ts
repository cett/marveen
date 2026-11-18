import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The one place that maps a Claude config directory to the short id used to
// name its per-plan rate-limit snapshot (store/.claude-rate-limits.d/<id>.json).
//
// The writer is scripts/statusline-ratelimit.sh (Python, sha256 of the
// realpath of CLAUDE_CONFIG_DIR). The reader is plan-usage-source.ts. They
// MUST agree byte for byte, so the rule is deliberately tiny and a test
// (plan-usage-source.test.ts) runs the real script and compares its file name
// with this function:
//
//   id = sha256( realpath(expanduser(dir)) )[0:8], lowercase hex
//
// realpath collapses symlinks, `..`, `.` and trailing slashes, so
// `/x/cfg`, `/x/cfg/` and a symlink pointing at it all land on one id. The
// registry path is passed through the same function the writer applies to the
// env value, never compared as text.
//
// A directory that does not exist has no realpath: the function returns null
// instead of guessing, and the caller treats it as "no snapshot".

/** Expand a leading `~` / `~/` the way Python's os.path.expanduser does for
 *  the current user. `~user` forms are not expanded (left as is, so they will
 *  not resolve to a real directory and yield null). */
function expandTilde(dir: string, home: string): string {
  if (dir === '~') return home
  if (dir.startsWith('~/')) return join(home, dir.slice(2))
  return dir
}

/** Absolute, symlink-resolved form of a config dir, or null when it does not
 *  exist (or is not a usable path). */
export function canonicalConfigDir(dir: string, home: string = homedir()): string | null {
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) return null
  try {
    return realpathSync(expandTilde(dir, home))
  } catch {
    return null
  }
}

/** The 8-hex snapshot id of a config dir, or null when the dir has no
 *  canonical form. */
export function configDirHash(dir: string, home: string = homedir()): string | null {
  const canonical = canonicalConfigDir(dir, home)
  if (canonical === null) return null
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8)
}
