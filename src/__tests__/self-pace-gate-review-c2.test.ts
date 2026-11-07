// Review of the copy / archive role rules and the nested text commands (independent read of the sink-role commits):
// R1 an unresolved variable in the destination takes the read relief away, R2 a tar line the parser does not
// understand is judged by the cwd tree, R3 / R4 the unzip target is read the way unzip reads it, R5 the nested
// text commands have a cost budget. Every cell is paired with its contrast, so a mutant that loosens or tightens
// the rule flips one of them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashProtectedDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

let base: string
let root: string // the install: a git repository
let wt: string // a linked worktree outside the install
let plain: string // a directory outside any install

const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, stdio: 'pipe' })
const FILES = ['scripts/self-pace-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/doctor.sh', 'src/index.ts', 'agents/agent-a/notes.md', 'store/egress-allowlist.json']

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'review-c2-')))
  root = join(base, 'install'); wt = join(base, 'wt'); plain = join(base, 'plain')
  for (const f of FILES) touch(join(root, f))
  mkdirSync(plain, { recursive: true })
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'feat-a')
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const decide = (c: string, cwd: string) => bashProtectedDecision(c.replaceAll('@B@', base), opts(cwd))
const denied = (c: string, cwd: string) => decide(c, cwd).deny === true

describe('R1: a destination, -t / -f value or last operand that is an unresolved variable takes the read relief away', () => {
  const WRITES = [
    'cp out/f scripts/hooks/x $E', 'cp -t $E scripts/hooks out/f', 'cp --target-directory=$E scripts/hooks out/f', 'cp -t ${E} scripts/hooks out/f',
    'cp -t ${E:-} scripts/hooks out/f', 'cp -t $@ scripts/hooks out/f', 'install -t $E scripts/hooks f', 'rsync -a out/ scripts/hooks/ $E', 'tar -cf $E scripts/hooks/x.tar src',
  ]
  it('LIMIT-free: each of them can overwrite the protected path when the variable is empty, so it is denied', () => {
    for (const c of WRITES) expect(denied(c, root), c).toBe(true)
  })
  it('the same commands with a literal destination outside the install are still reads', () => {
    for (const c of ['cp out/f scripts/hooks/x @B@/out', 'cp -t @B@/out scripts/hooks out/f', 'install -t @B@/out scripts/hooks f', 'rsync -a out/ scripts/hooks/ @B@/out', 'tar -cf @B@/x.tar scripts/hooks/x.tar src'])
      expect(denied(c, root), c).toBe(false)
  })
  it('the price: a destination that is a variable is no longer a read, even for a plain copy-out', () => {
    expect(denied('cp scripts/doctor.sh "$OUT"', root)).toBe(true)
    expect(denied('cp scripts/doctor.sh @B@/out/', root)).toBe(false)
  })
})

describe('R2: a tar line the parser does not understand is judged by the tree of the cwd', () => {
  const ODD = ['tar --sort=name --mtime=@0 -cf x.tgz foo', 'tar -czf x.tgz --exclude-caches foo', 'tar --no-mac-metadata -czf x.tgz foo', 'tar -xf a.tar --keep-old-files -C out']
  it('from a directory outside the install every one of them is allowed', () => {
    for (const c of ODD) expect(denied(c, plain), c).toBe(false)
    for (const c of ODD) expect(denied(c, wt), c).toBe(false)
  })
  it('in the install (the cwd tree, or a -C inside it) they are denied', () => {
    expect(denied('tar --sort=name -xf a.tar', root)).toBe(true) // no -C: the cwd tree
    expect(denied('tar -xf a.tar --keep-old-files -C ../install/src', wt)).toBe(true)
    expect(denied('tar -xPf a.tar -C ../install/scripts', plain)).toBe(true)
  })
  it('a named -C directory decides over the cwd: an extraction OUT of the install from the install cwd is allowed', () => {
    expect(denied('tar -xf a.tar --keep-old-files -C @B@/out', root)).toBe(false)
  })
  it('a line the parser rejects is refused wherever it runs: absolute names, a program to run, an unknown or abbreviated option', () => {
    for (const c of ['tar -xPf a.tar -C out', 'tar -xf a.tar --absolute-names', 'tar -xf a.tar --to-command=cat', 'tar --use-compress-program=x -xf a.tar',
      'tar --exclude-caches -xf a.tar --dir=$X', 'tar --exclude-caches -xf a.tar --cd $X'])
      for (const cwd of [plain, wt, root]) expect(denied(c, cwd), `${c} @ ${cwd}`).toBe(true)
  })
  it('a one-letter long option (--d, --c, --x, --t) is an abbreviation, not a mode: refused wherever it runs', () => {
    // --d is the abbreviation of --directory (among others): it used to hit the one-letter mode key d, so the line parsed and
    // its directory was dropped, and the extraction was judged by the cwd
    for (const c of ['tar -xf a.tar --d=out', 'tar -xf a.tar --d=$X', 'tar --exclude-caches -xf a.tar --d=$X', 'tar -xf a.tar --d out', 'tar -xf a.tar --c=out', 'tar -xf a.tar --x', 'tar -f a.tar --t'])
      for (const cwd of [plain, wt, root]) expect(denied(c, cwd), `${c} @ ${cwd}`).toBe(true)
  })
  it('the full long mode names still parse: from outside the install they are allowed, in the install they are denied', () => {
    for (const c of ['tar --extract --file a.tar', 'tar --create --file x.tgz foo', 'tar --list --file a.tar', 'tar --get --file a.tar', 'tar --diff --file a.tar']) {
      expect(denied(c, plain), c).toBe(false)
    }
    expect(denied('tar --extract --file a.tar', root)).toBe(true)
  })
})

describe('R3 / R4: the unzip target is read the way unzip reads it', () => {
  it('a bundled -d (-qd, -od, -jd, -qdDIR) names the target: outside is allowed, inside the install is denied', () => {
    for (const c of ['unzip -qd @B@/out a.zip', 'unzip -od @B@/out a.zip', 'unzip -jd @B@/out a.zip', 'unzip -qd@B@/out a.zip']) {
      expect(denied(c, root), c).toBe(false)
      expect(denied(c, join(root, 'agents', 'agent-a')), c).toBe(false)
    }
    for (const c of ['unzip -qd scripts/hooks a.zip', 'unzip -od scripts/lib a.zip', 'unzip -jd src a.zip', 'unzip -qdscripts/hooks a.zip', 'unzip -dscripts/hooks a.zip']) expect(denied(c, root), c).toBe(true)
  })
  it('an attached -d value that names no protected path is the command own business (a plain directory in the install)', () => {
    for (const c of ['unzip -qdp a.zip', 'unzip -dp a.zip', 'unzip -qdbuild a.zip']) expect(denied(c, root), c).toBe(false)
  })
  it('an attached -d value that cannot be read (variable, substitution, glob) is an unknown directory: judged by the tree', () => {
    for (const c of ['unzip -qd$X a.zip', 'unzip -qd`pwd` a.zip', 'unzip -qd* a.zip']) {
      expect(denied(c, root), c).toBe(true)
      expect(denied(c, plain), c).toBe(true) // an unknown directory is refused wherever the command runs, like any unreadable target
    }
  })
  it('the value of -P / -O / -I / -x is never taken for -d: the archive then extracts into the cwd', () => {
    for (const c of ['unzip -P -d out/ok.zip', 'unzip -O -d out/ok.zip', 'unzip -I -d out/ok.zip']) {
      expect(denied(c, root), c).toBe(true) // into the install
      expect(denied(c, plain), c).toBe(false) // into a directory outside it
    }
    expect(denied('unzip a.zip -x -d', root)).toBe(true)
  })
  it('a real -d after a password still names the target', () => {
    expect(denied('unzip -P secret -d @B@/out a.zip', root)).toBe(false)
    expect(denied('unzip -P secret -d scripts/hooks a.zip', root)).toBe(true)
  })
})

describe('R5: nested text commands have a cost budget', () => {
  // every level visits `n` directories with plain relative `cd name` (CDPATH could redirect it, so they all stay in
  // the set of bases), and hands the next level over as a double-quoted text
  const dq = (t: string) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const nest = (levels: number, cds: number) => {
    const cd = Array(cds).fill('cd a').join('; ')
    let t = 'true'
    for (let i = 0; i < levels; i++) t = `${cd}; sh -c ${dq(t)}`
    return t
  }
  it('three levels with twenty directories each are refused quickly with a plain reason', () => {
    const t0 = Date.now()
    const d = decide(nest(3, 20), wt)
    expect(d).toEqual({ deny: true, reason: 'eval-budget' })
    // the reason above is what a missing counter breaks (it then takes minutes); the time bound only guards the cost on a loaded runner
    // (a missing counter takes minutes, so a generous bound still tells them apart; 4 s flaked in the full parallel suite)
    expect(Date.now() - t0).toBeLessThan(20000)
  }, 60000)
  it('a small nesting is judged in full and allowed, and a real write inside it is still denied', () => {
    expect(denied(nest(3, 2), wt)).toBe(false)
    const cd = 'cd a; cd a'
    expect(denied(`${cd}; sh -c ${dq(`${cd}; sh -c ${dq(`cd ${root} && git checkout other`)}`)}`, wt)).toBe(true)
  })
})
