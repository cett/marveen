// C3: the protected gate set must equal HEAD. A deploy (HEAD moves, tree clean) is silent; a changed,
// staged, deleted or stray file in the protected set is reported. Detection only: nothing is blocked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { checkProtectedIntegrity, integrityAlert, protectedPathspecs } from '../../scripts/protected-integrity.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { protectedSet } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

let base: string
let root: string
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: root, stdio: 'pipe' })
const FILES = [
  'scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/doctor.sh', 'scripts/agent-api.sh', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py',
  'scripts/other-tool.sh', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts', 'src/index.ts', '.claude/settings.json',
]
const check = () => checkProtectedIntegrity({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store') })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'integrity-')))
  root = join(base, 'install')
  for (const f of FILES) touch(join(root, f))
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('C3: the protected set equals HEAD', () => {
  it('a clean install is ok and says nothing', () => {
    const r = check()
    expect(r).toEqual({ ok: true, modified: [], untracked: [], error: null })
    expect(integrityAlert(r)).toBeNull()
  })
  it('a changed protected file is reported, staged or not', () => {
    touch(join(root, 'scripts/doctor.sh'), 'changed\n')
    expect(check().modified).toEqual(['scripts/doctor.sh'])
    git('add', 'scripts/doctor.sh') // staged only: still differs from HEAD
    expect(check().modified).toEqual(['scripts/doctor.sh'])
    touch(join(root, 'scripts/hooks/egress-gate.mjs'), 'changed\n')
    expect(check().modified).toEqual(['scripts/doctor.sh', 'scripts/hooks/egress-gate.mjs'])
  })
  it('a deleted protected file is reported', () => {
    unlinkSync(join(root, 'scripts/email-send-gate.mjs'))
    expect(check().modified).toEqual(['scripts/email-send-gate.mjs'])
  })
  it('a stray file in a protected directory is reported, a stray file elsewhere is not', () => {
    touch(join(root, 'scripts/hooks/extra-hook.mjs'))
    expect(check().untracked).toEqual(['scripts/hooks/extra-hook.mjs'])
    rmSync(join(root, 'scripts/hooks/extra-hook.mjs'))
    touch(join(root, 'src/new-file.ts'))
    touch(join(root, 'scripts/new-unprotected-tool.sh'))
    expect(check().ok).toBe(true)
  })
  it('an ignored file (a compiled cache) in a protected directory is not a stray file', () => {
    touch(join(root, '.gitignore'), '__pycache__/\n*.pyc\n'); git('add', '.gitignore'); git('commit', '-q', '-m', 'ignore')
    touch(join(root, 'scripts/hooks/__pycache__/x.pyc'))
    expect(check().ok).toBe(true)
  })
  it('a change to a file outside the protected set, the settings files included, does not trip', () => {
    touch(join(root, 'src/index.ts'), 'changed\n')
    touch(join(root, 'scripts/other-tool.sh'), 'changed\n')
    touch(join(root, '.claude/settings.json'), '{"changed":true}\n')
    expect(check()).toEqual({ ok: true, modified: [], untracked: [], error: null })
  })
  it('a deploy (HEAD moves, the tree is clean) does not trip', () => {
    touch(join(root, 'scripts/self-pace-gate.mjs'), '// new version\n')
    git('add', '-A'); git('commit', '-q', '-m', 'deploy')
    expect(check().ok).toBe(true)
  })
  it('a change made BEFORE a commit and then committed is a deploy; the same change made after is not', () => {
    touch(join(root, 'scripts/lib/homoglyph.py'), 'v2\n'); git('add', '-A'); git('commit', '-q', '-m', 'v2')
    expect(check().ok).toBe(true)
    touch(join(root, 'scripts/lib/homoglyph.py'), 'v3 by hand\n')
    expect(check().modified).toEqual(['scripts/lib/homoglyph.py'])
  })
  it('git that cannot answer is an error, never a silent ok', () => {
    const plain = join(base, 'plain')
    for (const f of FILES) touch(join(plain, f))
    const r = checkProtectedIntegrity({ scriptsDir: join(plain, 'scripts'), storeDir: join(plain, 'store') })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(integrityAlert(r)).toContain('could not run')
  })
  it('the pathspecs are the committed gate files only (no store, no settings), relative to the install', () => {
    const specs = protectedPathspecs(protectedSet({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store') }), root)
    expect(specs).toContain('scripts/self-pace-gate.mjs')
    expect(specs).toContain('scripts/hooks')
    expect(specs).toContain('src/security/secret-gate.ts')
    expect(specs.some((s: string) => s.startsWith('store') || s.includes('settings'))).toBe(false)
  })
  it('the alert names what changed', () => {
    touch(join(root, 'scripts/doctor.sh'), 'changed\n'); touch(join(root, 'scripts/lib/stray.py'))
    const msg = integrityAlert(check())
    expect(msg).toContain('differ from HEAD: scripts/doctor.sh')
    expect(msg).toContain('untracked: scripts/lib/stray.py')
  })
})
