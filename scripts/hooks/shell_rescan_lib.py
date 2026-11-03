"""shell_rescan_lib.py -- constructs where text placed in a Bash command is RE-SCANNED by the shell.

WHY: prose pasted into a command (a message body, a commit text) is scanned by the shell before any
program sees it. A backtick inside a double-quoted message body runs whatever stands between the
backticks and puts the OUTPUT into the text. One such body ran a `git reset --hard` in a shared
checkout and destroyed uncommitted work; a written rule against it did not hold, because a rule is
not a control until a tool enforces it.

WHAT IT REPORTS (rule codes of shell_subst.top_bodies(events=...)):
  E_BACKTICK_IN_DQ    a backtick inside a double-quoted string (also inside a `$( )` that sits in one)
  B_UNQUOTED_HEREDOC  a backtick in the body of an UNQUOTED heredoc (<<EOF); a quoted one (<<'EOF') is inert
  D_PROMPT_EXPAND     ${v@P}, prompt-string expansion applied to the value of a variable

WHAT IT DELIBERATELY LEAVES ALONE (each one is a normal, intended use, measured on real commands):
  * single quotes, $'...', a quoted heredoc, a comment, an escaped marker (\\` \\$);
  * `$( )` in a double-quoted string, in an unquoted heredoc and in a payload (`python3 -c "$(...)"`,
    `"$(cat token-file)"`, `git commit -m "$(cat <<'EOF' ... EOF)"` are everyday idioms);
  * an unquoted backtick: deliberate old-style substitution by the author, not prose that drifted in;
  * the word `eval`, and `source` of a runtime text.

HONEST SCOPE: this stops the ACCIDENTAL re-evaluation (data that drifted into the command text). It does
NOT stop a deliberate one: whoever wants to expand a string writes `eval`, `bash -c "$x"` or a $( ) in a
payload, and none of that is read here. The destructive and email gates read what a substitution BODY
runs; this module reads only where a body should not have been. A clean result is a FALSE GREEN for
everything outside the three rules, not proof that the command is safe.

CONTRACT: LINEAR (shell_subst's single pass per level; the ${v@P} pattern is bounded and only tried at a
`${`), and FAIL-CLOSED: past any limit (size, bodies, body text, nesting, time) `Unreadable` is raised and
the gate denies. What it cannot finish reading it does not wave through.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shell_subst  # noqa: E402

# Same limits and the same reasons as destructive-gate.py (256 KiB is far above any real call; the
# 4 s deadline leaves the harness's 10 s hook timeout a wide margin).
MAX_CMD_CHARS = 262144
MAX_BODIES = 256
MAX_BODY_CHARS = 131072
MAX_NEST = 8
INSPECT_SECONDS = 4.0

RULES = ('E_BACKTICK_IN_DQ', 'B_UNQUOTED_HEREDOC', 'D_PROMPT_EXPAND')


class Unreadable(Exception):
    """The command is past a limit of the reader. `reason` is a short Hungarian sentence for the denial."""

    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason


def _snippet(text, pos):
    """A short, printable (ASCII) excerpt around `pos`, for the denial message."""
    s = text[max(0, pos - 20):pos + 30].replace('\n', '\\n').replace('\r', '\\r').replace('\t', ' ')
    return s.encode('ascii', 'replace').decode('ascii')


def findings(cmd):
    """[(rule, excerpt)] in order of first appearance, one entry per rule. Raises Unreadable past a limit.

    An empty list is NOT proof of safety (see the module docstring)."""
    if len(cmd) > MAX_CMD_CHARS:
        raise Unreadable('A parancs tul nagy (%d karakter, a hatar %d): a kapu nem tudja atvizsgalni, '
                         'ezert nem engedi at. Nagy szoveget fajlba ird a Write tool-lal.'
                         % (len(cmd), MAX_CMD_CHARS))
    deadline = time.monotonic() + INSPECT_SECONDS
    found = {}
    budget = {'bodies': 0, 'chars': 0}

    def walk(text, depth):
        events = []
        bodies = shell_subst.top_bodies(text, False, MAX_BODIES + 1, events)
        for rule, pos in events:
            if rule not in found:
                found[rule] = _snippet(text, pos)
        for body in bodies:
            # Every body counts, a blank one too: the reader stops after MAX + 1 bodies, so a gate that
            # skipped blank ones before counting could be filled with them and never see the real one.
            budget['bodies'] += 1
            if budget['bodies'] > MAX_BODIES:
                raise Unreadable('Tul sok parancs-behelyettesites (tobb mint %d): a kapu nem tudja '
                                 'vegigkovetni, ezert nem engedi at.' % MAX_BODIES)
            budget['chars'] += len(body)
            if budget['chars'] > MAX_BODY_CHARS:
                raise Unreadable('A parancs-behelyettesitesek szovege egyutt tul nagy (%d karakter '
                                 'felett): a kapu nem tudja vegigkovetni, ezert nem engedi at.'
                                 % MAX_BODY_CHARS)
            if time.monotonic() > deadline:
                raise Unreadable('A parancs atvizsgalasa tul sokaig tart: a kapu nem tudja befejezni, '
                                 'ezert nem engedi at.')
            if not body.strip():
                continue
            if depth >= MAX_NEST:
                raise Unreadable('Tul melyen agyazott parancs-behelyettesites (%d szint): a kapu nem '
                                 'tudja vegigkovetni, ezert nem engedi at.' % depth)
            walk(body, depth + 1)

    walk(cmd, 0)
    return [(r, found[r]) for r in RULES if r in found]
