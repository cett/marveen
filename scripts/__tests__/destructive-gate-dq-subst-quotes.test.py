#!/usr/bin/env python3
"""A command substitution inside a double quote reads its quotes afresh (scripts/hooks/destructive-gate.py).

`echo "$(grep -n "\\$(rm x)" f)"`: the nested pair of double quotes belongs to the grep, it does not close the outer
string. The quote map used to pair them flat, so the nested pattern ended up OUTSIDE every quote: a `;`, `|` or
`(rm x)` in the pattern cut the command into segments and `rm` read as a command name (a false block on a
read-only grep whose pattern holds an escaped substitution). The whole `$( )` / backtick region inside a double
quote is now one quoted piece for the outer reading, and its body is judged as a command of its own
(shell_subst.top_bodies), exactly as before.

Three groups, neutral fixtures only (the banned command is `rm -rf <nonexistent path>`, never run: block() is patched):
  * ALLOW   the cells that were falsely blocked, and their variants (nested single quotes, backticks, two substitutions,
            a pattern with ; | && inside the nested quotes)
  * DENY    the twins that must stay blocked: the shell RUNS the banned command (in the body, behind a nested quote,
            in an operand substitution, after the region, in an unterminated substitution, behind a comment or an
            ANSI-C string inside the body)
  * FUZZ    a seeded differential: a well-formed body built from balanced fragments, followed by `; rm ...`, must be
            blocked (the region ends exactly where the shell's substitution ends, it never hides what follows),
            and the same command without the banned tail must be allowed
plus a linear-time bound on a long run of such regions.
"""
import importlib.util
import os
import random
import time
import unittest
from unittest.mock import patch

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "destructive-gate.py",
)
_spec = importlib.util.spec_from_file_location("destructive_gate_dq_subst", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

X = "rm -rf /nonexistent-path-a"
BS = "\\"


class _Denied(Exception):
    pass


def _deny(msg, agent_id=None, tool_name=''):
    raise _Denied(msg)


def verdict(cmd):
    """'deny' or 'allow' -- what the gate says about `cmd`. Nothing is executed."""
    with patch.object(hook, 'block', _deny):
        try:
            hook.check_bash(cmd, 'agent-a')
        except _Denied:
            return 'deny'
    return 'allow'


# the text the shell passes to grep is `$(rm x)` / `\$(rm x)` etc: data, never a command
ALLOW = [
    ("escaped substitution in a nested pattern", 'echo "$(grep -n "' + BS + '$(rm x)" /tmp/f)"'),
    ("double-escaped substitution", 'echo "$(grep -n "' + BS * 3 + '$(rm x)" /tmp/f)"'),
    ("nested pattern after a pipe", 'echo "$(cat /tmp/f | grep "' + BS * 3 + '$(rm")"'),
    ("two substitutions, the second with the pattern", 'echo "$(grep -n a /tmp/f) $(grep -n "' + BS * 3 + '$(rm x)" /tmp/f)"'),
    ("an echo inside is data as well", 'echo "$(echo "' + BS * 3 + '$(rm x)")"'),
    ("a grep inside a command substitution that is a quoted argument", 'echo "$(grep -n "' + BS + '$(rm x)" /tmp/f)" | head'),
    ("pattern with a semicolon", 'echo "$(grep -n "a; rm x" /tmp/f)"'),
    ("pattern with a pipe", 'echo "$(grep -nE "a|rm x" /tmp/f)"'),
    ("pattern with &&", 'echo "$(grep -n "a && rm x" /tmp/f)"'),
    ("pattern with a subshell", 'echo "$(grep -n "(rm x)" /tmp/f)"'),
    ("nested single quotes", 'echo "$(grep -n ' + "'" + BS + BS + '$(rm x)' + "'" + ' /tmp/f)"'),
    ("backticks in a double quote (the backquote body unescapes: three backslashes become one)", 'echo "`grep -n "' + BS * 3 + '$(rm x)" /tmp/f`"'),
    ("nested substitution, nested quotes", 'echo "$(echo "$(grep "a; rm x" /tmp/f)")"'),
    ("assigned", 'x="$(grep -n "' + BS + '$(rm x)" /tmp/f)"'),
    ("no quotes inside (the old behaviour)", 'echo "$(grep -n abc /tmp/f)"'),
    ("unquoted substitution (the old behaviour)", 'echo $(grep -n "' + BS * 3 + '$(rm x)" /tmp/f)'),
]

DENY = [
    ("the shell runs a real rm in the body, after the nested pair", 'echo "$(grep -n "x" /tmp/f; ' + X + ')"'),
    ("a real substitution in the operand", 'echo "$(grep "a" "$(' + X + ')")"'),
    ("a real substitution in the pattern", 'echo "$(grep "$(' + X + ')" /tmp/f)"'),
    ("four backslashes, then a real substitution", 'echo "$(grep -n "' + BS * 4 + '$(' + X + ')" /tmp/f)"'),
    ("after the region, ;", 'echo "$(grep "a" /tmp/f)" ; ' + X),
    ("after the region, &&", 'echo "$(grep "a" /tmp/f)" && ' + X),
    ("after the region, a newline", 'echo "$(grep "a" /tmp/f)"\n' + X),
    ("a paren inside a nested string does not end the body", 'echo "$(echo ")" ; ' + X + ')"'),
    ("a quote inside a single-quoted string does not end the body", 'echo "$(echo \'")\' ; ' + X + ')"'),
    ("a comment inside the body hides a paren, the next line runs", 'echo "$(echo a # )\n' + X + ')"'),
    ("backticks: one backslash is unescaped by the backquote, the substitution then runs", 'echo "`grep -n "' + BS + '$(' + X + ')" /tmp/f`"'),
    ("an unterminated substitution takes the rest", 'echo "$(grep "a" /tmp/f\n' + X),
    ("backticks: the rm runs in the backquote body", 'echo "`grep "a" /tmp/f; ' + X + '`"'),
    ("backticks: an escaped backtick does not end it", 'echo "`echo ' + BS + '` ; ' + X + '`"'),
    ("nested substitution in a nested substitution", 'echo "$(echo "$(' + X + ')")"'),
    ("the banned command as the plain first word", X),
]

# balanced fragments a substitution body can hold; each one is a complete command on its own
FRAGMENTS = [
    'grep -n "p q" /tmp/f', "echo ')'", 'echo ")"', 'echo "a' + BS + '"b"', 'echo `echo "k"`', 'echo $(echo "n")',
    '(echo a)', 'cat /tmp/f | grep "a|b"', "echo 'x\"y'", 'grep -E "(a|b);c" /tmp/f', 'echo "$(echo "z")"', 'echo a # c)\n', 'true',
]


class TestFalselyBlockedCellsAreAllowed(unittest.TestCase):
    def test_allow_cells(self):
        for name, cmd in ALLOW:
            with self.subTest(name):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestTwinsStayBlocked(unittest.TestCase):
    def test_deny_cells(self):
        for name, cmd in DENY:
            with self.subTest(name):
                self.assertEqual(verdict(cmd), 'deny', cmd)


class TestRegionEndsWhereTheShellEnds(unittest.TestCase):
    def test_fuzz(self):
        rnd = random.Random(20261111)
        for n in range(300):
            body = rnd.choice([';', ' && ', '\n', ' | cat; ']).join(rnd.choice(FRAGMENTS) for _ in range(rnd.randint(1, 4)))
            if body.rstrip().endswith('# c)'):
                body += '\n'
            plain = 'echo "$(%s)"' % body
            with self.subTest(n=n, body=body):
                self.assertEqual(verdict(plain), 'allow', plain)
                self.assertEqual(verdict(plain + ' ; ' + X), 'deny', plain)
                self.assertEqual(verdict('echo "`%s`"' % body.replace('`', BS + '`')) in ('allow', 'deny'), True)


class TestQuoteMapRegion(unittest.TestCase):
    def test_region_is_one_quoted_piece(self):
        text = 'echo "$(grep "a b" f)" ; rm x'
        state = hook._quote_map(text)
        start = text.index('$(')
        end = text.index(')') + 1
        self.assertTrue(all(state[k] == 2 for k in range(start, end)))
        self.assertEqual(state[text.index(';')], 0)

    def test_unbalanced_never_raises(self):
        for text in ['echo "$(', 'echo "$(grep "a', 'echo "`', 'echo "$(echo \'', 'echo "$(echo $\'x', 'echo "$((1 + 2)"', '"$(' * 50]:
            hook._quote_map.cache_clear()
            self.assertEqual(len(hook._quote_map(text)), len(text))


class TestLinear(unittest.TestCase):
    def test_many_regions(self):
        one = 'echo "$(grep "a b" /tmp/f)" ; '
        cmd = one * 2000
        t0 = time.process_time()
        verdict(cmd[:-3])
        self.assertLess(time.process_time() - t0, 5.0)

    def test_deep_nesting(self):
        cmd = 'echo "' + '$(echo "' * 40 + 'x' + '")' * 40 + '"'
        t0 = time.process_time()
        verdict(cmd)
        self.assertLess(time.process_time() - t0, 5.0)


if __name__ == "__main__":
    unittest.main()
