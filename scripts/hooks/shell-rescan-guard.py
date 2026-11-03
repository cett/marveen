#!/usr/bin/env python3
"""PreToolUse gate (Bash): refuse a command whose own TEXT the shell would re-scan, because that is how
prose becomes an executed command.

WHY IT EXISTS. Prose pasted into a command -- a message body, a commit text -- is scanned by the shell before
any program sees it. A backtick in a double-quoted body runs whatever is between the backticks and puts the
OUTPUT in the text; one such body ran a `git reset --hard` in a shared checkout and destroyed uncommitted work.
A written rule ("keep data out of double quotes") did not hold. A rule is not a control until a tool enforces it.
The idea and the first detector come from upstream cb332f42 (rewritten here on the shared substitution reader,
shell_subst.py, with a smaller rule set and a different failure policy).

WHAT IT REFUSES (detector: shell_rescan_lib.py):
  E  a backtick inside a double-quoted string
  B  a backtick in the body of an UNQUOTED heredoc (<<EOF)
  D  ${v@P}
The remedy is never "quote harder": keep the data OUT of the command text -- a quoted heredoc (<<'EOF') into a
file the program reads, an argument, or stdin.

WHAT IT DOES NOT DO -- READ THIS BEFORE TRUSTING A GREEN RUN. This gate stops the ACCIDENTAL re-evaluation: data
that drifted into the command text. It does NOT stop a DELIBERATE one. Whoever wants a string expanded writes
`eval`, `bash -c "$x"`, or a $( ) inside an inline payload, and none of that is refused here: those are normal
uses (measured: every refusal such a rule would have made on real commands was intentional, none was an
accident), so refusing them only taught people to route around the gate. Text produced and eval'd or
source'd at RUN TIME is invisible to every gate in this install. The gate reads only what reaches the Bash
tool, so a script already on disk, an MCP server or an agent's own subprocess is uncovered. It raises the floor;
it does not read intent. The sentence "the gate closes the eval path" is false and must not be written anywhere.

FAILURE POLICY (this differs from upstream on purpose). FAIL-CLOSED: any internal error, an unreadable input, a
command past a limit of the reader (256 KiB, 256 substitution bodies, 128 KiB of body text, 8 levels, 4 s) is a
DENY (exit 2), and the settings entry carries `"onFailure": "block"`, so a timeout or a crash of the hook process
itself blocks too. There is NO backstop that lets a repeated command through after N refusals and NO comment
escape hatch: both are a bypass the model can use at will, and a refusal that cannot be talked out of is the
point of a control. A refused command is rewritten, not re-sent.

Output: the reason on stderr (ASCII Hungarian, so no stdout/stderr encoding can break it), exit 2. The verdict is
decided BEFORE anything is written: if stderr is gone, the exit status is still 2.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# stdin bigger than this is refused unread: 256 KiB of command in the worst JSON escaping is ~1.6 MB.
MAX_STDIN_BYTES = 2 * 1024 * 1024

REMEDY = {
    'E_BACKTICK_IN_DQ': ('backtick egy DUPLA idezojeles szovegben: a shell parancsnak veszi, lefuttatja, es a '
                         'KIMENETET teszi a szoveg helyere'),
    'B_UNQUOTED_HEREDOC': ('backtick egy IDEZOJEL NELKULI heredoc torzsben (<<EOF): a shell kifejti a torzset, '
                           'a backtick kozti resz lefut'),
    'D_PROMPT_EXPAND': '${v@P}: a shell a valtozo ERTEKEN prompt-kifejtest vegez',
}


try:
    from gate_audit_lib import DenyExit
except Exception:  # noqa: BLE001
    DenyExit = None


def deny(lines, reason='denied'):
    """Decide first, speak after: whatever happens to stderr, the exit status is 2."""
    try:
        sys.stderr.write('SHELL-UJRASCANNELES-KAPU: BLOKKOLVA.\n' + '\n'.join(lines) + '\n')
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass
    if DenyExit is not None and reason != 'denied':
        raise DenyExit(2, reason)
    sys.exit(2)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    except Exception:  # noqa: BLE001
        deny(['A bemenet nem olvashato, ezert a kapu nem engedi at.'])
    if len(raw) > MAX_STDIN_BYTES:
        deny(['A bemenet tul nagy, a kapu nem tudja atvizsgalni, ezert nem engedi at.'], 'input_too_large')
    try:
        ev = json.loads(raw.decode('utf-8', 'surrogatepass'))
    except Exception:  # noqa: BLE001
        deny(['A bemenet nem ertelmezheto, ezert a kapu nem engedi at.'])
    if not isinstance(ev, dict):
        deny(['A bemenet nem esemeny-objektum, ezert a kapu nem engedi at.'])
    if ev.get('tool_name') != 'Bash':
        sys.exit(0)
    inp = ev.get('tool_input')
    if not isinstance(inp, dict):
        deny(['A Bash hivas bemenete hianyzik vagy ertelmezhetetlen, ezert a kapu nem engedi at.'])
    cmd = inp.get('command')
    if cmd is None:
        sys.exit(0)
    if not isinstance(cmd, str):
        deny(['A Bash parancs nem szoveg, ezert a kapu nem engedi at.'])

    try:
        import shell_rescan_lib
        found = shell_rescan_lib.findings(cmd)
    except Exception as exc:  # noqa: BLE001  (Unreadable included: past a limit is a DENY, not a pass)
        reason = getattr(exc, 'reason', None)
        if reason:
            deny([reason])
        deny(['A kapu maga hibara futott (%s), ezert nem engedi at. Ez a kapu hibaja, nem a tied.'
              % type(exc).__name__])
    if not found:
        sys.exit(0)

    lines = ['A parancs SZOVEGE futna le, nem csak az adat:']
    for rule, excerpt in found:
        lines.append('  - %s: %s' % (rule, REMEDY.get(rule, rule)))
        lines.append('    helye: ...%s...' % excerpt)
    lines += [
        '',
        'Ez az osztaly mar okozott adatvesztest: egy uzenettorzsben maradt backtick `git reset --hard`-ot futtatott '
        'egy kozos checkoutban.',
        'ORVOSLAT: az adat KIKERUL a parancs szovegebol, nem idezojelezed jobban:',
        '  - idezett heredoc fajlba (<<\'VEGE\'), a program a FAJLT olvassa;',
        '  - vagy argumentumkent / stdin-en add at;',
        '  - a szovegben a markdown backtick helyett mas jelolest hasznalj.',
        'A kapu nem kerul meg komment-jelzovel, es nem enged at ismetlesre: ird at a parancsot.',
        '',
        'Amit ez a kapu NEM lat: eval, bash -c "$x", $( ) inline payloadban, futasidoben eloallitott szoveg. '
        'A csendje nem jelenti, hogy a parancs biztonsagos.',
    ]
    deny(lines)


if __name__ == '__main__':
    # OTel H5b: count this run's outcome after the verdict (best effort, never changes it; see
    # gate_audit_lib.py). A missing or broken audit module leaves the gate exactly as it was.
    try:
        from gate_audit_lib import audited
    except Exception:  # noqa: BLE001
        audited = None
    if audited is None:
        main()
    else:
        audited('shell-rescan-guard', main, deny_row=True)
