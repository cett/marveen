import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  gateDecision,
  isSendInvocation,
  InspectionLimitError,
  MAX_SUBST_BODIES,
  MAX_SUBST_NEST,
  MAX_SUBST_CHARS,
  // @ts-expect-error -- plain .mjs hook script, no types
} from '../../scripts/email-send-gate.mjs'

// The send classifier read a command substitution as text when it sat inside double quotes (the
// tokenizer keeps quoted text together), so `echo "$(sendmail x)"` was one `echo` and passed while the
// shell sent the mail. The bodies are now read as commands of their own (scripts/shell-subst.mjs).

const ROOT = join(__dirname, '..', '..')
const GATE_JS = join(ROOT, 'scripts', 'email-send-gate.mjs')
const X = 'sendmail probe@example.invalid'

// Each shape is X placed where the shell RUNS it, or where it only reads it as text.
const RUNS: Array<[string, (x: string) => string]> = [
  ['plain', (x) => x],
  ['double-quoted $()', (x) => `echo "$(${x})"`],
  ['double-quoted backtick', (x) => 'echo "`' + x + '`"'],
  ['double-quoted $() with text', (x) => `echo "result: $(${x}) done"`],
  ['bare $()', (x) => `echo $(${x})`],
  ['bare backtick', (x) => 'echo `' + x + '`'],
  ['nested double quotes', (x) => `echo "$(echo "$(${x})")"`],
  ['assignment', (x) => `v="$(${x})"; echo ok`],
  ['unquoted heredoc', (x) => `cat <<EOF\n$(${x})\nEOF\n`],
  ['unquoted heredoc backtick', (x) => 'cat <<EOF\n`' + x + '`\nEOF\n'],
  ['process substitution', (x) => `diff <(${x}) /dev/null`],
  ['arithmetic nesting', (x) => `echo $(( $(${x}) + 1 ))`],
  ['parameter expansion default', (x) => `echo "\${v:-$(${x})}"`],
  ['here-string', (x) => `cat <<<"$(${x})"`],
  ['inside a shell -c script', (x) => `bash -c 'echo "$(${x})"'`],
  ['commit-style heredoc, body is the command', (x) => `git commit -m "$(${x})"`],
]
const TEXT: Array<[string, (x: string) => string]> = [
  ['single quotes', (x) => `echo '$(${x})'`],
  ['single-quoted backtick', (x) => "echo '`" + x + "`'"],
  ['quoted heredoc', (x) => `cat <<'EOF'\n$(${x})\nEOF\n`],
  ['escaped marker in double quotes', (x) => `echo "\\$(${x})"`],
  ['ANSI-C quote', (x) => `echo $'$(${x})'`],
  ['commit message heredoc with the word in prose', () => "git commit -m \"$(cat <<'EOF'\nfix: sendmail was mentioned\nEOF\n)\""],
  ['plain date substitution', () => 'echo "$(date)" `pwd`'],
]

// Shapes this gate has always denied although the shell does not run them: maskSubshellMarkers turns every
// UNQUOTED `$(` into a segment break without reading escapes, comments or the quoting of a heredoc
// delimiter. Over-matching is the safe direction for a send gate, so the change leaves them as they were;
// pinned here so a later narrowing of the mask is a decision, not an accident.
const CONSERVATIVE: Array<[string, (x: string) => string]> = [
  ['double-quoted heredoc delimiter', (x) => `cat <<"EOF"\n$(${x})\nEOF\n`],
  ['escaped marker', (x) => `echo \\$(${x})`],
  ['comment', (x) => `echo hi # $(${x})`],
]

describe('isSendInvocation reads command-substitution bodies', () => {
  for (const [name, shape] of CONSERVATIVE) {
    it(`still denies (conservative, unchanged): ${name}`, () => {
      expect(isSendInvocation(shape(X)), JSON.stringify(shape(X))).toBe(true)
    })
  }
  for (const [name, shape] of RUNS) {
    it(`denies: ${name}`, () => {
      expect(isSendInvocation(shape(X)), JSON.stringify(shape(X))).toBe(true)
    })
  }
  for (const [name, shape] of TEXT) {
    it(`allows (text, not run): ${name}`, () => {
      expect(isSendInvocation(shape(X)), JSON.stringify(shape(X))).toBe(false)
    })
  }

  it('a python smtplib one-liner is a send inside a double-quoted substitution too', () => {
    const code = 'python3 -c "import smtplib; smtplib.SMTP(1)"'
    expect(isSendInvocation(code)).toBe(true)
    expect(isSendInvocation(`echo "$(${code})"`)).toBe(true)
    expect(isSendInvocation('echo "$(' + code.replace(/"/g, "'") + ')"')).toBe(true)
  })

  it('the old behaviour is reproduced by a version that ignores bodies (the probes were real)', () => {
    // The pre-change verdict for the double-quoted shapes was `false`; this pins that the new `true`
    // comes from the body read, not from a broader text match: the same words as plain prose pass.
    expect(isSendInvocation('echo "sendmail probe@example.invalid"')).toBe(false)
    expect(isSendInvocation('echo "$(echo sendmail probe@example.invalid)"')).toBe(false)
  })
})

describe('the inspection limits fail closed (a deny, never a pass)', () => {
  it('too many substitutions', () => {
    const cmd = 'echo "$(a)" '.repeat(MAX_SUBST_BODIES + 1)
    expect(() => isSendInvocation(cmd)).toThrow(InspectionLimitError)
    expect(gateDecision('Bash', { command: cmd })).toMatchObject({ deny: true })
    expect(gateDecision('Bash', { command: cmd }).tooLarge).toBeTruthy()
  })
  it('exactly at the body limit is still read', () => {
    expect(isSendInvocation('echo "$(a)" '.repeat(MAX_SUBST_BODIES))).toBe(false)
  })
  it('nested deeper than the nesting limit', () => {
    const open = 'echo "$('.repeat(MAX_SUBST_NEST + 1)
    const cmd = open + 'x' + ')"'.repeat(MAX_SUBST_NEST + 1)
    expect(() => isSendInvocation(cmd)).toThrow(InspectionLimitError)
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })
  it('exactly at the nesting limit is still read', () => {
    const open = 'echo "$('.repeat(MAX_SUBST_NEST)
    const cmd = open + 'x' + ')"'.repeat(MAX_SUBST_NEST)
    expect(isSendInvocation(cmd)).toBe(false)
  })
  it('the bodies together over the character budget', () => {
    const body = 'a'.repeat(30000)
    const cmd = (`echo "$(${body})" `).repeat(Math.ceil(MAX_SUBST_CHARS / 30000) + 1)
    expect(() => isSendInvocation(cmd)).toThrow(InspectionLimitError)
  })
  it('the budget is per call, not carried over to the next command', () => {
    for (let i = 0; i < 3; i++) expect(isSendInvocation('echo "$(a)" '.repeat(MAX_SUBST_BODIES))).toBe(false)
  })
})

describe('the hook entrypoint', () => {
  const run = (command: string) =>
    execFileSync('node', [GATE_JS], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf-8',
      timeout: 20000,
    })
  it('denies a double-quoted substitution send', () => {
    expect(run(`echo "$(${X})"`)).toContain('"permissionDecision":"deny"')
  })
  it('allows the same words as text', () => {
    expect(run(`echo '$(${X})'`)).toBe('')
  })
  it('denies too many substitutions with the too-large message, in time', () => {
    const t0 = Date.now()
    const out = run('echo "$(a)" '.repeat(MAX_SUBST_BODIES + 50))
    expect(out).toContain('"permissionDecision":"deny"')
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})
