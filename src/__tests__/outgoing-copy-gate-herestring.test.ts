import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { segmentsTokens } from '../../scripts/email-send-gate.mjs'

// The python (main-agent) side of the send gate reads a shell's here-string as a script, like the JS twin
// (email-send-gate.mjs). The verdict per shape lives in the shared list (send-invocation-cases.json, run through
// BOTH gates by send-invocation-conformance.test.ts); this file pins what only the python side has:
//   1. the depth bound (a refusal, not a silent pass) and the CPU cost of hostile input;
//   2. the whole main-agent send path (call_is_send of email-approval-gate.py = copy gate OR the mail reader), so
//      the shapes the copy gate alone does not read (eval, source <(echo), builtin, a continuation) stay recognised
//      as a send ON THE MAIN AGENT'S PATH, and no harmless look-alike becomes one.
// Placeholder recipient: the example domain, no real address.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
const APPROVAL_GATE = join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py')
const EXTRACT = join(ROOT, 'scripts', 'lib', 'email_extract.py')

const X = 'sendmail a@example.com'

/** Single-quote a script for the shell (the way a person nests one script in another). */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** `bash <<< 'bash <<< ... X'`, `levels` here-strings deep. */
const nest = (levels: number, base = X) => {
  let cmd = base
  for (let i = 0; i < levels; i++) cmd = `bash <<< ${q(cmd)}`
  return cmd
}

type Verdict = { result: boolean | null; raised: string | null; cpu: number }

// One python process per call: the commands arrive as JSON on stdin (no shell quoting in the way).
function copyGateVerdicts(cmds: string[]): Verdict[] {
  const out = execFileSync('python3', ['-I', '-c', `
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'hooks'))}); spec.loader.exec_module(g)
res = []
for c in json.load(sys.stdin):
    t = time.process_time()
    try:
        res.append({"result": bool(g.is_send_invocation(c)), "raised": None, "cpu": time.process_time() - t})
    except g.InspectionLimit as e:
        res.append({"result": None, "raised": "InspectionLimit", "cpu": time.process_time() - t})
print(json.dumps(res))
`], { encoding: 'utf-8', input: JSON.stringify(cmds), maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out.trim())
}

// The main agent's whole classification: email-approval-gate.call_is_send with the REAL copy gate and mail reader.
function mainPathVerdicts(cmds: string[]): boolean[] {
  const out = execFileSync('python3', ['-I', '-c', `
import importlib.util, json, sys
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.path.insert(0, path.rsplit("/", 1)[0]); spec.loader.exec_module(m); return m
copy_gate = load("ocg", ${JSON.stringify(GATE)})
extract = load("emx", ${JSON.stringify(EXTRACT)})
appr = load("eag", ${JSON.stringify(APPROVAL_GATE)})
print(json.dumps([bool(appr.call_is_send("Bash", {"command": c}, copy_gate, extract)) for c in json.load(sys.stdin)]))
`], { encoding: 'utf-8', input: JSON.stringify(cmds), maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out.trim())
}

// The tokenizer facts behind the verdicts, compared with the JS twin word for word.
function pythonTokens(cmds: string[]): string[][][] {
  const out = execFileSync('python3', ['-I', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'hooks'))}); spec.loader.exec_module(g)
print(json.dumps([g._segments_tokens(c) for c in json.load(sys.stdin)]))
`], { encoding: 'utf-8', input: JSON.stringify(cmds) })
  return JSON.parse(out.trim())
}

describe('python copy gate: tokenizer facts, identical to the JS twin', () => {
  const CMDS = [
    "bash<<<'x'", // the here-string operator is a word of its own
    "bash 2>&1 <<< 'x'", // the & of a redirect stays inside its word
    'cmd &> out',
    'echo hi >&2',
    'a 2>&1 && b & c', // a real && and & still end a command
  ]

  it('python and JS cut the same words', () => {
    const py = pythonTokens(CMDS)
    CMDS.forEach((c, i) => expect(py[i], c).toEqual(segmentsTokens(c)))
  })

  it('the cut is the expected one (not just equal to JS)', () => {
    const py = pythonTokens(CMDS)
    expect(py).toEqual([
      [['bash', '<<<', 'x']],
      [['bash', '2>&1', '<<<', 'x']],
      [['cmd', '&>', 'out']],
      [['echo', 'hi', '>&2']],
      [['a', '2>&1'], ['b'], ['c']],
    ])
  })
})

describe('python copy gate: comments are cut the way the shell cuts them (before the lexer reads the line)', () => {
  const SEND = 'python3 -m send --to a@example.com'
  it('a quote in a trailing comment no longer sends the line to the weaker literal fallback', () => {
    // Before the comment cut: the apostrophe left a quote open, the lexer failed, and only the strong literals
    // (send.py, sendmail ...) were searched: `-m send` slipped through. Measured on the way to this fix.
    const cmds = [`${SEND} # don't`, `bash -c '${SEND}' # it's`, `ls # don't\n${SEND}`, `ls # "\n${SEND}`]
    expect(copyGateVerdicts(cmds).map((v) => v.result)).toEqual([true, true, true, true])
  })

  it('a comment sign after ; | ( ) & starts a comment: its apostrophe must not hide the next line', () => {
    // Pins the set of characters that may precede a comment sign. Narrowed to whitespace only, `ls;# it's` would
    // keep its apostrophe open, the line would fall to the weaker fallback and the sender on the next line is lost.
    const cmds = ["ls;# it's", "ls |# it's", "(ls)# it's", "ls &# it's"].map((c) => `${c}\n${SEND}`)
    expect(copyGateVerdicts(cmds).map((v) => v.result)).toEqual([true, true, true, true])
  })

  it('a whole-line comment no longer swallows the next line', () => {
    expect(copyGateVerdicts([`# whole line comment\n${X}`, `x=1 # c\n${X}`]).map((v) => v.result)).toEqual([true, true])
  })

  it('a # inside a word is no comment; text after a comment sign at command position stays DATA', () => {
    const v = copyGateVerdicts([
      `ls # ${X}`, // the sender's name sits in a comment, nothing runs it: data
      `echo a#b; ${X}`, // not a comment: the sender runs
      `echo $#; ${X}`,
    ]).map((r) => r.result)
    expect(v).toEqual([false, true, true])
  })

  it('BOTH readings count (comments cut, comments kept): a mistake of the comment cutter cannot hide a send', () => {
    // Shapes where a comment cutter that models the shell imperfectly would cut too much (found by the automatic
    // review): a backslash-newline before the #, an ANSI-C quote holding an escaped quote, a substitution inside
    // double quotes. The comment-kept reading (the JS twin's) still sees the sender in each.
    const cmds = [
      `echo a\\\n#b; ${X}`,
      `echo $'\\' #'; ${X}`,
      `echo "$(echo \\")" #"; ${X}`,
      `echo a # b; ${X}`, // the sender sits inside a comment: the shell would not run it, the gate still reads it (stricter, as the JS gate)
    ]
    expect(copyGateVerdicts(cmds).map((v) => v.result)).toEqual([true, true, true, true])
  })
})

describe('python copy gate: here-string depth bound and hostile input', () => {
  it('a sender eight here-strings deep is still found', () => {
    expect(copyGateVerdicts([nest(8)])[0].result).toBe(true)
  })

  it('nine deep is REFUSED (InspectionLimit), not waved through', () => {
    const [v] = copyGateVerdicts([nest(9)])
    expect(v.raised).toBe('InspectionLimit')
    expect(v.result).toBeNull()
  })

  it('the hook turns the refusal into exit 2 (a real PreToolUse JSON; the command is only read)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-gate-'))
    try {
      const run = (command: string) => spawnSync('python3', ['-I', GATE], {
        encoding: 'utf-8',
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }),
        // the gate log lands next to the rules file: keep it out of the work tree
        env: { ...process.env, OUTGOING_COPY_GATE_RULES: join(dir, 'rules.json') },
      })
      const deep = run(nest(9))
      expect(deep.status, deep.stderr).toBe(2)
      expect(deep.stderr).toContain('KIMENO-SZOVEG KAPU: TILTVA')
      // control: a harmless one-level here-string passes this gate
      const ok = run("bash <<< 'echo hi'")
      expect(ok.status, ok.stderr).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hostile input stays cheap in CPU time (a wall clock would measure the machine, not the gate)', () => {
    const verdicts = copyGateVerdicts([
      'bash' + ' <<<"echo hi"'.repeat(9000), // ~117 KB, 9000 here-strings, no heredoc opener
      'ls >&2 '.repeat(18000), // ~126 KB of redirect-&
      nest(8, 'echo hi'), // the deepest accepted chain
    ])
    for (const v of verdicts) {
      expect(v.raised).toBeNull()
      expect(v.cpu).toBeLessThan(3) // measured 0.1 s; the hook timeout is 10 s
    }
    expect(verdicts.map((v) => v.result)).toEqual([false, false, false])
  })

  it('nested scripts holding a # and a substitution at every level stay cheap (each text is read once per level)', () => {
    // Each level: a shell, a here-string holding the level below, a `;`, an echo, a substitution and a comment.
    // Without the per-call memo the two comment readings and the flatten reading multiply by 4 per level
    // (measured 7 s of CPU at 8 levels, the hook timeout is 10 s).
    let cmd = X
    for (let i = 0; i < 8; i++) cmd = `bash <<< ${q(cmd)}; echo $(true) # c`
    const [v] = copyGateVerdicts([cmd])
    expect(v.raised).toBeNull()
    expect(v.result).toBe(true)
    expect(v.cpu).toBeLessThan(1)
  })

  it('more than the heredoc-opener limit of `<<< \'x\'` is refused up front (the scan counts them)', () => {
    const [v] = copyGateVerdicts(['bash' + " <<< 'echo hi'".repeat(40)])
    expect(v.raised).toBe('InspectionLimit')
  })
})

// On the main agent's path the coverage has TWO layers: the word-based mail reader (scripts/lib/email_extract.py,
// command_sends_mail: a mail program named in a word of any command that is not just looking at files, and an
// exec wrapper handed a run-time word) and is_send_invocation (position-based, bound to the JS twin by the shared
// list). eval, source / . <(echo), bash <(echo), builtin and a continuation rest on the FIRST layer alone; the
// here-string is the shape the first layer cannot see (the script is a redirect operand, not a word). The tests
// below pin the whole decision, so a change of either layer cannot reopen a shape unnoticed.
describe('main-agent send path (copy gate OR mail reader): every shape of the list', () => {
  const DENY = [
    `eval '${X}'`,
    `eval true ';' '${X}'`,
    `eval true\\; ${X}`,
    `eval -- '${X}'`,
    `ev''al '${X}'`,
    `\\eval '${X}'`,
    `builtin eval '${X}'`,
    `command eval '${X}'`,
    `noglob eval '${X}'`,
    `{ eval '${X}'; }`,
    `true && eval '${X}'`,
    `eval "eval '${X}'"`,
    `bash -c "eval '${X}'"`,
    // a script built at run time: the word-based reader refuses an eval handed a variable (fail closed)
    'eval "$Y"',
    'eval "$A$B"',
    'builtin eval "$Y"',
    `source <(echo '${X}')`,
    `. <(echo '${X}')`,
    `bash <(echo '${X}')`,
    `/bin/bash <(echo '${X}')`,
    `"bash" <(echo '${X}')`,
    `\\bash <(echo '${X}')`,
    `source /dev/stdin < <(echo '${X}')`,
    `{ source <(echo '${X}'); }`,
    `source <(printf '${X}')`,
    `source <(echo -e '${X}')`,
    // the name split by quotes or a backslash inside a process substitution (the text fallback strips both)
    "source <(echo 'send''mail a@example.com')",
    'bash <(echo send\\mail a@example.com)',
    'send\\\nmail a@example.com',
    '$(\\\nsendmail a@example.com)',
    '# c \\\nsendmail a@example.com',
    `bash -c "bash -c \\"bash -c 'bash -c \\\\\\"${X}\\\\\\"'\\"\"`,
    // the here-string shapes (the gap this change closes)
    `bash <<< '${X}'`,
    `bash<<<'${X}'`,
    `<<< '${X}' bash`,
    `bash 2>&1 <<< '${X}'`,
    `sudo bash <<< '${X}'`,
    `source /dev/stdin <<< '${X}'`,
    `/bin/bash <<< '${X}'`,
    `sh -s <<< '${X}'`,
    `zsh <<< '${X}'`,
    `bash <<< 'send''mail a@example.com'`,
    // a comment before it: the comment ends at its newline, `#` inside a word is not a comment
    `ls # c\nbash <<< '${X}'`,
    `ls # c\nbash<<<'${X}'`,
    `echo a#b; bash <<< '${X}'`,
    'echo $#; bash <<< \'' + X + "'",
    `echo hi # note\nsource /dev/stdin <<< '${X}'`,
    `ls # don't\nbash<<<'${X}'`,
  ]
  const ALLOW = [
    `cat <<< '${X}'`,
    `grep -c x <<< '${X}'`,
    `echo '${X}'`,
    "eval 'echo hi'",
    "bash <<< 'echo hi'",
    'source <(cat f)',
    "source <(echo 'export A=1')",
    'ls -la && pwd',
    'ls 2>&1 | head',
    'cmd &> out',
    'cmd >&2',
    'ls \\\n -la',
    'diff <(ls a) <(ls b)',
    `ls # ${X}`,
    '# note \\\nls',
    'eval "$(ssh-agent -s)"',
    'source ~/.nvm/nvm.sh',
    '. venv/bin/activate',
    "docker run img bash -c 'echo hi'",
  ]

  it('every sending shape is a send on the main agent path', () => {
    const got = mainPathVerdicts(DENY)
    const missed = DENY.filter((_c, i) => !got[i])
    expect(missed).toEqual([])
  })

  it('no harmless look-alike becomes a send (a stuck approved send is the costly false positive)', () => {
    const got = mainPathVerdicts(ALLOW)
    const wrong = ALLOW.filter((_c, i) => got[i])
    expect(wrong).toEqual([])
  })

  it('known limits stay open on purpose: a script built at run time or ANSI-C quoted is not followed', () => {
    const limits = ['bash <<< "$SCRIPT"', "bash <<< $'sendmail a@example.com'"]
    expect(mainPathVerdicts(limits)).toEqual([false, false])
  })

  it('a substitution that names the sender inside the here-string is caught by the mail reader (the copy gate alone is not)', () => {
    const cmd = 'bash <<< "$(echo sendmail a@example.com)"'
    expect(copyGateVerdicts([cmd])[0].result).toBe(false)
    expect(mainPathVerdicts([cmd])).toEqual([true])
  })
})
