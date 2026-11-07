// C3 (detective): is the protected gate set of THIS install what HEAD says it is?
//
// The self-pace gate refuses what it can READ off a command. It cannot see a script that builds a path
// at run time, a symlink chain made by another route, a file list handed to xargs, or the same OS user
// acting outside Claude Code. For those the answer is not another entry in a list but detection: the
// gate files of a deployed install are exactly the files of HEAD. A legitimate deploy moves HEAD and
// leaves the tree clean, so it does not trip; a changed gate file, a deleted one or a stray file in a
// protected directory does.
//
// This module only DETECTS and reports. It never blocks a call (a gate that can lock itself out is
// worse than the gap) and never writes. Wiring it into a periodic check is a separate decision.
//
// What it compares is the protected set with HEAD, NOT with what was reviewed: a gate change that is
// committed in the install reads as a deploy. It does not look at the agent settings files or at any file
// outside the protected set, and the same OS user can rewrite .git itself (a clean filter, an attributes
// file, the index); the git calls below close the cheap ways to hide a change (see GIT_HARDEN).
import { execFileSync } from 'node:child_process'
import { dirname, relative, sep } from 'node:path'
import { protectedSet } from './self-pace-gate.mjs'

const MAX_NAMES = 50 // names listed per alert, the rest is counted
const MAX_NAME_LEN = 200

// The paths of the protected set that belong in git, relative to the install root, as git pathspecs, by the
// LEXICAL name of the entry (not its real path: a gate file replaced by a symlink to another existing file
// would otherwise be looked up under the target's name and read as unchanged).
// Only the 'gate-scripts' kind: the egress config lives in store/ (runtime state, not committed) and the
// agent settings files are local configuration that a deploy legitimately leaves modified.
export function protectedPathspecs(prot, installRoot) {
  const specs = new Set()
  for (const e of prot.entries) {
    if (e.kind !== 'gate-scripts') continue
    const rel = relative(installRoot, e.lex ?? e.real)
    if (!rel || rel.startsWith('..') || rel.split(sep)[0] === '') continue
    specs.add(rel.split(sep).join('/'))
  }
  return [...specs].sort()
}

// A name for a one-line alert: control characters (a newline, an escape sequence, a bidi override) become '?'
// and the length is capped, because the alert is read by a log or a model and a file name can carry text that
// reads as an instruction.
const cleanName = (s) => {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '?')
  return t.length > MAX_NAME_LEN ? `${t.slice(0, MAX_NAME_LEN)}...` : t
}

// git is run in a repository whose config, attributes and exclude files the monitored party can write:
// core.fsmonitor EXECUTES a command; core.fileMode=false hides a chmod; an optional lock would let the
// check itself write into .git. The caller's GIT_* variables (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...) are
// not passed on: they change what is checked.
const GIT_HARDEN = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.fileMode=true']
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

// Returns { ok, modified, untracked, hidden, more, error }.
//   modified:  protected files that differ from HEAD (staged or not, deleted, mode or type changed included)
//   untracked: files in the protected set (and in the scripts root) that git does not track and that no
//              committed .gitignore ignores (info/exclude and the global excludes file are NOT consulted)
//   hidden:    tracked protected files flagged assume-unchanged or skip-worktree: git then stops looking at them
//   more:      how many names beyond the first 50 per list are left out
//   error:     git could not answer (not a repository, git missing, out of time); ok is then false, not silently true
// One overall time budget (opts.timeoutMs, default 8 s) covers all git calls.
export function checkProtectedIntegrity(opts = {}) {
  const prot = opts.prot ?? protectedSet(opts)
  const root = dirname(prot.scriptsDir)
  const specs = protectedPathspecs(prot, root)
  // fixed argument arrays, no shell; the pathspecs are literal (:(literal) magic keeps a name like a glob a name)
  const lit = specs.map((s) => `:(literal)${s}`)
  // an untracked file anywhere directly in the scripts root (not only in the protected names and directories)
  const scriptsRel = relative(root, prot.scriptsDir).split(sep).join('/')
  const rootGlob = scriptsRel && !scriptsRel.startsWith('..') && !/[*?[\\]/.test(scriptsRel) ? [`:(glob)${scriptsRel}/*`] : []
  const budget = opts.timeoutMs ?? 8000
  const t0 = Date.now()
  const git = (args) => {
    const left = budget - (Date.now() - t0)
    if (left <= 0) throw new Error('integrity check timed out')
    return execFileSync(opts.gitBin ?? 'git', ['-C', root, ...GIT_HARDEN, ...args], { encoding: 'utf8', timeout: left, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })
  }
  const nul = (out) => out.split('\0').filter(Boolean) // -z: names are never quoted and may hold a newline
  try {
    const modified = nul(git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...lit]))
    const untracked = nul(git(['ls-files', '-z', '--others', '--exclude-per-directory=.gitignore', '--', ...lit, ...rootGlob]))
    // `ls-files -v` tags a tracked file: H normal, a lower-case letter assume-unchanged, S skip-worktree
    const hidden = nul(git(['ls-files', '-v', '-z', '--', ...lit])).filter((l) => /^[a-zS] /.test(l)).map((l) => l.slice(2))
    const total = modified.length + untracked.length + hidden.length
    const cap = (a) => a.slice(0, MAX_NAMES).map(cleanName)
    const shown = cap(modified).length + cap(untracked).length + cap(hidden).length
    return { ok: total === 0, modified: cap(modified), untracked: cap(untracked), hidden: cap(hidden), more: total - shown, error: null }
  } catch (e) {
    return { ok: false, modified: [], untracked: [], hidden: [], more: 0, error: cleanName(String(e?.message ?? e).split('\n')[0]) }
  }
}

// A short, plain-text alert for a heartbeat or a log line; null when nothing is wrong.
export function integrityAlert(result) {
  if (result.ok) return null
  if (result.error) return `protected set: integrity check could not run (${result.error})`
  const parts = []
  if (result.modified.length) parts.push(`differ from HEAD: ${result.modified.join(', ')}`)
  if (result.untracked.length) parts.push(`untracked: ${result.untracked.join(', ')}`)
  if (result.hidden.length) parts.push(`hidden from git (assume-unchanged or skip-worktree): ${result.hidden.join(', ')}`)
  if (result.more > 0) parts.push(`+${result.more} more`)
  return `protected set changed outside a deploy: ${parts.join('; ')}`
}
