// The secret-gate workflow scans the change range, and falls back to `--all` when the range cannot be resolved
// (a force-push, the first push of a branch). A pull request never takes that branch, so a pre-existing finding in
// the tree stays invisible until the day the fallback runs and turns the push red. This keeps the whole tracked
// tree clean under the same gate, so the fallback cannot go red on old content.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

describe('secret-gate --all (the workflow fallback)', () => {
  it('finds nothing in the tracked tree', () => {
    const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/secret-gate.ts', '--all'], { cwd: ROOT, encoding: 'utf-8' })
    // The gate prints where a finding is, never what: safe to show.
    expect(r.stdout + r.stderr).toMatch(/PASS: no denied path, no secret shape, no channel material/)
    expect(r.status).toBe(0)
  }, 60_000)
})
