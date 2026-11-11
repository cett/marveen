// A call of the fleet API wrapper (agent-api.sh) carries its JSON body in a single-quoted argument. That body is data for the
// script (a message text, a note), not a command and not a path: a protected word, a pipe, a `$( )` or a `>` INSIDE the single
// quotes must not make the gate refuse the call. This is narrow on purpose:
//   - only the wrapper itself (the protected file, by its resolved path), run directly or as the script of a shell
//   - only single-quoted spans AFTER the wrapper; never the target of a redirect (`> '...'`), never a double-quoted span
//     (a live `$( )` is live), never a protected path spelled as an argument outside quotes
//   - any other command keeps reading a quoted protected word piece by piece (`python3 -c '...'`, `sh -c '...'`)
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a worktree copy
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'api-body-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(agentCwd, { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command }, opts(cwd)).deny)
const everywhere = (c: string) => ({ c, agent: denied(c, agentCwd), root: denied(c, root), copy: denied(c, wt) })
const FREE = (c: string) => ({ c, agent: false, root: false, copy: false })
const GATE = () => join(root, 'scripts', 'self-pace-gate.mjs')
const HOOKS = () => join(root, 'scripts', 'hooks')
const API = () => join(root, 'scripts', 'agent-api.sh')

describe('the single-quoted body of an agent-api.sh call is data', () => {
  it('a protected path, a pipe into xargs, a $( ) and a > inside the body do not refuse the call', () => {
    const bodies = [
      () => `'{"content":"see ${HOOKS()}"}'`,
      () => `'{"content":"${HOOKS()} | xargs rm"}'`,
      () => `'{"content":"run $(cat ${HOOKS()}/x)"}'`,
      () => `'{"content":"a > ${GATE()}"}'`,
      () => `'{"content":"${GATE()}; rm x"}'`,
      () => `'{"content":"it'\\''s ${HOOKS()}"}'`, // an escaped single quote inside the body
      () => `'{"content":"\`rm ${GATE()}\`"}'`,
    ]
    for (const b of bodies) {
      for (const c of [`bash ${API()} POST /api/messages ${b()}`, `${API()} POST /api/messages ${b()}`, `bash ${API()} --agent agent-a POST /api/messages ${b()}`, `sh ${API()} POST /api/x ${b()} | cat`,
        `bash -u ${API()} POST /api/x ${b()}`, `bash -eu ${API()} POST /api/x ${b()}`, `bash -uv ${API()} POST /api/x ${b()}`, `bash -u -v ${API()} POST /api/x ${b()}`,
        `bash ${API()} --token admin --max-time 5 --with-status POST /api/x ${b()}`, `bash ${API()} --agent agent-a -- POST /api/x ${b()}`]) {
        expect(everywhere(c)).toEqual(FREE(c))
      }
    }
  })
  it('a system shell by its path is the same as the bare name', () => {
    for (const sh of ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
      const c = `${sh} ${API()} POST /api/x '{"content":"${HOOKS()} | xargs rm"}'`
      expect(everywhere(c)).toEqual(FREE(c))
    }
  })
  it('a bare wrapper name is looked up in PATH, not in the directory: not masked', () => {
    const c = `agent-api.sh POST /api/x '${GATE()}'`
    expect(denied(c, join(root, 'scripts'))).toBe(true)
    const d = `bash agent-api.sh POST /api/x '{"c":"${HOOKS()}"}'`
    expect(denied(d, join(root, 'scripts'))).toBe(true)
  })
  it('a plain call without a quoted protected word is free as before', () => {
    const c = `bash ${API()} GET /api/blackboard`
    expect(everywhere(c)).toEqual(FREE(c))
  })
})

describe('the exception does not reach anything else', () => {
  it.each([
    // the same quoted text in another command is still a command line the gate reads piece by piece
    () => `python3 -c 'open("${GATE()}","w")'`,
    () => `sh -c 'rm ${GATE()}'`,
    () => `echo '${GATE()}' | xargs rm`,
    () => `rm '${GATE()}'`,
    // the wrapper with a redirect: the target is not data (plain, quoted, appended, an fd)
    () => `bash ${API()} POST /api/x '{}' > ${GATE()}`,
    () => `bash ${API()} POST /api/x '{}' > '${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' >> '${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' 2>'${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' &>'${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' >|'${GATE()}'`,
    // a redirect target built from several quoted pieces is cut in the middle by nothing: a word with anything attached to its
    // quotes is kept whole
    () => `bash ${API()} POST /api/x '{}' >""'${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' 2>""'${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' >>''"${GATE()}"`,
    () => `bash ${API()} POST /api/x '{}' >& '${GATE()}'`, // a redirect operator that is a word of its own
    () => `bash ${API()} POST /api/x '{}' >| '${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' >   '${GATE()}'`,
    () => `bash ${API()} POST /api/x '{}' >\\'${GATE()}'`,
    // a protected path as an argument outside quotes, a live substitution in double quotes
    () => `bash ${API()} POST /api/x ${GATE()}`,
    () => `bash ${API()} POST /api/x "{\\"c\\":\\"$(cat ${HOOKS()}/x)\\"}"`,
    // another command in the same line
    () => `bash ${API()} POST /api/x '{}'; rm ${GATE()}`,
    () => `bash ${API()} POST /api/x '{}' && sh -c 'rm ${GATE()}'`,
    // only the spans AFTER the wrapper are data; a quoted word in front of it, and an option value (`--out='...'`), are not
    () => `X='${GATE()}' bash ${API()} POST /api/x '{}'`,
    () => `bash ${API()} POST /api/x --out='${GATE()}'`,
    () => `bash -o '${GATE()}' ${API()} POST /api/x '{}'`, // a quoted word between the shell and the wrapper
    () => `bash ${API()} POST /api/x '{}' >&'${GATE()}'`, // >&word writes the file when the word is not a descriptor
    () => `bash ${API()} POST /api/x '{}' "$(cat ${HOOKS()}/x)"`, // a double-quoted span next to a single-quoted body: the $( ) is live
    () => `bash -c ${API()} '${GATE()}'`, // inline code: kept strict, the wrapper is not "run as a script" there
    // code in a live substitution runs, and the single-quoted words inside it are paths, not a body
    () => `bash ${API()} POST /api/x $(rm '${GATE()}' )`,
    () => `bash ${API()} POST /api/x '{}' $(rm '${GATE()}' )`,
    () => `bash ${API()} POST /api/x \`rm '${GATE()}' \``,
    () => `bash ${API()} POST /api/x >(tee '${GATE()}' )`,
    () => `bash ${API()} POST /api/x <(cat '${GATE()}' )`,
    () => `bash ${API()} POST /api/x "$(rm '${GATE()}' )"`,
    () => `bash ${API()} POST /api/x '{}' "\`rm '${GATE()}' \`"`,
    // the same, with the quoted word AT the body position (the third positional word)
    () => `bash ${API()} POST $(rm '${GATE()}' )`,
    () => `bash ${API()} POST \`rm '${GATE()}' \``,
    () => `bash ${API()} POST >(tee '${GATE()}' )`,
    () => `bash ${API()} POST <(cat '${GATE()}' )`,
    () => `bash ${API()} POST "$(echo" '${GATE()}' ")"`,
    () => `bash ${API()} POST "\`echo" '${GATE()}' "\`"`,
    // and a redirect operator that is a word of its own, at the body position
    () => `bash ${API()} POST > '${GATE()}'`,
    () => `bash ${API()} POST >& '${GATE()}'`,
    () => `bash ${API()} POST >| '${GATE()}'`,
    // only the body, the third positional, is data: the method, the path and any later word are read as they are
    () => `bash ${API()} POST '${GATE()}'`,
    () => `bash ${API()} '${GATE()}' /api/x`,
    () => `bash ${API()} POST /api/x '{}' '${GATE()}'`,
    () => `bash ${API()} --agent '${GATE()}' POST /api/x '{}'`,
    () => `bash ${API()} -- POST /api/x '{}' '${GATE()}'`,
    () => `bash ${API()} --with-status POST /api/x '{}' '${GATE()}'`,
    // a comment opens no quote in the shell, but it does in the splitter: the lines after `# '` are commands that run
    () => `bash ${API()} POST /api/x # '\nrm ${GATE()}\n'`,
    () => `bash ${API()} POST /api/x '{}' # '\nrm ${GATE()}\n'`,
    () => `bash ${API()} POST /api/x '{}'\r\nrm ${GATE()}`,
    // a body with a real newline inside is not masked (kept strict): the protected word in it is still read
    () => `bash ${API()} POST /api/x '{"c":"a\n${HOOKS()}"}'`,
    // xtrace runs a PS4 (a substitution in it is code), and anything in front of the command word may set it: no masking
    () => `PS4='$(rm "$3")' bash -x ${API()} POST /api/x '${GATE()}'`,
    () => `bash -x ${API()} POST /api/x '${GATE()}'`,
    () => `bash -xv ${API()} POST /api/x '${GATE()}'`,
    () => `SHELLOPTS=xtrace PS4='$(rm "$3")' bash ${API()} POST /api/x '${GATE()}'`,
    () => `env PS4='$(rm "$3")' SHELLOPTS=xtrace bash ${API()} POST /api/x '${GATE()}'`,
    () => `DASHBOARD_BASE_URL=http://localhost:1 bash ${API()} POST /api/x '{"c":"${HOOKS()}"}'`, // any setting in front: kept strict
    () => `nice bash ${API()} POST /api/x '{"c":"${HOOKS()}"}'`,
    // `bash` or the wrapper given another meaning: a function, an alias, a moved PATH, a shell that is not a system shell
    () => `bash() { rm "$4"; }; bash ${API()} POST /api/x '${GATE()}'`,
    () => `function bash { rm "$4"; }; bash ${API()} POST /api/x '${GATE()}'`,
    () => `alias bash='rm "$4" #'; bash ${API()} POST /api/x '${GATE()}'`,
    () => `PATH=/nowhere:$PATH bash ${API()} POST /api/x '${GATE()}'`,
    () => `export PATH=/nowhere; bash ${API()} POST /api/x '${GATE()}'`,
    () => `BASH_ENV=/nowhere bash ${API()} POST /api/x '${GATE()}'`,
    () => `./bash ${API()} POST /api/x '${GATE()}'`,
    () => `${join(base, 'bash')} ${API()} POST /api/x '${GATE()}'`,
    // a shell option that changes what the shell runs: the wrapper path is then only a positional parameter, not the script
    () => `bash -s ${API()} POST /api/x '${GATE()}'`,
    () => `echo 'rm "$3"' | bash -s ${API()} POST /api/x '${GATE()}'`,
    () => `bash -i ${API()} POST /api/x '${GATE()}'`,
    () => `bash -O extglob ${API()} POST /api/x '${GATE()}'`,
    () => `bash -o pipefail ${API()} POST /api/x '${GATE()}'`,
    () => `bash +O extglob ${API()} POST /api/x '${GATE()}'`,
    () => `bash --rcfile x ${API()} POST /api/x '${GATE()}'`,
    () => `bash --init-file x ${API()} POST /api/x '${GATE()}'`,
    () => `bash -l ${API()} POST /api/x '${GATE()}'`,
    () => `bash -sx ${API()} POST /api/x '${GATE()}'`,
    // a shell that is handed inline code is not "running the wrapper"
    () => `bash -c 'rm ${GATE()}' ${API()}`,
    // another protected script, and a look-alike name outside the install
    () => `bash ${join(root, 'scripts', 'doctor.sh')} '{"c":"${HOOKS()}"}'`,
    () => `bash ${join(root, 'scripts', 'doctor.sh')} POST /api/x '{"c":"${HOOKS()}"}'`, // the same shape as a wrapper call, another protected script
    () => `bash ${join(root, 'scripts', 'sync-hooks.sh')} a b '{"c":"${HOOKS()}"}'`,
    () => `bash ${join(base, 'agent-api.sh')} POST /api/x '{"c":"${HOOKS()}"}'`,
  ])('still refused in the install: %#', (mk) => {
    const c = mk()
    expect({ c, root: denied(c, root) }).toEqual({ c, root: true })
  })
})
