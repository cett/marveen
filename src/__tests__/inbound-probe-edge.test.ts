// Backend coverage batch-57: two small remaining edges in inbound-probe.ts
// that the main pure-function suite (inbound-probe.test.ts) and the mocked
// lifecycle suite (inbound-probe-lifecycle.test.ts) do not reach.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('mainTranscriptDirs: MAIN_AGENT_CONFIG_DIR override', () => {
  afterEach(() => {
    vi.doUnmock('../settings-store.js')
    vi.resetModules()
  })

  it('expands a leading ~ against the home directory and adds it as a candidate root', async () => {
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: vi.fn(() => '~/custom-claude-config'),
    }))
    const { mainTranscriptDirs } = await import('../web/inbound-probe.js')
    const dirs = mainTranscriptDirs()
    expect(dirs.some(d => d.includes(join('custom-claude-config', 'projects')))).toBe(true)
  })
})

describe('readLastIngestionTimestamp: every candidate file disappears before stat', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tmpDirs.length = 0
  })

  it('returns null when statSync throws for every entry (no newestFile found)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbound-probe-stat-race-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'a.jsonl'), '{}', 'utf-8')
    writeFileSync(join(dir, 'b.jsonl'), '{}', 'utf-8')

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        statSync: () => { throw new Error('ENOENT: file disappeared between readdir and stat') },
      }
    })

    const { readLastIngestionTimestamp } = await import('../web/inbound-probe.js')
    expect(readLastIngestionTimestamp(dir)).toBe(null)
  })

  it('returns null when readdirSync throws unexpectedly (outer catch-all)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbound-probe-readdir-throw-'))
    tmpDirs.push(dir)

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        readdirSync: () => { throw new Error('EACCES: permission denied') },
      }
    })

    const { readLastIngestionTimestamp } = await import('../web/inbound-probe.js')
    expect(readLastIngestionTimestamp(dir)).toBe(null)
  })
})
