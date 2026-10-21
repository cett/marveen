// The boot-synchronous twins: functions that stay on the raw synchronous connection because the boot chain
// (db/index.ts) runs before any async code can. They bypass the async facade, so they must not spread: a
// caller outside the boot chain would read or write on the raw connection beside the facade's transaction
// lock, which is exactly what the facade exists to prevent (and what does not exist on PostgreSQL).
//
// One table, one walk over src/. A twin is listed with the only files allowed to mention it: the file that
// defines it and the boot chain that calls it. This replaces the per-module guard each wave step had added
// next to its own tests; a new twin is one more row here.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

/** twin function -> the files (relative to src/) that may mention it outside a comment. */
const BOOT_SYNC_TWINS: Readonly<Record<string, readonly string[]>> = {
  migrateCostBudgetsFromFile: ['db/cost-budgets.ts', 'db/index.ts'],
  migrateVaultBindingsFromFile: ['db/vault-bindings.ts', 'db/index.ts'],
  importAgentSettingsFromFile: ['db/agent-settings.ts', 'db/index.ts'],
  importAgentStateFromFile: ['db/agent-state.ts', 'db/index.ts'],
  getAgentStateSync: ['db/agent-state.ts', 'db/index.ts'],
  setAgentStateSync: ['db/agent-state.ts', 'db/index.ts'],
}

// Several files cross-reference a twin by name in a doc comment, which is not a call.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** The files of `sources` (path relative to src/ -> content) that mention `twin` outside a comment. */
function filesMentioning(twin: string, sources: ReadonlyMap<string, string>): string[] {
  const re = new RegExp(`\\b${twin}\\b`)
  return [...sources].filter(([, src]) => re.test(stripComments(src))).map(([rel]) => rel).sort()
}

function readSources(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue
      readSources(full, out)
    } else if (name.endsWith('.ts')) {
      out.set(full.slice(SRC_DIR.length), readFileSync(full, 'utf8'))
    }
  }
  return out
}

const SOURCES = readSources(SRC_DIR)

describe('boot-synchronous twins stay inside the boot chain', () => {
  it('the walk reads the real source tree (a guard over zero files passes vacuously)', () => {
    expect(SOURCES.size).toBeGreaterThan(100)
    expect(SOURCES.has('db/index.ts')).toBe(true)
  })

  it.each(Object.entries(BOOT_SYNC_TWINS))('%s is mentioned only in its allowed files, and in all of them', (twin, allowed) => {
    // Exact equality, not "subset": an allowed file that no longer mentions the twin means the row is stale
    // and would silently permit a future caller there.
    expect(filesMentioning(twin, SOURCES)).toEqual([...allowed].sort())
  })

  // Negative controls for the detector: without them a regex that matches nothing would pass every row above.
  describe('the detector', () => {
    const sources = new Map<string, string>([
      ['db/index.ts', 'migrateCostBudgetsFromFile(x)'],
      ['web/rogue.ts', 'import { migrateCostBudgetsFromFile } from "../db.js"\nmigrateCostBudgetsFromFile(y)'],
      ['web/doc-only.ts', '// see migrateCostBudgetsFromFile\n/* and migrateCostBudgetsFromFile here */\nconst a = 1'],
      ['web/lookalike.ts', 'migrateCostBudgetsFromFileExtra(z)'],
    ])

    it('finds a caller outside the allowed files', () => {
      expect(filesMentioning('migrateCostBudgetsFromFile', sources)).toEqual(['db/index.ts', 'web/rogue.ts'])
    })

    it('does not count a mention in a line or block comment', () => {
      expect(filesMentioning('migrateCostBudgetsFromFile', sources)).not.toContain('web/doc-only.ts')
    })

    it('does not count a longer name that merely contains the twin name', () => {
      expect(filesMentioning('migrateCostBudgetsFromFile', sources)).not.toContain('web/lookalike.ts')
    })

    it('the sync pair is matched by exact name, so the async getAgentState is not a twin hit', () => {
      const pair = new Map([['web/a.ts', 'getAgentState(x)'], ['web/b.ts', 'getAgentStateSync(x)']])
      expect(filesMentioning('getAgentStateSync', pair)).toEqual(['web/b.ts'])
    })
  })
})
