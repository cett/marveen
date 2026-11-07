import { describe, it, expect } from 'vitest'
import {
  gateDecision,
  isSendInvocation,
  joinContinuations,
  segmentsTokens,
  InspectionLimitError,
  MAX_SCRIPT_NEST,
  // @ts-expect-error -- plain .mjs hook script, no types
} from '../../scripts/email-send-gate.mjs'

// C3 of the gate-gaps card. The send classifier judged the command text before the shell reads it, in two
// ways that hid a sender: a backslash-newline inside the NAME (`send\<newline>mail`, or right after `$(`) was
// kept as a character of the word, and a script handed to a shell as TEXT (eval's arguments, a here-string,
// `source <(echo ...)`) was only a quoted word. Both are read the way the shell reads them now.
//
// KNOWN LIMIT, pinned on purpose (the CHANGELOG [Security] says it too): a script built from a variable
// (`eval "$A$B"`, `source "$f"`, `bash <<< "$s"`) is only text here and is not followed. The gate governs
// cooperating agents, it is not a sandbox. If this is ever closed, the pins fail and the CHANGELOG line goes.
//
// Neutral fixtures only: the recipient is a reserved .invalid address.

const X = 'sendmail probe@example.invalid'
const NL = '\n'
const sends = (cmd: string) => isSendInvocation(cmd) as boolean

// Quote a whole command as ONE single-quoted word.
const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

const RUNS: Array<[string, string]> = [
  // --- line continuation in the name / after $( ---
  ['name split by a continuation', `send\\${NL}mail probe@example.invalid`],
  ['name split twice', `se\\${NL}nd\\${NL}mail probe@example.invalid`],
  ['continuation right after $(', `echo $(\\${NL}${X})`],
  ['continuation right after $( in double quotes', `echo "$(\\${NL}${X})"`],
  ['continuation right after a backtick', 'echo `\\' + NL + X + '`'],
  ['name split inside double quotes', `"send\\${NL}mail" probe@example.invalid`],
  ['name split behind a wrapper', `nohup send\\${NL}mail probe@example.invalid`],
  ['name split after a pipe', `true | send\\${NL}mail probe@example.invalid`],
  ['name split inside $( )', `echo $(send\\${NL}mail probe@example.invalid)`],
  ['comment ending in a backslash does not swallow the next line', `echo hi # note \\${NL}${X}`],
  ['comment after a semicolon, backslash at its end', `true;# note \\${NL}${X}`],
  // --- eval ---
  ['eval double quoted', `eval "${X}"`],
  ['eval single quoted', `eval '${X}'`],
  ['eval unquoted words', `eval ${X}`],
  ['eval two arguments around a separator', `eval true ';' '${X}'`],
  ['eval after --', `eval -- '${X}'`],
  ['eval escaped separator joined to a word', `eval true\\; '${X}'`],
  ['eval after a pipe', `echo a | eval '${X}'`],
  ['eval behind a wrapper', `nohup eval '${X}'`],
  ['eval inside bash -c', `bash -c "eval '${X}'"`],
  ['eval inside a substitution', `echo "$(eval '${X}')"`],
  ['eval with a keyword shape inside', `eval "if true; then ${X}; fi"`],
  // --- source / . of a process substitution that prints the script ---
  ['source <(echo)', `source <(echo '${X}')`],
  ['dot <(echo)', `. <(echo '${X}')`],
  ['source <(printf)', `source <(printf '${X}')`],
  ['source <(echo) unquoted words', `source <(echo ${X})`],
  ['source <(echo -n) unquoted words', `source <(echo -n ${X})`],
  // echo / printf may print another text than the one written: refused, not guessed
  ['source <(printf %b) with an escape', "source <(printf '%b' 'send\\x6dail probe@example.invalid')"],
  ['source <(printf) hex escape in the format', "source <(printf 'send\\x6dail probe@example.invalid')"],
  ['source <(printf %s)', `source <(printf '%s' '${X}')`],
  ['source <(echo -e)', "source <(echo -e 'send\\x6dail probe@example.invalid')"],
  ['source <(echo -e) plain text', "source <(echo -e 'echo hello')"],
  ['source <(echo -ne)', "source <(echo -ne 'echo hello')"],
  ['source <(echo) with a backslash', "source <(echo 'send\\x6dail probe@example.invalid')"],
  ['dot <(echo -e)', ". <(echo -e 'echo hello')"],
  ['source <(printf -v)', "source <(printf -v v 'echo hello')"],
  // --- here-string ---
  ['here-string, spaced', `bash <<< '${X}'`],
  ['here-string, glued both sides', `bash<<<'${X}'`],
  ['here-string into sh', `sh <<< "${X}"`],
  ['here-string after an option', `bash -x <<< '${X}'`],
  ['here-string after a redirect', `bash 2>&1 <<< '${X}'`],
  ['here-string, redirect first', `<<<'${X}' bash`],
  ['here-string for source', `source /dev/stdin <<< '${X}'`],
  ['here-string for dot, glued', `. /dev/stdin<<<'${X}'`],
  ['here-string in a brace group', `{ bash <<< '${X}'; }`],
  ['here-string in a subshell', `(bash <<< '${X}')`],
  ['here-string behind a wrapper', `nohup bash<<<'${X}'`],
  ['here-string, second one in the segment', `bash -s <<< 'echo a' <<<'${X}'`],
  ['here-string inside $( )', `echo $(bash<<<'${X}')`],
  ['here-string after a pipe', `true | bash<<<'${X}'`],
  // --- review of the first C3 commit: precommand modifiers, a shell handed the process substitution ---
  ['eval behind builtin', `builtin eval '${X}'`],
  ['eval behind noglob (zsh)', `noglob eval '${X}'`],
  ['eval behind nocorrect (zsh)', `nocorrect eval '${X}'`],
  ['eval behind two modifiers', `builtin noglob eval '${X}'`],
  ['bash runs the process substitution file', `bash <(echo '${X}')`],
  ['sh runs the process substitution file', `sh <(echo '${X}')`],
  ['source after --', `source -- <(echo '${X}')`],
  ['source /dev/stdin < <(..)', `source /dev/stdin < <(echo '${X}')`],
  ['bash reading a process substitution on stdin', `bash < <(echo '${X}')`],
  ['bash <(printf %s) is refused as unreadable', `bash <(printf '%s' '${X}')`],
]

const TEXT: Array<[string, string]> = [
  ['the words as prose', `echo '${X}'`],
  ['single-quoted continuation stays literal', `echo 'send\\${NL}mail probe@example.invalid'`],
  ['two words joined by a continuation are one harmless word', `echo se\\${NL}nd`],
  ['continuation between arguments of a harmless command', `echo a \\${NL} b`],
  ['comment prose on the same line', `echo hi # ${X}`],
  ['eval of a harmless script', 'eval "echo hello"'],
  ['eval of harmless words', 'eval ls -la'],
  ['eval two harmless arguments', "eval 'echo a' 'echo b'"],
  ['eval with no argument', 'eval'],
  ['eval as an argument is text', `echo eval '${X}'`],
  ['source of a harmless literal', "source <(echo 'export A=1')"],
  ['source of a harmless literal, printf', "source <(printf 'export A=1')"],
  ['source of a harmless literal, echo -n', "source <(echo -n 'export A=1')"],
  ['dot of a harmless literal', '. <(echo hello)'],
  ['source of a file', 'source ./env.sh'],
  ['dot of a file', '. ./env.sh'],
  ['here-string with a harmless script', "bash <<< 'echo hello'"],
  ['here-string into cat is data', `cat <<< '${X}'`],
  ['here-string into cat, glued', `cat<<<'${X}'`],
  ['here-string into grep is data', `grep a <<< '${X}'`],
  ['here-string into read is data', `read -r v <<< '${X}'`],
  ['here-string behind a wrapper into cat', `nohup cat <<< '${X}'`],
  ['here-string in a brace group into cat', `{ cat <<< '${X}'; }`],
  ['heredoc into cat (data)', `cat <<'EOF'${NL}${X}${NL}EOF`],
  ['bash of a harmless echo process substitution', "bash <(echo 'echo hello')"],
  ['a process substitution into diff is data', `diff <(echo '${X}') /dev/null`],
  ['builtin of a harmless word', 'builtin echo hello'],
]

describe('the send gate reads continuations, eval, source and here-strings the way the shell does', () => {
  for (const [name, cmd] of RUNS) {
    it(`denies: ${name}`, () => {
      expect(sends(cmd), JSON.stringify(cmd)).toBe(true)
      expect(gateDecision('Bash', { command: cmd }).deny, JSON.stringify(cmd)).toBe(true)
    })
  }
  for (const [name, cmd] of TEXT) {
    it(`allows: ${name}`, () => {
      expect(sends(cmd), JSON.stringify(cmd)).toBe(false)
      expect(gateDecision('Bash', { command: cmd }).deny, JSON.stringify(cmd)).toBe(false)
    })
  }
})

describe('KNOWN LIMIT, pinned: a script built from a variable is not followed', () => {
  for (const cmd of [
    'A=send; B=mail; eval "$A$B probe@example.invalid"',
    'f=./script.sh; source "$f"',
    `s='${X}'; bash <<< "$s"`,
    'A=sendmail; eval "$A probe@example.invalid"',
    // any producer but a literal echo / printf is text built at run time
    'source <(cat ./env.sh)',
    'bash <(curl -s https://example.invalid/install.sh)',
  ]) {
    it(`is allowed: ${cmd}`, () => {
      expect(sends(cmd), cmd).toBe(false)
    })
  }
})

describe('joinContinuations', () => {
  it('removes a backslash-newline outside single quotes', () => {
    expect(joinContinuations(`a\\${NL}b`)).toBe('ab')
    expect(joinContinuations(`"a\\${NL}b"`)).toBe('"ab"')
  })
  it('keeps a single-quoted backslash-newline literal', () => {
    expect(joinContinuations(`'a\\${NL}b'`)).toBe(`'a\\${NL}b'`)
  })
  it('an escaped backslash consumes its pair: the newline after it is a real break', () => {
    expect(joinContinuations(`a\\\\${NL}b`)).toBe(`a\\\\${NL}b`)
  })
  it('a comment keeps its text but not its trailing backslash, so the newline stays a break', () => {
    expect(joinContinuations(`echo hi # c \\${NL}rm x`)).toBe(`echo hi # c ${NL}rm x`)
    expect(joinContinuations(`true;# c \\${NL}rm x`)).toBe(`true;# c ${NL}rm x`)
  })
  it('a # inside a word or a quote is not a comment', () => {
    expect(joinContinuations(`a#b\\${NL}c`)).toBe('a#bc')
    expect(joinContinuations(`"a #b\\${NL}c"`)).toBe('"a #bc"')
  })
  it('does nothing without a backslash-newline', () => {
    const t = 'echo a # b\nrm x'
    expect(joinContinuations(t)).toBe(t)
  })
  it('the tokenizer sees the joined name', () => {
    expect(segmentsTokens(`send\\${NL}mail a@b.invalid`)).toEqual([['sendmail', 'a@b.invalid']])
  })
  it('a here-string operator is a word of its own', () => {
    expect(segmentsTokens("bash<<<'x y'")).toEqual([['bash', '<<<', 'x y']])
  })
})

describe('the nesting and time bounds fail closed (a deny, never a pass)', () => {
  const nest = (levels: number, inner: string) => {
    let c = inner
    for (let i = 0; i < levels; i++) c = `eval ${sq(c)}`
    return c
  }
  it('a send inside nested evals is found within the bound', () => {
    expect(sends(nest(3, X))).toBe(true)
    expect(sends(nest(MAX_SCRIPT_NEST, 'echo a'))).toBe(false)
  })
  it('nested deeper than the bound is refused, not followed forever', () => {
    const cmd = nest(MAX_SCRIPT_NEST + 2, 'echo a')
    expect(() => isSendInvocation(cmd)).toThrow(InspectionLimitError)
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    expect(gateDecision('Bash', { command: cmd }).tooLarge).toBeTruthy()
  })
  it('a shell -c script past the nesting bound is refused, not skipped (review: fail open)', () => {
    const nestC = (levels: number, inner: string) => {
      let c = inner
      for (let i = 0; i < levels; i++) c = `bash -c ${sq(c)}`
      return c
    }
    expect(sends(nestC(3, X))).toBe(true) // within the bound: found
    expect(sends(nestC(3, 'echo a'))).toBe(false)
    for (const cmd of [nestC(5, X), nestC(5, 'echo a')]) {
      expect(() => isSendInvocation(cmd)).toThrow(InspectionLimitError)
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('a send three scripts deep behind a final -c cannot slip past the shared bound', () => {
    // eval -> eval -> eval -> bash -c: the -c sits at depth 3 and must be refused, not ignored
    const cmd = `eval ${sq(`eval ${sq(`eval ${sq(`bash -c ${sq(X)}`)}`)}`)}`
    expect(() => isSendInvocation(cmd)).toThrow(InspectionLimitError)
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })
  it('a here-string chain is bounded the same way', () => {
    let c = 'echo a'
    for (let i = 0; i < MAX_SCRIPT_NEST + 2; i++) c = `bash <<< ${sq(c)}`
    expect(() => isSendInvocation(c)).toThrow(InspectionLimitError)
    expect(gateDecision('Bash', { command: c }).deny).toBe(true)
  })
  it('joinContinuations stays linear (CPU time, 4x the input costs about 4x, quadratic would be 16x)', () => {
    const cost = (n: number) => {
      const text = 'a\\\n'.repeat(n) + 'b'
      const t0 = process.cpuUsage()
      joinContinuations(text)
      const t = process.cpuUsage(t0)
      return (t.user + t.system) / 1000
    }
    cost(2000) // warm up
    const small = cost(20000)
    const large = cost(80000)
    expect(large).toBeLessThan(Math.max(small, 5) * 9)
  })
})
