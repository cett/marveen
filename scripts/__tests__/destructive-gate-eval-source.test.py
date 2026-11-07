#!/usr/bin/env python3
"""eval / source / here-string reading of scripts/hooks/destructive-gate.py (C2 of the d61c7786 brief).

`eval 'rm -rf x'`, `source <(echo 'rm -rf x')`, `. <(printf ...)` and `bash <<< 'rm -rf x'` hand a LITERAL script
to a shell that runs it; the gate saw only `eval` / `source` / `bash` as the command name. The literal script is
now judged like a `bash -c` script (same depth bound).

KNOWN LIMIT, pinned below on purpose (the CHANGELOG [Security] says it too): a script built from a variable
(`eval "$A$B"`, `source "$f"`, `bash <<< "$s"`) is not followed. The gate governs cooperating agents; it does
not claim to be a sandbox. If this limit is ever closed, these pins fail and the CHANGELOG line must go with it.

The banned command is never run: only check_bash's verdict is read (block() patched). Neutral fixtures only.
"""
import importlib.util
import os
import unittest
from unittest.mock import patch

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "destructive-gate.py",
)
_spec = importlib.util.spec_from_file_location("destructive_gate_eval", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

X = "rm -rf /nonexistent-path-a"


class _Denied(Exception):
    pass


def _deny(msg, agent_id=None, tool_name=''):
    raise _Denied(msg)


def verdict(cmd):
    with patch.object(hook, 'block', _deny):
        try:
            hook.check_bash(cmd, 'agent-a')
        except _Denied:
            return 'deny'
    return 'allow'


class TestLiteralScriptsAreRead(unittest.TestCase):
    def test_deny(self):
        shapes = [
            ('eval double quoted', 'eval "%s"' % X),
            ('eval single quoted', "eval '%s'" % X),
            ('eval unquoted words', 'eval %s' % X),
            ('eval with a keyword shape inside', 'eval "if true; then %s; fi"' % X),
            ('source process substitution, echo', "source <(echo '%s')" % X),
            ('dot process substitution, echo', ". <(echo '%s')" % X),
            ('source process substitution, printf', "source <(printf '%s')" % X),
            ('source process substitution, echo -e', "source <(echo -e '%s')" % X),
            ('here-string, spaced', "bash <<< '%s'" % X),
            ('here-string, no space', "bash <<<'%s'" % X),
            ('here-string into sh', "sh <<< '%s'" % X),
            ('eval inside bash -c', 'bash -c "eval \'%s\'"' % X),
            ('eval after a pipe', 'echo a | eval "%s"' % X),
            ('mv through eval', 'eval "mv /nonexistent-path-a /nonexistent-path-b"'),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_allow_text_and_harmless_scripts(self):
        shapes = [
            ('echo of the text', "echo '%s'" % X),
            ('eval of a harmless script', 'eval "echo hello"'),
            ('eval of a harmless unquoted script', 'eval ls -la'),
            ('source of a harmless literal', "source <(echo 'export A=1')"),
            ('source of a file', 'source ./env.sh'),
            ('dot of a file', '. ./env.sh'),
            ('here-string with a harmless script', "bash <<< 'echo hello'"),
            ('here-string into a non-shell', "grep a <<< '%s'" % X),
            ('cat of a here-string', "cat <<< '%s'" % X),
            ('heredoc into cat (data)', "cat <<'EOF'\n%s\nEOF" % X),
            ('eval with no argument', 'eval'),
        ]
        for label, cmd in shapes:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestKnownLimitIsPinned(unittest.TestCase):
    """What the gate does NOT follow. A change here is a decision, not a side effect."""

    def test_variable_built_scripts_are_not_followed(self):
        for cmd in ('A=rm; B=" -rf /nonexistent-path-a"; eval "$A$B"',
                    'f=./script.sh; source "$f"',
                    's="%s"; bash <<< "$s"' % X):
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestDepthBoundHolds(unittest.TestCase):
    def test_deeply_nested_eval_is_denied_not_followed_forever(self):
        cmd = X
        for _ in range(hook._MAX_NEST + 3):
            cmd = "eval '%s'" % cmd.replace("'", "'\\''")
        # Either the banned command is found inside the bound, or the depth limit blocks: never an allow.
        self.assertEqual(verdict(cmd), 'deny')

    def test_literal_echo_script_helper(self):
        self.assertEqual(hook._literal_echo_script("echo 'a b'"), 'a b')
        self.assertEqual(hook._literal_echo_script("printf '%s' x"), '%s x')
        self.assertIsNone(hook._literal_echo_script('ls -la'))
        self.assertIsNone(hook._literal_echo_script('echo'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
