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
import { execFileSync } from 'node:child_process'
import { dirname, relative, sep } from 'node:path'
import { protectedSet } from './self-pace-gate.mjs'

// The paths of the protected set that belong in git, relative to the install root, as git pathspecs.
// Only the 'gate-scripts' kind: the egress config lives in store/ (runtime state, not committed) and the
// agent settings files are local configuration that a deploy legitimately leaves modified.
export function protectedPathspecs(prot, installRoot) {
  const specs = new Set()
  for (const e of prot.entries) {
    if (e.kind !== 'gate-scripts') continue
    const rel = relative(installRoot, e.real)
    if (!rel || rel.startsWith('..') || rel.split(sep)[0] === '') continue
    specs.add(rel.split(sep).join('/'))
  }
  return [...specs].sort()
}

// Returns { ok, modified, untracked, error }. `modified`: protected files that differ from HEAD (staged or
// not, deleted included). `untracked`: files in the protected set that git does not track and does not
// ignore. `error`: git could not answer (not a repository, git missing); ok is then false, not silently true.
export function checkProtectedIntegrity(opts = {}) {
  const prot = opts.prot ?? protectedSet(opts)
  const root = dirname(prot.scriptsDir)
  const specs = protectedPathspecs(prot, root)
  // fixed argument arrays, no shell; the pathspecs are literal (:(literal) magic keeps a name like a glob a name)
  const lit = specs.map((s) => `:(literal)${s}`)
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: opts.timeoutMs ?? 8000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = (out) => out.split('\n').filter(Boolean)
  try {
    const modified = lines(git(['diff', '--name-only', 'HEAD', '--', ...lit]))
    const untracked = lines(git(['ls-files', '--others', '--exclude-standard', '--', ...lit]))
    return { ok: modified.length === 0 && untracked.length === 0, modified, untracked, error: null }
  } catch (e) {
    return { ok: false, modified: [], untracked: [], error: String(e?.message ?? e).split('\n')[0] }
  }
}

// A short, plain-text alert for a heartbeat or a log line; null when nothing is wrong.
export function integrityAlert(result) {
  if (result.ok) return null
  if (result.error) return `protected set: integrity check could not run (${result.error})`
  const parts = []
  if (result.modified.length) parts.push(`differ from HEAD: ${result.modified.join(', ')}`)
  if (result.untracked.length) parts.push(`untracked: ${result.untracked.join(', ')}`)
  return `protected set changed outside a deploy: ${parts.join('; ')}`
}
