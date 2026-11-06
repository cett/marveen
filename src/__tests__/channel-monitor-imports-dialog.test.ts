// The channel monitor's menu-recovery pass must never answer the external CLAUDE.md imports dialog: Escape (or Enter)
// on it picks the highlighted "No" and records an explicit refusal of the persona imports. The pass lives inside the
// monitor's tick loop and cannot be driven from a unit test, so these asserts read the source and pin the two
// structural facts that matter: the dialog is recognised as "parked in a menu" on its own detector (the raw-tail menu
// detector misses a padded dialog), and its branch sends no key at all. The decision itself is covered behaviourally
// in pane-state-external-imports.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')

describe('channel-monitor menu recovery and the external imports dialog', () => {
  it('inMenu includes the imports-dialog detector, so a padded dialog still reaches the debounced recovery branch', () => {
    const m = src.match(/const inMenu = [^\n]+/)
    expect(m, 'inMenu assignment not found').not.toBeNull()
    expect(m![0]).toContain('detectsExternalImportsDialog(pane)')
    expect(m![0]).toContain('detectsBlockingMenu(pane)')
  })

  it('the alert-imports branch only alerts: no send-keys, no Escape, no dialog answer', () => {
    const start = src.indexOf("if (action === 'alert-imports')")
    expect(start, 'alert-imports branch not found').toBeGreaterThan(0)
    const end = src.indexOf("else if (action === 'alert-approval')", start)
    expect(end, 'alert-imports branch end not found').toBeGreaterThan(start)
    const branch = src.slice(start, end)
    expect(branch).toContain('alertExternalImportsDialogOnce(t.session)')
    expect(branch).not.toMatch(/send-keys|execFileSync|execFile\(|Escape'|tmux|runTmux|dismiss\w*\(|answerFirstRunGates|sendPromptToSession/)
  })

  it('the escape branch is still reached only through the decision, after the alert-imports branch', () => {
    const decide = src.indexOf('const action = decideMenuRecoveryAction(')
    const imports = src.indexOf("action === 'alert-imports'", decide)
    const escape = src.indexOf("action === 'escape'", decide)
    expect(decide).toBeGreaterThan(0)
    expect(imports).toBeGreaterThan(decide)
    expect(escape).toBeGreaterThan(imports)
  })
})
