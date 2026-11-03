// Shared helpers of the tools/qa scanners: argument parsing, the classic TypeScript API (from the
// isolated tools/eslint toolchain, TypeScript 7 does not ship it), the diff's changed line ranges.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

/** Parses `--flag` and `--key value` arguments. Unknown keys are kept, the caller validates. */
export function parseArgs(argv, spec) {
  const out = { ...spec.defaults }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const key = a.slice(2)
    if (spec.flags.includes(key)) out[key] = true
    else if (spec.values.includes(key)) {
      const v = argv[++i]
      if (v === undefined) throw new Error(`--${key} needs a value`)
      out[key] = v
    } else throw new Error(`unknown option: ${a}`)
  }
  return out
}

/** The repository root: --root, else the current directory. */
export function resolveRoot(root) {
  return path.resolve(root ?? process.cwd())
}

export function loadTypeScript(root) {
  const tsPath = path.join(root, 'tools/eslint/node_modules/typescript')
  try {
    return require(tsPath)
  } catch {
    throw new Error(`typescript not found at ${tsPath}: run "npm ci --prefix tools/eslint --ignore-scripts" first`)
  }
}

export function createProgram(ts, root, tsconfigRel) {
  const cfgPath = path.join(root, tsconfigRel)
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
  if (cfg.error) throw new Error(`cannot read ${cfgPath}: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n')}`)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath))
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
}

/**
 * Added line ranges per absolute file name from `git diff -U0 base..HEAD -- <pathspec>`.
 * A file with no added line is absent from the map.
 */
export function changedLines(root, base, pathspec) {
  const diff = execFileSync('git', ['diff', '-U0', `${base}..HEAD`, '--', pathspec], { cwd: root, maxBuffer: 1 << 28 }).toString()
  const changed = new Map()
  let file = null
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ b/')) file = path.join(root, l.slice(6))
    else if (l.startsWith('+++ ')) file = null // /dev/null: a deleted file
    else if (l.startsWith('@@') && file) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(l)
      const start = Number(m[1])
      const n = m[2] === undefined ? 1 : Number(m[2])
      if (n > 0) {
        if (!changed.has(file)) changed.set(file, [])
        changed.get(file).push([start, start + n - 1])
      }
    }
  }
  return changed
}

export function inRanges(ranges, line) {
  return !!ranges && ranges.some(([a, b]) => line >= a && line <= b)
}

/** Prints the machine-readable report to stdout, the human summary to stderr. */
export function emit(report, humanLines) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  for (const l of humanLines) process.stderr.write(l + '\n')
}
