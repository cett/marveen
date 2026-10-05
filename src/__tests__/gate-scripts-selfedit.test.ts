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

describe('"readers" that can write: the listed names are not a promise', () => {
  const P = 'scripts/hooks/egress-gate.mjs'
  const DENIED = [
    // sort
    `sort -o ${P} /tmp/in.txt`, `sort -ro ${P} /tmp/in.txt`, `sort /tmp/in.txt -o${P}`, `sort --output=${P} /tmp/in.txt`, `sort --output ${P} /tmp/in.txt`,
    `sort --out=${P} /tmp/in.txt`, `sort --compress-program=/tmp/evil ${P}`, `sort -T scripts/hooks ${P}`,
    // uniq: the second operand is an output file
    `uniq /tmp/in.txt ${P}`, `uniq -f 1 /tmp/in.txt ${P}`,
    // xxd: infile outfile, with or without -r
    `xxd -r /tmp/in.hex ${P}`, `xxd /tmp/in.bin ${P}`, `xxd -l 8 -r /tmp/in.hex ${P}`,
    // sed: w / W / s///w / e / r commands, -f script file, -i, a protected word in the script
    `sed -n 'w ${P}' /tmp/in.txt`, `sed 'W ${P}' /tmp/in.txt`, `sed 's/a/b/w ${P}' /tmp/in.txt`, `sed -n -e 'w scripts/hooks/x' /tmp/in.txt`,
    `sed --expression='w ${P}' /tmp/in.txt`, `sed 's/a/b/;w ${P}' /tmp/in.txt`, `sed -f /tmp/s.sed ${P}`, `sed -n '1e /tmp/evil' ${P}`, `sed 's/a/b/e' ${P}`,
    `sed -n 's|scripts/hooks/egress-gate.mjs|x|p' /tmp/in.txt`, `sed -n -e p -f /tmp/s.sed ${P}`,
    `sed '1r ${P}' /tmp/in.txt`, `sed -n '1{p;w /tmp/o}' ${P}`, `sed -i s/a/b/ ${P}`,
    // other listed names that write or exec
    `file -C -m ${P}`, `file -C ${P}`, `rg --pre /tmp/evil x ${P}`, `rg --pre=/tmp/evil x scripts/hooks`,
    `find scripts/hooks -fprint ${P}`, `find scripts/hooks -fprintf ${P} x`, `find scripts/hooks -fls ${P}`, `find scripts/hooks -exec sh -c x {} +`,
    `diff --output=${P} a b`, `cat --output=${P} a`, `ls --output=${P}`,
    // pagers are no longer treated as readers
    `less -o ${P} /tmp/in.txt`, `more ${P}`, `bat ${P}`,
  ]
  it.each(DENIED)('denies: %s', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })
  const ALLOWED = [
    `sort ${P}`, `sort -u ${P}`, `sort -rn -k2,2 -t, ${P}`, `sort ${P} | head -3`, `uniq ${P}`, `uniq -c ${P}`, `uniq -f 1 ${P}`, `xxd ${P}`, `xxd -l 16 -c 8 ${P}`, 'xxd -r -p < /tmp/in.hex',
    `sed -n '1,5p' ${P}`, `sed -n 5p ${P}`, `sed -n -e '1p' -e '3p' ${P}`, `sed 's/a/b/g' ${P}`, `sed -n '/error/p' ${P}`, `sed -E 's|a|b|' ${P}`, `sed '$d' ${P}`, `sed -n '2,$p' ${P}`,
    `file ${P}`, `file -b ${P}`, `rg -n egress ${P}`, 'rg -c x scripts/hooks', "find scripts/hooks -name '*.mjs'", 'find scripts/hooks -type f -newer scripts/lib/homoglyph.py',
    `diff ${P} /tmp/other.mjs`, `diff -u ${P} /tmp/other.mjs`, `cat ${P} | sort | uniq -c`,
  ]
  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command)).toEqual({ deny: false })
  })
})

describe('git: a safe subcommand is safe only without an option that writes a file or runs a program', () => {
  const P = 'scripts/hooks/egress-gate.mjs'
  const DENIED = [
    `git diff --output=${P}`, `git diff --output ${P}`, `git log --output=${P}`, `git show --output=${P} HEAD`, `git diff --outp=${P}`, `git diff --out=${P}`,
    `git diff-tree --output=${P} HEAD`, `git rev-list --output=${P} HEAD`,
    `git -c core.pager='sh -c x' diff ${P}`, `git -ccore.pager=evil diff ${P}`, `git --config-env=core.pager=X diff ${P}`, `git --exec-path=/tmp/e status ${P}`,
    `git grep -O/tmp/evil x ${P}`, 'git grep --open-files-in-pager=/tmp/evil x -- scripts/hooks',
    `GIT_EXTERNAL_DIFF=/tmp/evil git diff ${P}`, `GIT_PAGER=/tmp/evil git log ${P}`, `PAGER=/tmp/evil git log ${P}`, `LD_PRELOAD=/tmp/x.so cat ${P}`, `PATH=/tmp/evil cat ${P}`,
  ]
  it.each(DENIED)('denies: %s', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })
  const ALLOWED = [
    `git add ${P}`, 'git add scripts/hooks', 'git diff -- scripts/hooks', `git diff develop -- ${P}`, 'git diff --stat -- scripts/hooks', `git log --oneline -3 -- ${P}`,
    `git show HEAD:${P}`, 'git status --short scripts/hooks', 'git -C /some/worktree diff -- scripts/hooks', `git blame ${P}`, 'git ls-files scripts/hooks', 'git ls-files -o scripts/hooks',
    `git commit -m "wip" -- ${P}`, 'git grep -n egress -- scripts/hooks',
    `git diff HEAD -- scripts/hooks --output=${P}`, // after -- it is a pathspec, not an option
  ]
  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command)).toEqual({ deny: false })
  })
})

describe('directories that hold protected files: moved, removed or re-linked is denied; read, listed, entered is not', () => {
  const DENIED = [
    // the store directory (egress config lives in it)
    'mv store store.bak', 'rm -rf store', 'rm -r store/', 'ln -sfn /tmp/evil store', 'rename store store2', 'rsync -a /tmp/evil/ store/', 'tar -C store -xf /tmp/x.tar',
    'cp -r /tmp/evil store', 'cp -a /tmp/evil/. store', 'cd store && rm -rf .', 'cd store; mv . ../gone', 'chmod 000 store', 'find store -delete',
    `python3 -c "import shutil; shutil.rmtree('store')"`, 'git clean -fdx store', 'git rm -r store',
    // the install root
    'rm -rf .', 'mv . ../elsewhere', 'ln -sfn /tmp/evil .', 'rsync -a /tmp/evil/ ./', 'cp -r /tmp/evil/. .',
    // the scripts directory (strict: any non-read)
    'mv scripts scripts.bak', 'cp -r /tmp/new scripts', 'ln -sfn /tmp/evil scripts',
  ]
  it.each(DENIED)('denies: %s', (command) => {
    expect(bash(command)).toMatchObject({ deny: true })
  })
  const ALLOWED = [
    'ls store', 'ls -la store/', 'ls .', 'ls', 'cd store', 'cd store && ls', 'cd . && pwd', 'cat store/other.json', 'du -sh store', 'stat store', 'find store -name "*.json"', 'find . -maxdepth 1',
    'cp /tmp/notes.json store/', 'cp /tmp/a.txt .', 'touch /tmp/x', 'node scripts/unrelated-tool.mjs', 'git status', 'git diff', 'npm test', 'echo hi > /tmp/x',
    'python3 tools/run.py .', 'mkdir -p /tmp/work', 'rm store/other.json',
  ]
  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command)).toEqual({ deny: false })
  })
  it('the same moves inside a worktree copy are allowed (a different real path)', () => {
    for (const command of ['mv scripts scripts.bak', 'rm -rf .', 'ln -sfn /tmp/evil scripts', 'rm -rf scripts/hooks']) {
      expect({ command, r: bash(command, wt) }).toEqual({ command, r: { deny: false } })
    }
  })
  it('the deny reason of a store directory is the egress config, of the scripts directory the gate scripts', () => {
    expect(bash('mv store store.bak')).toEqual({ deny: true, reason: 'egress-allowlist' })
    expect(bash('mv scripts scripts.bak')).toEqual({ deny: true, reason: 'gate-scripts' })
  })
})

describe('Claude Code settings files: a sub-agent cannot switch its own gates off', () => {
  const HOOKS_OFF = '{"disableAllHooks": true}'
  const L = 'agents/boris/.claude/settings.local.json' // an agent that exists
  const S = 'agents/boris/.claude/settings.json'
  const C = 'agents/boris/.claude-config/settings.json'
  const NEW = 'agents/not-created-yet/.claude/settings.local.json' // an agent (and a .claude) that does not exist yet
  const ROOT_S = '.claude/settings.json'
  const ROOT_L = '.claude/settings.local.json'
  beforeEach(() => {
    for (const r of [root, wt]) {
      touch(join(r, 'agents', 'boris', '.claude', 'settings.json'), '{}')
      touch(join(r, 'agents', 'boris', '.claude', 'settings.local.json'), '{}')
      touch(join(r, 'agents', 'boris', '.claude', 'skills', 'x', 'SKILL.md'), '# x')
      touch(join(r, 'agents', 'boris', '.claude-config', 'settings.json'), '{}')
      touch(join(r, 'agents', 'boris', 'CLAUDE.md'), '# boris')
      touch(join(r, '.claude', 'settings.json'), '{}')
    }
  })

  const PATHS = [L, S, C, NEW, ROOT_S, ROOT_L, 'agents/boris/.claude-config/settings.local.json']
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    it.each(PATHS)(`${tool} on %s is denied as agent settings (absolute path)`, (rel) => {
      const input = tool === 'NotebookEdit' ? { notebook_path: join(root, rel) } : { file_path: join(root, rel), content: HOOKS_OFF }
      expect(gateDecision(tool, input, opts(root))).toEqual({ deny: true, reason: 'agent-settings' })
    })
  }
  it('a relative path is resolved against the payload cwd, a symlink is followed', () => {
    expect(file('Write', '.claude/settings.local.json', join(root, 'agents', 'boris')).reason).toBe('agent-settings')
    expect(file('Write', 'settings.local.json', join(root, 'agents', 'boris', '.claude')).reason).toBe('agent-settings')
    expect(file('Edit', '../../../.claude/settings.json', join(root, 'agents', 'boris', '.claude')).reason).toBe('agent-settings')
    const link = join(base, 'innocent.json')
    symlinkSync(join(root, L), link)
    expect(file('Write', link).reason).toBe('agent-settings')
    const dirLink = join(base, 'cfg')
    symlinkSync(join(root, 'agents', 'boris', '.claude'), dirLink)
    expect(file('Write', join(dirLink, 'settings.local.json')).reason).toBe('agent-settings')
  })
  it('creating settings.local.json where none exists yet is denied, in any agent directory', () => {
    expect(file('Write', join(root, 'agents', 'brand-new', '.claude', 'settings.local.json')).reason).toBe('agent-settings')
    expect(file('Write', join(root, 'agents', 'brand-new', '.claude-config', 'settings.local.json')).reason).toBe('agent-settings')
  })
  it('other files under an agent directory are not protected', () => {
    for (const rel of ['agents/boris/CLAUDE.md', 'agents/boris/.claude/skills/x/SKILL.md', 'agents/boris/.claude/other.json', 'agents/boris/notes/settings.json', 'agents/boris/settings.json', 'agents/boris/.claude/sub/settings.json', 'agents/boris/.claude-config/projects/p/settings.json']) {
      expect({ rel, r: file('Write', join(root, rel)) }).toEqual({ rel, r: { deny: false } })
    }
  })
  it('the same files in a git worktree copy are editable', () => {
    for (const rel of [...PATHS]) expect({ rel, r: file('Write', join(wt, rel), wt) }).toEqual({ rel, r: { deny: false } })
    expect(bash(`echo '${HOOKS_OFF}' > ${L}`, wt)).toEqual({ deny: false })
  })
  it('the user-global ~/.claude/settings.json is NOT covered (documented residual)', () => {
    expect(file('Write', '~/.claude/settings.json')).toEqual({ deny: false })
  })

  const DENIED = [
    `echo '${HOOKS_OFF}' > ${L}`, `echo '${HOOKS_OFF}' >> ${S}`, `echo '${HOOKS_OFF}' >| ${C}`, `echo '${HOOKS_OFF}' > ${NEW}`, `echo '${HOOKS_OFF}' > ${ROOT_L}`,
    `echo '${HOOKS_OFF}' &> ${L}`, `echo x >& ${L}`, `exec 3<> ${L}`, `printf '%s' '${HOOKS_OFF}' > "${L}"`, `echo x > '${L}'`,
    `echo '${HOOKS_OFF}' | tee ${L}`, `echo '${HOOKS_OFF}' | tee -a ${NEW}`, `tee ${S} < /tmp/x.json`,
    `cp /tmp/x.json ${L}`, `cp /tmp/x.json ${NEW}`, `mv /tmp/x.json ${S}`, `mv ${L} /tmp/gone.json`, `install -m 644 /tmp/x.json ${C}`, `rm ${L}`, `ln -sf /tmp/x.json ${L}`,
    `sed -i '' 's/a/b/' ${S}`, `sed -i.bak 's/a/b/' ${L}`, `perl -pi -e 's/a/b/' ${S}`, `truncate -s 0 ${L}`, `dd if=/tmp/x of=${L}`,
    `python3 -c "open('${L}','w').write('${HOOKS_OFF}')"`, `python3 -c "import json; json.dump({'disableAllHooks': True}, open('${NEW}','w'))"`,
    `node -e "require('fs').writeFileSync('${L}','${HOOKS_OFF}')"`, `ruby -e 'File.write("${S}","{}")'`, `python3 - <<PY\nopen("${L}","w").write("x")\nPY`,
    // jq reading is fine, jq writing through a redirect or a move is not
    `jq '.disableAllHooks=true' ${S} > ${S}`, `jq '.a=1' ${S} > /tmp/x.json && mv /tmp/x.json ${S}`, `jq -n '${HOOKS_OFF}' > ${L}`,
    // cwd, variables, globs, braces
    `cd agents/boris/.claude && echo '${HOOKS_OFF}' > settings.local.json`, `cd agents/boris/.claude-config; cp /tmp/x settings.json`, `cd agents/boris && echo x > .claude/settings.local.json`,
    `D=agents/boris/.claude; echo x > ${'$'}D/settings.local.json`, `cp /tmp/x agents/*/.claude/settings.local.json`, `cp /tmp/x agents/boris/.claude/settings.*`, `cp /tmp/x agents/boris/.claude/settings.{json,local.json}`,
    `cp /tmp/x agents/boris/.claude/settings.local.js?n`, `cp /tmp/x ${'$'}UNKNOWN/agents/boris/.claude/settings.local.json`,
    // the directories that hold them
    'mv agents/boris/.claude agents/boris/.claude.bak', 'rm -rf agents/boris/.claude-config', 'ln -sfn /tmp/evil agents/boris/.claude', 'rsync -a /tmp/evil/ agents/boris/.claude/', 'cp -r /tmp/evil agents/boris/.claude',
    'mv .claude .claude.bak', 'ln -sfn /tmp/evil .claude',
    // substitutions and ambiguous quoting next to a protected word
    `echo $(cp /tmp/x ${L})`, `cat '${L}' 2>&1`,
    // a copy into the directory creates <dir>/<basename of the source>: no word names the protected file
    'cp /tmp/settings.json agents/boris/.claude/', 'cp /tmp/settings.local.json agents/boris/.claude', 'cp /tmp/x/settings.local.json agents/boris/.claude-config/',
    'cp -t agents/boris/.claude /tmp/settings.json', 'cp --target-directory=agents/boris/.claude /tmp/settings.local.json', 'cp -pt agents/boris/.claude /tmp/settings.json',
    'cp -f /tmp/settings.json agents/boris/.claude/', 'cp /tmp/settings.json .claude/', 'cd agents/boris/.claude && cp /tmp/settings.json .', 'cd agents/boris/.claude && cp /tmp/settings.local.json ./',
    'cp /tmp/*.json agents/boris/.claude/', 'cp /tmp/settings.* agents/boris/.claude/', 'cp "$SRC" agents/boris/.claude/', 'cp /tmp/$NAME agents/boris/.claude-config/',
    // the names compare without regard to case (a file that does not exist yet keeps its spelling)
    'cp /tmp/x agents/boris/.CLAUDE/Settings.Local.json', 'echo x > agents/boris/.Claude/SETTINGS.JSON', 'echo x > agents/boris/.claude/Settings.json', 'cp /tmp/Settings.json agents/boris/.claude/',
    'echo x > agents/newone/.CLAUDE/SETTINGS.LOCAL.JSON', 'echo x > .CLAUDE/Settings.Local.json', 'echo x > .claude/SETTINGS.local.json', 'mv agents/boris/.CLAUDE agents/boris/gone', 'cp /tmp/x agents/*/.CLAUDE/SETTINGS.JSON',
  ]
  it.each(DENIED)('denies: %s', (command) => {
    expect(bash(command)).toEqual({ deny: true, reason: 'agent-settings' })
  })

  const ALLOWED = [
    `cat ${L}`, `cat ${S} 2>/dev/null`, `cat ${C} | jq .enabledPlugins`, `jq . ${S}`, `jq -r '.hooks | keys[]' ${S}`, `jq '.permissions' ${L} > /tmp/perm.json`,
    `grep -n disableAllHooks ${L}`, `grep -rn hooks agents/boris/.claude`, `head -5 ${S}`, `wc -l ${C}`, `ls -la agents/boris/.claude`, `ls agents/boris/.claude-config`, `stat ${L}`, `shasum -a 256 ${S}`,
    `diff ${S} ${C}`, `diff ${S} /tmp/other.json`, `cd agents/boris/.claude && cat settings.json`, `cd agents/boris/.claude && ls`, 'cd agents/boris/.claude',
    `git diff -- ${S}`, `git log --oneline -3 -- ${ROOT_S}`, `git status --short ${L}`,
    `sed -n '1,5p' ${S}`, 'find agents/boris/.claude -name "*.md"', 'cat agents/boris/CLAUDE.md', 'echo notes > agents/boris/notes.md',
    'cp /tmp/x.md agents/boris/.claude/skills/x/SKILL.md', 'echo x > agents/boris/.claude/other.json', 'mkdir -p agents/boris/.claude/skills/y', 'touch agents/boris/.claude/skills/y/SKILL.md',
    // the user-global file is the owner's: not covered, said in the gate header
    'cat ~/.claude/settings.json', 'jq .model ~/.claude/settings.json',
    // a copy into a directory that holds them is fine while the new name is not a settings file
    'cp /tmp/x.md agents/boris/.claude/', 'cp /tmp/a.md /tmp/b.md agents/boris/.claude/skills/', 'cp -t agents/boris/.claude /tmp/other.json', 'cp /tmp/settings.json agents/boris/', 'cp /tmp/settings.json agents/boris/notes/',
    'cp /tmp/settings.json /tmp/copy.json', 'cp /tmp/*.md agents/boris/.claude/', 'cd agents/boris/.claude && cp /tmp/x.md .',
  ]
  it.each(ALLOWED)('allows: %s', (command) => {
    expect(bash(command)).toEqual({ deny: false })
  })

  it('the hook end to end: a Write of {"disableAllHooks": true} is denied, with the settings message, and the owner is named', () => {
    const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
    const installRoot = dirname(dirname(hook))
    const run = (payload: unknown) => spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf-8' })
    const target = join(installRoot, 'agents', 'someone', '.claude', 'settings.local.json')
    const out = JSON.parse(run({ tool_name: 'Write', tool_input: { file_path: target, content: HOOKS_OFF }, cwd: installRoot }).stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('fo agenst')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('tulajdonost')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('disableAllHooks')
    const bashOut = JSON.parse(run({ tool_name: 'Bash', tool_input: { command: `echo '${HOOKS_OFF}' > agents/someone/.claude/settings.local.json` }, cwd: installRoot }).stdout)
    expect(bashOut.hookSpecificOutput.permissionDecision).toBe('deny')
    const read = run({ tool_name: 'Bash', tool_input: { command: 'cat agents/someone/.claude/settings.local.json' }, cwd: installRoot })
    expect(read.stdout).toBe('')
  })
})

describe('a copy into the store directory creates a file named like the source', () => {
  it('cp <anything named egress-allowlist.json> store/ is denied; other names still pass', () => {
    expect(bash('cp /tmp/egress-allowlist.json store/')).toEqual({ deny: true, reason: 'egress-allowlist' })
    expect(bash('cp -t store /tmp/egress-vendor-hosts.json')).toEqual({ deny: true, reason: 'egress-allowlist' })
    expect(bash('cp /tmp/*.json store/')).toEqual({ deny: true, reason: 'egress-allowlist' })
    expect(bash('cp /tmp/x.json store/')).toEqual({ deny: false })
    expect(bash('cp /tmp/x.json store')).toEqual({ deny: false })
  })
})
