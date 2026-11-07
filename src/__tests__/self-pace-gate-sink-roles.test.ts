// R-SINK: the self-pace gate asks which operand a command WRITES, not whether a protected path appears.
// Copying the gate files out, archiving the tree, listing or unpacking an archive that lives in a protected
// directory only READ them. The destination, the archive that is created, the extraction directory (-C, -d or
// the cwd) and every form that is not understood stay refused. The fixture is a real git install.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashProtectedDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

let base: string
let root: string // the install (a git repository)
let wt: string // a linked worktree outside it
let out: string // an unprotected directory outside the install

const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, stdio: 'pipe' })
const FILES = [
  'scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/doctor.sh', 'scripts/agent-api.sh', 'scripts/sync-hooks.sh',
  'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'scripts/hooks/egress-gate.mjs', 'scripts/hooks/bundle.zip', 'scripts/lib/homoglyph.py',
  'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts', 'src/index.ts', 'agents/agent-a/notes.md', 'store/egress-allowlist.json',
]

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sink-roles-')))
  root = join(base, 'install'); wt = join(base, 'wt'); out = join(base, 'out')
  for (const f of FILES) touch(join(root, f))
  mkdirSync(out, { recursive: true })
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'feat-a')
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const decide = (command: string, cwd = root) => bashProtectedDecision(command, { scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (c: string, cwd = root) => decide(c, cwd).deny === true

// hand-written: the protected path is only READ
const READS = [
  () => `cp -r src ${out}/x`, () => `cp -r scripts ${out}/x`, () => `cp scripts/doctor.sh ${out}/d.sh`, () => `cp -t ${out} scripts/doctor.sh scripts/agent-api.sh`,
  () => `cp -a scripts/hooks ${out}/`, () => `install scripts/doctor.sh ${out}/d.sh`, () => `install -m 644 scripts/doctor.sh ${out}/d.sh`,
  () => `tar czf ${out}/o.tgz src`, () => `tar czf ${out}/o.tgz scripts store`, () => `tar -czf ${out}/o.tgz scripts`, () => `tar --create --file=${out}/o.tgz scripts`,
  () => `tar tzf scripts/hooks/a.tgz`, () => `tar df ${out}/o.tgz scripts`, () => `tar xzf scripts/hooks/a.tgz -C ${out}`, () => `tar -xzf scripts/hooks/a.tgz --directory=${out}`,
  () => `rsync -a src/ ${out}/`, () => `rsync -av scripts/doctor.sh ${out}/`, () => `rsync -a --exclude node_modules src/ ${out}/`, () => `rsync -a --delete scripts/ ${out}/s/`,
  () => `unzip -l scripts/hooks/bundle.zip`, () => `unzip -p scripts/hooks/bundle.zip x`, () => `unzip scripts/hooks/bundle.zip -d ${out}`, () => `unzip -q scripts/hooks/bundle.zip -d${out}`,
  () => `dd if=scripts/doctor.sh of=${out}/d.sh`, () => `dd if=scripts/doctor.sh`,
  () => 'find scripts -exec grep -l needle {} \\;', () => "find scripts -name '*.mjs' -exec cat {} +", () => 'find src -type f -execdir wc -l {} \\;',
  () => 'git diff -- scripts', () => 'git log --oneline -- scripts', () => 'git grep needle -- scripts', () => 'git show HEAD -- scripts/doctor.sh',
  () => 'shellcheck scripts/doctor.sh',
]
// hand-written: the protected path is WRITTEN, or the form is not understood
const WRITES = [
  () => `cp ${out}/x scripts/doctor.sh`, () => `cp -r ${out}/. scripts/`, () => `cp -t scripts ${out}/doctor.sh`, () => `cp ${out}/x scripts/hooks/`,
  () => `cp -l scripts/doctor.sh ${out}/d.sh`, () => `cp -s scripts/doctor.sh ${out}/d.sh`, () => `cp --link scripts/doctor.sh ${out}/d.sh`,
  () => `install ${out}/x scripts/doctor.sh`, () => 'install -d scripts/hooks/newdir', () => `install -t scripts ${out}/doctor.sh`,
  () => `rsync -a ${out}/ scripts/`, () => `rsync -a src/ scripts/hooks/`, () => `rsync -a ${out}/ scripts/doctor.sh --exclude x`, () => `rsync -a --remove-source-files scripts/ ${out}/`,
  () => `rsync -a --log-file=scripts/doctor.sh src/ ${out}/`, () => `rsync -a --unknown-flag src/ ${out}/`,
  () => `tar xzf ${out}/a.tgz -C scripts`, () => `tar xzf ${out}/a.tgz --directory=scripts`, () => `tar xzf ${out}/a.tgz -Cscripts`, () => `tar czf scripts/doctor.sh src`,
  () => `tar czf ${out}/o.tgz src --remove-files`, () => `tar czf ${out}/o.tgz src --to-command=cat`, () => `tar rf scripts/hooks/a.tar src`, () => `tar xzf ${out}/a.tgz scripts/doctor.sh -C scripts`,
  () => `mv scripts/doctor.sh ${out}/d.sh`, () => `mv ${out}/x scripts/doctor.sh`, () => `mv src ${out}/s`, () => `ln -sf ${out}/x scripts/doctor.sh`, () => `ln scripts/doctor.sh ${out}/h`,
  () => `unzip ${out}/a.zip -d scripts`, () => `unzip -o ${out}/a.zip -dscripts/hooks`,
  () => `dd of=scripts/doctor.sh if=${out}/x`, () => `dd if=scripts/doctor.sh of=scripts/hooks/x`,
  () => `X=scripts/doctor.sh cp ${out}/a ${out}/b`,
  // review round: option values and abbreviations that the parser must not mistake for operands or ignore
  () => `tar tf ${out}/o.tar --index-file=scripts/doctor.sh`, () => `tar czf ${out}/o.tgz src --index-file=scripts/doctor.sh`,
  () => `tar -xPf ${root}/scripts/hooks/a.tgz`, () => `tar xzf ${root}/scripts/hooks/a.tgz --absolute-names`, () => `tar czf ${out}/o.tgz scripts --remove-f`, () => `tar czf ${out}/o.tgz scripts --to-c=cat`,
  () => `cp --lin scripts/doctor.sh ${out}/d.sh`, () => `cp --symbolic scripts/doctor.sh ${out}/d.sh`, () => `cp --parent scripts/doctor.sh ${out}/d`, () => `cp --target-dir=${out} scripts/doctor.sh`,
  () => 'find vendor -exec xxd + scripts/doctor.sh \\;', () => 'find scripts -exec rm {} \\;', () => "find scripts -exec sh -c 'x' {} \\;", () => 'find scripts -delete', () => 'find scripts -exec cat {} \\; -delete', () => 'find scripts -exec cat {}',
]

describe('R-SINK: a protected path that is only read is not a write', () => {
  it('reads, copies out, archives and lists are allowed from the install root', () => {
    for (const f of READS) expect(denied(f()), f()).toBe(false)
  })
  it('the destination, the created archive, links and unknown forms stay refused', () => {
    for (const f of WRITES) expect(denied(f()), f()).toBe(true)
  })
  it('the same reads are allowed from a subdirectory of the install', () => {
    for (const c of ['cp -r ../scripts /tmp/sink-x', 'tar czf /tmp/sink-o.tgz ../scripts', 'rsync -a ../src/ /tmp/sink-out/'])
      expect(denied(c, join(root, 'src')), c).toBe(false)
  })
})

describe('R-SINK: the extraction directory is the cwd unless -C or -d says otherwise', () => {
  it('unpacking into the install tree without a directory is refused, in a worktree it is not', () => {
    for (const cwd of [root, join(root, 'agents', 'agent-a'), join(root, 'src')]) {
      expect(denied(`tar xzf ${out}/a.tgz`, cwd), `tar @ ${cwd}`).toBe(true)
      expect(denied(`tar -xf ${out}/a.tar`, cwd), `tar -xf @ ${cwd}`).toBe(true)
      expect(denied(`unzip ${out}/a.zip`, cwd), `unzip @ ${cwd}`).toBe(true)
      expect(denied(`unzip -o ${out}/a.zip x`, cwd), `unzip -o @ ${cwd}`).toBe(true)
    }
    expect(denied(`tar xzf ${out}/a.tgz`, wt)).toBe(false)
    expect(denied(`unzip ${out}/a.zip`, wt)).toBe(false)
    expect(denied(`tar xzf ${out}/a.tgz`, out)).toBe(false)
  })
  it('-C and -d move the extraction directory out of the install, or into it', () => {
    expect(denied(`tar xzf ${out}/a.tgz -C ${out}`, root)).toBe(false)
    expect(denied(`tar xzf ${out}/a.tgz -C ${wt}`, root)).toBe(false)
    expect(denied(`unzip ${out}/a.zip -d ${out}`, root)).toBe(false)
    // a NAMED directory is judged by the path it names (members are relative to it): a plain directory of the
    // install is not a protected one, the gate directories are
    expect(denied(`tar xzf ${out}/a.tgz -C ${root}/vendor`, wt)).toBe(false)
    expect(denied(`unzip ${out}/a.zip -d ${root}/vendor`, wt)).toBe(false)
    expect(denied(`tar xzf ${out}/a.tgz -C ${root}/scripts/hooks`, wt)).toBe(true)
    expect(denied(`unzip ${out}/a.zip -d ${root}`, wt)).toBe(true)
  })
  it('absolute member names (-P) can land anywhere, so no cwd makes the extraction safe', () => {
    expect(denied(`tar -xPf ${root}/scripts/hooks/a.tgz`, out)).toBe(true)
    expect(denied(`tar xzf ${root}/scripts/hooks/a.tgz --absolute-names`, out)).toBe(true)
    expect(denied(`tar -xzf ${root}/scripts/hooks/a.tgz`, out)).toBe(false)
  })
  it('a value letter ends the flags of an unzip bundle: -xp is an exclude pattern, not "pipe"', () => {
    expect(denied(`unzip -xp ${out}/a.zip`, root)).toBe(true)
    expect(denied(`unzip -dp ${out}/a.zip`, root)).toBe(false) // a NAMED directory (p), judged by the path
    expect(denied(`unzip -p ${out}/a.zip`, root)).toBe(false)
  })
  it('listing and creating do not extract, so the cwd does not matter', () => {
    expect(denied(`tar tzf ${out}/a.tgz`, root)).toBe(false)
    expect(denied(`tar czf ${out}/o.tgz src`, root)).toBe(false)
    expect(denied(`unzip -l ${out}/a.zip`, root)).toBe(false)
  })
})
