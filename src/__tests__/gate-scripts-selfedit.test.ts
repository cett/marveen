// A sub-agent may not rewrite the gates that bind it: the gate and hook scripts of THIS install
// (scripts/self-pace-gate.mjs, scripts/email-send-gate.mjs, scripts/hooks/, scripts/lib/) and the
// store config that widens egress (egress-allowlist.json, egress-vendor-hosts.json, the runtime
// cache). The protected set is a set of REAL PATHS under the install, so a git worktree copy, a
// plain run and a plain read keep working.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, protectedSet, bashProtectedDecision, splitShell, tokenizeShell } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let base: string // the tmp world (NOT a realpath on macOS: /var -> /private/var)
let root: string // the install
let wt: string // a git worktree copy of it
const SCRIPTS = () => join(root, 'scripts')
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gate-scripts-'))
  root = join(base, 'marveen')
  wt = join(base, 'worktrees', 'feat')
  for (const r of [root, wt]) {
    touch(join(r, 'scripts', 'self-pace-gate.mjs'))
    touch(join(r, 'scripts', 'email-send-gate.mjs'))
    touch(join(r, 'scripts', 'unrelated.sh'))
    touch(join(r, 'scripts', 'hooks', 'egress-gate.mjs'))
    touch(join(r, 'scripts', 'hooks', 'memory-save.sh'))
    touch(join(r, 'scripts', 'lib', 'homoglyph.py'))
    touch(join(r, 'templates', 'egress-vendor-hosts.json'), '{"hosts":[]}')
  }
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
  touch(join(root, 'store', 'egress-vendor-hosts.json'), '{"hosts":[]}')
  touch(join(root, 'store', '.egress-allowlist-cache.json'), '{"fetchedAt":0}')
  touch(join(root, 'store', 'egress-vendor-hosts.history', 'h.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: SCRIPTS(), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const file = (tool: string, file_path: string, cwd = root) => gateDecision(tool, { file_path, content: 'x' }, opts(cwd))
const bash = (command: string, cwd = root) => gateDecision('Bash', { command }, opts(cwd))

const PROTECTED_FILES = [
  'scripts/self-pace-gate.mjs',
  'scripts/email-send-gate.mjs',
  'scripts/hooks/egress-gate.mjs',
  'scripts/hooks/a-hook-that-does-not-exist-yet.py',
  'scripts/hooks/__pycache__/x.pyc',
  'scripts/lib/homoglyph.py',
]
const STORE_FILES = [
  'store/egress-allowlist.json',
  'store/egress-vendor-hosts.json',
  'store/.egress-allowlist-cache.json',
  'store/egress-vendor-hosts.history/h.json',
  'store/egress-allowlist.history/new.json',
]

describe('native file tools: denied by name and by resolved real path', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    it.each(PROTECTED_FILES)(`${tool} on %s (absolute) is denied as a gate script`, (rel) => {
      const input = tool === 'NotebookEdit' ? { notebook_path: join(root, rel) } : { file_path: join(root, rel) }
      expect(gateDecision(tool, input, opts(root))).toEqual({ deny: true, reason: 'gate-scripts' })
    })
    it.each(STORE_FILES)(`${tool} on %s is denied as egress config`, (rel) => {
      const input = tool === 'NotebookEdit' ? { notebook_path: join(root, rel) } : { file_path: join(root, rel) }
      expect(gateDecision(tool, input, opts(root))).toEqual({ deny: true, reason: 'egress-allowlist' })
    })
  }
  it('a relative path is resolved against the payload cwd', () => {
    expect(file('Edit', 'scripts/hooks/egress-gate.mjs', root).deny).toBe(true)
    expect(file('Edit', 'self-pace-gate.mjs', SCRIPTS()).deny).toBe(true)
    expect(file('Edit', '../scripts/lib/homoglyph.py', join(root, 'store')).deny).toBe(true)
    expect(file('Write', 'egress-vendor-hosts.json', join(root, 'store')).deny).toBe(true)
  })
  it('a path with .. segments that lands on a protected file is denied', () => {
    expect(file('Write', join(root, 'scripts', 'unrelated', '..', 'hooks', 'egress-gate.mjs')).deny).toBe(true)
  })
  it('a symlink under another name, in or out of the install, is followed', () => {
    const link = join(base, 'innocent.mjs')
    symlinkSync(join(root, 'scripts', 'self-pace-gate.mjs'), link)
    expect(file('Write', link).reason).toBe('gate-scripts')
    const dirLink = join(wt, 'shortcut')
    symlinkSync(join(root, 'scripts', 'hooks'), dirLink)
    expect(file('Write', join(dirLink, 'brand-new.py')).reason).toBe('gate-scripts')
    const storeLink = join(base, 'v.json')
    symlinkSync(join(root, 'store', 'egress-vendor-hosts.json'), storeLink)
    expect(file('Edit', storeLink).reason).toBe('egress-allowlist')
  })
  it('the SAME files in a git worktree copy are editable', () => {
    for (const rel of PROTECTED_FILES) expect(file('Edit', join(wt, rel), wt)).toEqual({ deny: false })
    expect(file('Edit', 'scripts/hooks/egress-gate.mjs', wt)).toEqual({ deny: false })
  })
  it('other files are not protected: scripts/unrelated.sh, the template, a tmp file', () => {
    // DECISION: the protected set is the gate / hook executables and their libraries, not every file in scripts/.
    expect(file('Edit', join(root, 'scripts', 'unrelated.sh'))).toEqual({ deny: false })
    expect(file('Edit', join(root, 'templates', 'egress-vendor-hosts.json'))).toEqual({ deny: false })
    expect(file('Write', join(base, 'x.txt'))).toEqual({ deny: false })
    expect(file('Write', join(root, 'store', 'other.json'))).toEqual({ deny: false })
  })
})

describe('Bash: plain reads and plain runs stay allowed', () => {
  const ALLOWED = [
    'cat scripts/self-pace-gate.mjs',
    'cat scripts/self-pace-gate.mjs 2>/dev/null',
    'cat scripts/self-pace-gate.mjs > /tmp/copy.mjs',
    'grep -rn egress scripts/hooks',
    'grep -c foo scripts/lib/homoglyph.py',
    'head -20 scripts/email-send-gate.mjs',
    'diff scripts/hooks/egress-gate.mjs /tmp/other.mjs',
    'ls -la scripts/hooks',
    'ls scripts',
    'wc -l scripts/lib/*.py',
    'shasum -a 256 scripts/self-pace-gate.mjs',
    'stat scripts/hooks/egress-gate.mjs',
    "sed -n '1,5p' scripts/hooks/egress-gate.mjs",
    "find scripts/hooks -name '*.py'",
    'jq . store/egress-vendor-hosts.json',
    'cat store/egress-vendor-hosts.json',
    'cat store/.egress-allowlist-cache.json',
    // plain RUNS of a hook script
    'node scripts/hooks/egress-gate.mjs',
    'node --check scripts/hooks/egress-gate.mjs',
    'python3 scripts/hooks/destructive-gate.py arg1 arg2 < /dev/null',
    'bash scripts/hooks/memory-save.sh note',
    './scripts/hooks/memory-save.sh note',
    'FOO=1 node scripts/hooks/egress-gate.mjs',
    'node scripts/hooks/egress-gate.mjs < payload.json | jq .',
    // version control on the files
    'git add scripts/hooks/egress-gate.mjs',
    'git diff develop -- scripts/self-pace-gate.mjs',
    'git status --short scripts/hooks',
    'git log --oneline -3 -- scripts/lib/homoglyph.py',
    // talking about a path is not touching it
    'echo "see scripts/hooks/egress-gate.mjs"',
    'cd scripts/hooks && ls',
    'cat scripts/hooks/egress-gate.mjs | grep egress | head -3',
    'ls scripts/hooks | sort | tee /tmp/listing.txt',
    'cd scripts && cat self-pace-gate.mjs',
    // other files in scripts/ are not protected
    'cp /tmp/a.sh scripts/unrelated.sh',
    'sed -i "" s/a/b/ scripts/unrelated.sh',
    'cp /tmp/x templates/egress-vendor-hosts.json',
  ]
  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command)).toEqual({ deny: false })
  })
  it('the same writes inside a git worktree copy are allowed (absolute and relative)', () => {
    for (const command of [
      `cp /tmp/x ${wt}/scripts/hooks/egress-gate.mjs`,
      `echo x > ${wt}/scripts/self-pace-gate.mjs`,
      `sed -i '' s/a/b/ ${wt}/scripts/lib/homoglyph.py`,
      `python3 -c "open('${wt}/scripts/hooks/new.py','w')"`,
      `cd ${wt}/scripts/hooks && cp /tmp/x egress-gate.mjs`,
      `WT=${wt}; cp /tmp/x $WT/scripts/hooks/egress-gate.mjs`,
      `tee ${wt}/scripts/email-send-gate.mjs < /tmp/x`,
    ]) expect({ command, r: bash(command, wt) }).toEqual({ command, r: { deny: false } })
    for (const command of ['cp /tmp/x scripts/hooks/egress-gate.mjs', 'echo x > scripts/self-pace-gate.mjs', "sed -i '' s/a/b/ scripts/lib/homoglyph.py", 'rm scripts/hooks/memory-save.sh']) {
      expect({ command, r: bash(command, wt) }).toEqual({ command, r: { deny: false } })
    }
  })
})

describe('Bash: fail-closed on anything that could write a protected path', () => {
  const DENIED_SCRIPTS = [
    'cat /dev/null > scripts/self-pace-gate.mjs',
    '> scripts/self-pace-gate.mjs',
    'echo x >> scripts/email-send-gate.mjs',
    'echo x >| scripts/hooks/egress-gate.mjs',
    'echo x &> scripts/hooks/egress-gate.mjs',
    'cat a >& scripts/hooks/egress-gate.mjs',
    'cat a 2>&scripts/hooks/egress-gate.mjs',
    'echo x 3<> scripts/lib/homoglyph.py',
    'exec 3<>scripts/self-pace-gate.mjs',
    'cp /tmp/x scripts/hooks/egress-gate.mjs',
    '/bin/cp /tmp/x scripts/hooks/egress-gate.mjs',
    'mv /tmp/x scripts/self-pace-gate.mjs',
    'mv scripts/hooks/egress-gate.mjs /tmp/gone',
    'cat /tmp/x | tee scripts/hooks/egress-gate.mjs',
    "sed -i '' 's/a/b/' scripts/self-pace-gate.mjs",
    'sed -i.bak s/a/b/ scripts/hooks/egress-gate.mjs',
    "perl -pi -e 's/a/b/' scripts/hooks/egress-gate.mjs",
    'ln -sf /tmp/x scripts/hooks/egress-gate.mjs',
    'truncate -s 0 scripts/self-pace-gate.mjs',
    'dd if=/tmp/x of=scripts/self-pace-gate.mjs',
    'chmod 000 scripts/hooks/egress-gate.mjs',
    'rm scripts/hooks/egress-gate.mjs',
    'rm -rf scripts/hooks',
    'rm -rf scripts/lib',
    'mv scripts scripts.bak',
    'cp -r /tmp/new scripts',
    'find scripts/hooks -delete',
    'find scripts/hooks -name "*.py" -exec rm {} +',
    'echo scripts/hooks/egress-gate.mjs | xargs rm',
    'ls scripts/hooks | xargs rm',
    'cat scripts/hooks/egress-gate.mjs | python3 -c "import sys"',
    'git checkout -- scripts/hooks/egress-gate.mjs',
    'git restore scripts/self-pace-gate.mjs',
    // interpreters
    `python3 -c "open('scripts/hooks/egress-gate.mjs','w').write('')"`,
    `python3 -c "import pathlib; pathlib.Path('scripts/self-pace-gate.mjs').write_text('')"`,
    `node -e "require('fs').writeFileSync('scripts/self-pace-gate.mjs','')"`,
    `ruby -e 'File.write("scripts/hooks/egress-gate.mjs","")'`,
    'python3 - <<PY\nopen("scripts/hooks/egress-gate.mjs","w").write("")\nPY',
    'python3 tools/edit.py scripts/hooks/egress-gate.mjs',
    // a run is the file as the SCRIPT operand only: any other protected word denies
    'python3 scripts/hooks/destructive-gate.py scripts/self-pace-gate.mjs',
    'node scripts/hooks/egress-gate.mjs --out scripts/lib/homoglyph.py',
    'node -r scripts/hooks/egress-gate.mjs app.js',
    'bash -c "cp /tmp/x scripts/hooks/egress-gate.mjs"',
    // globs and braces
    'cp /tmp/x scripts/hooks/*',
    'cp /tmp/x scripts/hook?/egress-gate.mjs',
    'cp /tmp/x scripts/self-pace*',
    'cp /tmp/x scripts/{hooks,lib}/new.py',
    'cp /tmp/x scripts/hooks/{a,b}.py',
    // cwd tracked through cd
    'cd scripts/hooks && cp /tmp/x egress-gate.mjs',
    'cd scripts && cp /tmp/x self-pace-gate.mjs',
    'cd scripts; echo x > email-send-gate.mjs',
    'cd scripts/hooks && echo x > brand-new.sh',
    // variables
    `R=${'$'}PWD; cp /tmp/x $R/scripts/hooks/egress-gate.mjs`,
    // quoting and escaping around the name
    'cp /tmp/x "scripts/hooks/egress-gate.mjs"',
    "cp /tmp/x 'scripts/hooks/egress-gate.mjs'",
    'cp /tmp/x scripts/hooks/egress\\-gate.mjs',
    'cp /tmp/x scripts/hooks/egr""ess-gate.mjs',
    'echo x > "scripts/self-pace-gate.mjs"',
    "echo x > 'scripts/self-pace-gate.mjs'",
    // substitutions next to a protected word
    'echo $(cp /tmp/x scripts/hooks/egress-gate.mjs)',
    'echo "$(cp /tmp/x scripts/hooks/egress-gate.mjs)"',
    'echo `cp /tmp/x scripts/hooks/egress-gate.mjs`',
    'cat a >(tee scripts/hooks/egress-gate.mjs)',
    // an apostrophe in a heredoc body must not hide the next command
    "cat <<EOF\ndon't\nEOF\ncp /tmp/x scripts/hooks/egress-gate.mjs 'a'",
    // an unterminated quote with a protected word
    "cat 'unterminated scripts/self-pace-gate.mjs",
    // ambiguous mention (quotes next to the name) plus any redirect operator
    "cat 'scripts/self-pace-gate.mjs' 2>&1",
  ]
  it.each(DENIED_SCRIPTS)('denies: %s', (command) => {
    expect(bash(command)).toEqual({ deny: true, reason: 'gate-scripts' })
  })

  it('a relative path that climbs out of the cwd onto a protected path is denied', () => {
    expect(bash('cp /tmp/x ../scripts/hooks/egress-gate.mjs', join(root, 'store')).deny).toBe(true)
    expect(bash('cp /tmp/x ../scripts/hooks/egress-gate.mjs', join(wt, 'store')).deny).toBe(false)
  })

  it('an unresolvable cd leaves only the basenames of the protected files: still denied', () => {
    expect(bash('cd "$SOMEWHERE" && cp /tmp/x self-pace-gate.mjs').deny).toBe(true)
    expect(bash('cd "$SOMEWHERE" && cp /tmp/x egress-gate.mjs').deny).toBe(true)
    expect(bash('cd "$SOMEWHERE" && cp /tmp/x notes.txt').deny).toBe(false)
  })

  it('an unresolved variable in front of a literal tail that matches a protected path is denied for writes, allowed for reads and runs', () => {
    const tailOfRealFile = 'scripts/hooks/egress-gate.mjs'
    expect(bash(`cp /tmp/x $UNKNOWN/${tailOfRealFile}`).deny).toBe(true)
    expect(bash(`cat $UNKNOWN/${tailOfRealFile}`).deny).toBe(false)
    expect(bash(`node $UNKNOWN/${tailOfRealFile}`).deny).toBe(false)
    expect(bash('cp /tmp/x $UNKNOWN/hooks/new.py').deny).toBe(false) // one segment of tail: not decidable, pinned
  })

  const DENIED_STORE = [
    `echo '{"hosts":["example.org"]}' > store/egress-vendor-hosts.json`,
    'cp /tmp/x store/egress-vendor-hosts.json',
    'cp /tmp/x store/.egress-allowlist-cache.json',
    `python3 -c "open('store/egress-vendor-hosts.json','w').write('{}')"`,
    'rm -rf store/egress-vendor-hosts.history',
    'cat a > store/egress-vendor-hosts.history/h.json',
    'cd store && echo x > egress-vendor-hosts.json',
    'jq ".hosts += [\\"x\\"]" store/egress-vendor-hosts.json > store/egress-vendor-hosts.json',
    "echo x > 'store/.egress-allowlist-cache.json'",
    'cat a >& store/.egress-allowlist-cache.json',
    'exec 4<>store/egress-vendor-hosts.json',
  ]
  it.each(DENIED_STORE)('denies (egress config): %s', (command) => {
    expect(bash(command)).toEqual({ deny: true, reason: 'egress-allowlist' })
  })

  it('the old allowlist cases keep their reason', () => {
    expect(bash("echo '{}' > store/egress-allowlist.json")).toEqual({ deny: true, reason: 'egress-allowlist' })
    expect(bash('cat store/egress-allowlist.json')).toEqual({ deny: false })
  })
})

describe('Bash: redirect forms are read shell-aware', () => {
  it('splits and tokenizes the operators', () => {
    expect(tokenizeShell('cat a >& out.txt').redirects).toEqual(['out.txt'])
    expect(tokenizeShell('cat a 2>&1').redirects).toEqual([])
    expect(tokenizeShell('cat a 2>&1').hasRedirect).toBe(true)
    expect(tokenizeShell('cat a 3<> f').redirects).toEqual(['f'])
    expect(tokenizeShell("cat a > 'sp ace'").redirects).toEqual(['sp ace'])
    expect(tokenizeShell('cat a >| f').redirects).toEqual(['f'])
    expect(tokenizeShell('cat a &>> f').redirects).toEqual(['f'])
    expect(tokenizeShell('cat < in.txt').redirects).toEqual([])
    expect(tokenizeShell('cat <<EOF').redirects).toEqual([])
    expect(splitShell('a >&2 && b &> c | d; e & f').segs).toEqual(['a >&2 ', ' b &> c ', ' d', ' e ', ' f'])
  })
})

describe('the hook end to end, and where it is wired', () => {
  const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
  const installScripts = dirname(hook)
  const run = (payload: unknown) => spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf-8' })

  it('a Write to a hook of THIS install is denied with the scripts message, which sends the sub-agent to the main agent', () => {
    const r = run({ tool_name: 'Write', tool_input: { file_path: join(installScripts, 'hooks', 'new-hook.py'), content: 'x' }, cwd: installScripts })
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('fo agenst')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('scripts/hooks')
  })
  it('a Bash redirect onto the gate itself is denied, a read of it passes', () => {
    const denied = run({ tool_name: 'Bash', tool_input: { command: 'cat /dev/null > scripts/self-pace-gate.mjs' }, cwd: dirname(installScripts) })
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    const read = run({ tool_name: 'Bash', tool_input: { command: 'cat scripts/self-pace-gate.mjs' }, cwd: dirname(installScripts) })
    expect(read.stdout).toBe('')
    expect(read.status).toBe(0)
  })
  it('a copy of the gate set elsewhere (a worktree) is not protected by THIS install\'s gate', () => {
    const r = run({ tool_name: 'Write', tool_input: { file_path: join(wt, 'scripts', 'self-pace-gate.mjs'), content: 'x' }, cwd: wt })
    expect(r.stdout).toBe('')
  })
  it('protectedSet derives from the script location: real paths under scripts/ and store/', () => {
    const set = protectedSet({})
    const real = realpathSync(installScripts)
    const paths = set.entries.map((e: { real: string }) => e.real)
    expect(paths).toContain(join(real, 'self-pace-gate.mjs'))
    expect(paths).toContain(join(real, 'email-send-gate.mjs'))
    expect(paths).toContain(join(real, 'hooks'))
    expect(paths).toContain(join(real, 'lib'))
    expect(paths).toContain(join(dirname(real), 'store', 'egress-vendor-hosts.json'))
    expect(paths).toContain(join(dirname(real), 'store', '.egress-allowlist-cache.json'))
    expect(set.entries.every((e: { real: string }) => e.real.startsWith(dirname(real) + '/'))).toBe(true)
  })
  it('the decision function takes no tool but Bash and the four file tools into account', () => {
    expect(bashProtectedDecision('ls', { ...opts(root) })).toEqual({ deny: false })
    expect(gateDecision('Read', { file_path: join(root, 'scripts', 'self-pace-gate.mjs') }, opts(root))).toEqual({ deny: false })
  })
})
