// The mutant list of the await sweep: every `await` the diff base..HEAD added to a source file under src/.
// A mutant removes that one `await` (the value stays a Promise); a test that does not fail on it does not
// protect the await. Pure and git-only, so the list is the same wherever it is computed.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { changedLines, inRanges } from './common.mjs'

const isTestPath = (p) => /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(p)

/**
 * @returns {{id: string, file: string, line: number, start: number, end: number, snippet: string}[]}
 *   `start`..`end` is the text range removed (the `await` keyword and the space after it) in `file` as committed.
 */
export function listAwaitMutants(ts, root, base, srcDir = 'src') {
  const changed = changedLines(root, base, srcDir)
  const mutants = []
  for (const [abs, ranges] of [...changed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rel = path.relative(root, abs)
    if (isTestPath(rel) || !/\.[cm]?tsx?$/.test(rel) || rel.endsWith('.d.ts')) continue
    let text
    try { text = readFileSync(abs, 'utf8') } catch { continue } // deleted or renamed away
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (ts.isAwaitExpression(node)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        if (inRanges(ranges, line)) {
          mutants.push({
            id: '',
            file: rel,
            line,
            start: node.getStart(sf),
            end: node.expression.getStart(sf),
            snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  mutants.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)
  mutants.forEach((m, i) => { m.id = `M${String(i + 1).padStart(3, '0')}` })
  return mutants
}

/** The source text with the mutant's `await` removed. */
export function applyMutant(text, m) {
  return text.slice(0, m.start) + text.slice(m.end)
}
