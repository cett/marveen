#!/usr/bin/env node
// `expect(() => <Promise>).not.toThrow()` can never fail: the function returns a Promise instead of
// throwing, so the assertion passes whatever the body does. Lists every one in the test files.
//
//   node tools/qa/vacuous-notthrow-scan.mjs --all             every test file
//   node tools/qa/vacuous-notthrow-scan.mjs --base <sha>      only lines the diff base..HEAD added
//
// Options: --root <repo> (default cwd), --tsconfig <rel> (default tsconfig.json), --fail-on-findings.
// stdout: JSON report. stderr: one line per finding and the totals.
import path from 'node:path'
import process from 'node:process'
import { changedLines, createProgram, emit, inRanges, loadTypeScript, parseArgs, resolveRoot } from './lib/common.mjs'

const args = parseArgs(process.argv.slice(2), {
  flags: ['all', 'fail-on-findings'],
  values: ['root', 'base', 'tsconfig'],
  defaults: { tsconfig: 'tsconfig.json' },
})
if (!args.all && !args.base) {
  process.stderr.write('vacuous-notthrow-scan: pass --base <sha> (lines the diff added) or --all\n')
  process.exit(2)
}
const root = resolveRoot(args.root)
const ts = loadTypeScript(root)
const program = createProgram(ts, root, args.tsconfig)
const checker = program.getTypeChecker()
const changed = args.all ? null : changedLines(root, args.base, '.')

const isPromise = (t) => !!t && ((t.isUnion && t.isUnion() && t.types.some(isPromise)) || /Promise/.test(checker.typeToString(t)))

let total = 0
const findings = []
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !sf.fileName.includes('/__tests__/')) continue
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'toThrow' &&
        ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === 'not') {
      total++
      const expectCall = n.expression.expression.expression
      const fn = ts.isCallExpression(expectCall) ? expectCall.arguments[0] : undefined
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const sig = checker.getSignatureFromDeclaration(fn)
        if (sig && isPromise(checker.getReturnTypeOfSignature(sig))) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          if (!changed || inRanges(changed.get(sf.fileName), line)) {
            findings.push({ file: path.relative(root, sf.fileName), line, kind: 'vacuous-not-toThrow', text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 110) })
          }
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

const report = {
  tool: 'vacuous-notthrow-scan',
  mode: args.all ? 'all' : 'changed-lines',
  base: args.base ?? null,
  notThrowTotal: total,
  total: findings.length,
  findings,
}
emit(report, [
  ...findings.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text}`),
  `vacuous-notthrow-scan: not.toThrow total ${total}, vacuous (async body) ${findings.length} (${report.mode})`,
])
process.exit(args['fail-on-findings'] && findings.length > 0 ? 1 : 0)
