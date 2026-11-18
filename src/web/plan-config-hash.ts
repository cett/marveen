import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// The one place that maps a Claude config directory to the short id used to
// name its per-plan rate-limit snapshot (store/.claude-rate-limits.d/<id>.json).
//
// The writer is scripts/statusline-ratelimit.sh (Python, sha256 of
// os.path.realpath(os.path.expanduser(dir))). The reader is
// plan-usage-source.ts. They MUST agree byte for byte, so the rule is
// deliberately tiny and pinned by a shared fixture
// (src/__tests__/fixtures/plan-config-hash-vectors.json) that BOTH sides are
// tested against: this function in plan-config-hash.test.ts, the real script in
// plan-usage-source.test.ts.
//
//   id = sha256( canonical(dir) )[0:8], lowercase hex
//   canonical(dir) = realpath(expanduser(dir))
//
// realpath collapses symlinks, `..`, `.`, repeated and trailing slashes, so
// `/x/cfg`, `/x/cfg/` and a symlink pointing at it all land on one id.
// A directory that does not exist yet still has a canonical form: the longest
// existing ancestor is resolved (symlinks included) and the remaining names
// are appended after lexical normalisation, which is what Python's
// non-strict realpath does. The only inputs without a canonical form are the
// ones that are not an absolute path after `~` expansion (empty, relative,
// `~user`) and NUL bytes: a relative path would depend on the process cwd.

/** Expand a leading `~` / `~/` the way Python's os.path.expanduser does for
 *  the current user. `~user` forms are not expanded (left as is; they stay
 *  relative and so have no canonical form). */
function expandTilde(dir: string, home: string): string {
  if (dir === '~') return home
  if (dir.startsWith('~/')) return join(home, dir.slice(2))
  return dir
}

/** realpath that tolerates a missing tail: resolve the longest existing
 *  ancestor, then re-attach the missing names. `p` is absolute and already
 *  lexically normalised (path.resolve). */
function realpathAllowingMissingTail(p: string): string {
  const missingNames: string[] = []
  let cur = p
  for (;;) {
    try {
      const real = realpathSync(cur)
      return missingNames.length === 0 ? real : join(real, ...missingNames.reverse())
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // Only "it is not there" may be walked past. Anything else (EACCES, ELOOP,
      // ENAMETOOLONG ...) means we cannot vouch for a canonical form.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const parent = dirname(cur)
      if (parent === cur) throw err
      missingNames.push(basename(cur))
      cur = parent
    }
  }
}

/** Absolute, symlink-resolved form of a config dir, or null when it has none
 *  (see the header comment). */
export function canonicalConfigDir(dir: string, home: string = homedir()): string | null {
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) return null
  const expanded = expandTilde(dir, home)
  if (!isAbsolute(expanded)) return null
  try {
    return realpathAllowingMissingTail(resolve(expanded))
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
