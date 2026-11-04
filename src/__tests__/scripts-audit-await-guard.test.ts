// The command-line scripts under scripts/ and tools/ call the converted db modules outside of src/, where the async
// lint does not look and a lost `await` is no type error: an audit row written by a script (a break-glass password
// reset) would be a floating Promise, lost if the process exits first. This reads those sources and fails on a call of
// any exported async function of src/db/audit.ts, agents.ts or observability.ts that is not awaited, returned or explicitly
// voided on its line. A module joins the list in MODULES when it moves onto the facade.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '__tests__'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(path)
  }
  return out
}

const MODULES = ['audit.ts', 'agents.ts', 'observability.ts']

const auditExports = MODULES.flatMap(mod =>
  [...readFileSync(join(ROOT, 'src', 'db', mod), 'utf-8').matchAll(/^export async function (\w+)/gm)].map(m => m[1]!))

/** Lines of a source that call an audit function without `await`, `return` or `void` in front of the call. */
export function floatingAuditCalls(source: string, names: string[]): Array<{ line: number; text: string }> {
  const call = new RegExp(`\\b(${names.join('|')})\\(`)
  const hits: Array<{ line: number; text: string }> = []
  source.split('\n').forEach((text, i) => {
    const t = text.trim()
    if (t.startsWith('//') || t.startsWith('*') || /^(export\s+)?(async\s+)?function\b/.test(t) || /^import\b/.test(t)) return
    const m = call.exec(text)
    if (!m) return
    const before = text.slice(0, m.index)
    if (/(\bawait|\breturn|\bvoid)\s+$/.test(before)) return
    hits.push({ line: i + 1, text: t.slice(0, 120) })
  })
  return hits
}

describe('scripts and tools call the converted modules with await', () => {
  it('the exported function list is read from src/db/audit.ts, agents.ts and observability.ts', () => {
    expect(auditExports).toEqual(expect.arrayContaining(['writeAgentAuditLog', 'logConfigChange', 'pruneAuditLogs']))
    expect(auditExports).toEqual(expect.arrayContaining(['upsertBlackboard', 'claimPendingForAgent', 'setTenantAgentAvailability']))
    expect(auditExports).toEqual(expect.arrayContaining(['updateTenant', 'getTenant', 'deleteTenant']))
  })

  it('the scanner flags a floating call and accepts awaited, returned and voided ones', () => {
    const src = [
      'logConfigChange("k", null, "v", "cli")',
      'await logConfigChange("k", null, "v", "cli")',
      'return logConfigChange("k", null, "v", "cli")',
      'void logConfigChange("k", null, "v", "cli")',
      '// logConfigChange("k") in a comment',
      'import { logConfigChange } from "x"',
    ].join('\n')
    expect(floatingAuditCalls(src, auditExports)).toEqual([{ line: 1, text: 'logConfigChange("k", null, "v", "cli")' }])
  })

  it('no file under scripts/ or tools/ has a floating call of an audit, agents or observability function', () => {
    const found: string[] = []
    for (const dir of ['scripts', 'tools']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const h of floatingAuditCalls(readFileSync(file, 'utf-8'), auditExports)) {
          found.push(`${relative(ROOT, file)}:${h.line}  ${h.text}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
