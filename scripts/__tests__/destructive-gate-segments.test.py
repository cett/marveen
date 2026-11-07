#!/usr/bin/env python3
"""Segment-reading gaps of scripts/hooks/destructive-gate.py (C1 of the d61c7786 brief).

The gate takes the FIRST WORD of a segment as the command name. These shapes slid the banned command to a
later position or hid its name, and the live gate allowed them (measured on the real hook): shell keywords
(`then rm`, `do rm`, `else rm`, `elif`, `!`, a case pattern), `{ rm; }`, a function body, a single `&`, a
backslash in front of the name (`\\rm`), and a line continuation inside the name (`r\\<newline>m`).

For every shape the banned command X is `rm -rf <nonexistent path>`; the command is NEVER run, only the
verdict of `check_bash` is read (block() is patched to raise). Neutral fixtures only.

Three groups:
  * DENY    every shape of the table, for `rm` and `mv`
  * ALLOW   text that merely MENTIONS the keywords / `&` / `\\rm` (the false-positive guard: the keyword
            skip must not turn prose, arguments or fd redirections into commands)
  * ORDER   the continuation join comes after the heredoc and comment blanking (a comment or heredoc line
            ending in a backslash must not swallow the line after it)
plus a CPU-time bound on hostile 250 KB inputs (the 10 s hook timeout needs a wide margin).
"""
import importlib.util
import os
import time
import unittest
from unittest.mock import patch

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "destructive-gate.py",
)
_spec = importlib.util.spec_from_file_location("destructive_gate_segments", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

X = "rm -rf /nonexistent-path-a"


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


DENY_SHAPES = [
    ("brace group, one line", "{ %s; }"),
    ("brace group, multi line", "{\n%s\n}"),
    ("if/then", "if true; then %s; fi"),
    ("if/else", "if false; then true; else %s; fi"),
    ("elif", "if false; then true; elif true; then %s; fi"),
    ("for/do", "for i in 1 2; do %s; done"),
    ("while/do", "while false; do %s; done"),
    ("until/do", "until true; do %s; done"),
    ("negation", "! %s"),
    ("case pattern", "case x in x) %s ;; esac"),
    ("case pattern with alternatives", "case x in a|b) %s ;; esac"),
    ("background ampersand", "true & %s"),
    ("function, posix form", "f() { %s; }; f"),
    ("function, keyword form", "function f { %s; }; f"),
    ("function, no spaces", "f(){ %s; }; f"),
    ("function, space before parens", "f () { %s; }; f"),
    ("subshell", "(%s)"),
    ("subshell without arguments", "(rm)"),
    ("backslash before the name", "\\%s"),
    ("backslash inside the name", "r\\m -rf /nonexistent-path-a"),
    ("continuation inside the name", "r\\\nm -rf /nonexistent-path-a"),
    ("continuation between the arguments", "rm \\\n -rf /nonexistent-path-a"),
    ("inside bash -c", 'bash -c "if true; then %s; fi"'),
    ("inside a command substitution", 'echo "$(if true; then %s; fi)"'),
    ("after another command with a pipe", "echo a | { %s; }"),
]


class TestDenyShapes(unittest.TestCase):
    def test_every_shape_is_denied_for_rm(self):
        for label, tmpl in DENY_SHAPES:
            with self.subTest(shape=label):
                cmd = tmpl % X if '%s' in tmpl else tmpl
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_every_shape_is_denied_for_mv_too(self):
        # BANNED_CMDS is one set: the same reading applies to all of it.
        for label, tmpl in DENY_SHAPES:
            if '%s' not in tmpl:
                continue
            with self.subTest(shape=label):
                cmd = tmpl % "mv /nonexistent-path-a /nonexistent-path-b"
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_control_plain_command_still_denied(self):
        self.assertEqual(verdict(X), 'deny')


ALLOW_SHAPES = [
    # Prose that mentions the keywords: the first word of the segment is another command.
    ('commit message with if/then/rm', 'git commit -m "fix: if x; then rm y"'),
    ('commit message in a heredoc', "git commit -F - <<EOF\nfix: then rm y\ndo rm z\n{ rm }\nEOF"),
    ('echo of a keyword line', 'echo "then rm -rf x"'),
    ('grep for a keyword line', "grep -n 'do rm' notes.txt"),
    ('echo of the command in single quotes', "echo 'rm -rf x'"),
    ('rm only as an argument: man', 'man rm'),
    ('rm only as an argument: which', 'which rm'),
    ('rm only as an argument: type', 'type rm'),
    ('quoted backslash name as data', "printf '%s' '\\rm'"),
    # The single `&` rule must not cut apart what is not a background marker.
    ('stderr into a pipe', 'cmd 2>&1 | grep rm'),
    ('redirect both streams', 'cmd &> out.txt'),
    ('redirect both streams, append', 'cmd &>> out.txt'),
    ('fd duplication', 'echo ok >&2'),
    ('input fd duplication', 'cat <&3'),
    ('and-list', 'a && b'),
    ('pipe both', 'cmd |& grep x'),
    ('ampersand in a quoted url', 'curl "http://example.invalid/?a=1&b=2"'),
    ('trailing background marker', 'sleep 1 &'),
    ('harmless compound command', 'if true; then echo ok; fi'),
    ('harmless loop', 'for i in 1 2; do echo $i; done'),
    ('harmless case', 'case x in x) echo ok ;; esac'),
    ('harmless function', 'f() { echo ok; }; f'),
    ('harmless continuation', 'echo a \\\n b'),
    ('harmless control', 'ls -la'),
]


class TestAllowShapes(unittest.TestCase):
    def test_text_and_redirections_are_not_commands(self):
        for label, cmd in ALLOW_SHAPES:
            with self.subTest(shape=label):
                self.assertEqual(verdict(cmd), 'allow', cmd)

    def test_ninety_legit_commands_have_no_new_deny(self):
        # A differential corpus: ordinary commands an agent writes all day. Not one may turn into a deny.
        corpus = [
            'ls', 'ls -la /tmp', 'cat README.md', 'git status', 'git log --oneline -5', 'git diff HEAD~1',
            'git add -A', 'git commit -m "msg"', 'git checkout -b feature/x', 'npm test', 'npm run build',
            'npx vitest run src/a.test.ts', 'node script.mjs', 'python3 -I script.py', 'grep -rn foo src',
            'grep -c "a|b" f', 'sed -n 1,10p f', 'awk "{print $1}" f', 'head -5 f', 'tail -f log',
            'wc -l f', 'sort f | uniq -c', 'echo a && echo b', 'echo a || echo b', 'echo a; echo b',
            'cd src && ls', 'mkdir -p /tmp/x', 'cp a b', 'touch f', 'chmod 644 f', 'find . -name "*.ts"',
            'find . -name x -print', 'xargs echo < list', 'sleep 1', 'date', 'uname -a', 'pwd', 'whoami',
            'env | sort', 'which node', 'node --version', 'curl -s http://example.invalid/', 'jq . f.json',
            'diff a b', 'diff <(echo a) <(echo b)', 'tar tf a.tar', 'unzip -l a.zip', 'ps aux | grep node',
            'tmux list-sessions', 'tmux display-message -p "#S"', 'test -f f && echo yes', '[ -d d ]',
            'if [ -f f ]; then cat f; fi', 'for f in a b; do cat $f; done', 'while read l; do echo $l; done < f',
            'x=1; echo $x', 'export A=1', 'cmd > out 2>&1', 'cmd 2>/dev/null', 'cmd >/dev/null 2>&1 &',
            'tee out < in', 'basename /a/b', 'dirname /a/b', 'realpath .', 'stat f', 'du -sh .', 'df -h',
            'printf "%s\\n" a', 'echo "a  b"', "echo 'a  b'", 'echo $(date)', 'echo `date`',
            'bash -c "echo hi"', 'sh -c "ls"', 'timeout 5 ls', 'nice -n 5 ls', 'time ls', 'exec ls',
            'true', 'false', ':', 'exit 0', 'return 0', 'trap "" INT', 'wait', 'jobs', 'kill -0 1',
            'git push origin main' if False else 'git fetch origin', 'git stash list', 'git worktree list',
        ]
        self.assertGreaterEqual(len(corpus), 90)
        for cmd in corpus:
            with self.subTest(cmd=cmd):
                self.assertEqual(verdict(cmd), 'allow', cmd)


class TestJoinOrder(unittest.TestCase):
    """The continuation join runs LAST in scannable(): after heredoc and comment blanking."""

    def test_comment_ending_in_backslash_does_not_swallow_the_next_line(self):
        # In the shell a comment ends at the newline, a backslash there does not continue it: X runs.
        self.assertEqual(verdict('echo hi # note \\\n%s' % X), 'deny')

    def test_data_heredoc_line_ending_in_backslash_does_not_hide_a_later_command(self):
        # Quoted delimiter: the body is literal, `EOF` on its own line ends it, X after it runs.
        cmd = "cat <<'EOF'\nline \\\nEOF\n%s" % X
        self.assertEqual(verdict(cmd), 'deny')

    def test_data_heredoc_body_is_still_data(self):
        self.assertEqual(verdict("cat <<'EOF'\n%s\nEOF\nls" % X), 'allow')

    def test_continuation_inside_single_quotes_is_literal(self):
        # `echo 'r\<newline>m -rf x'` prints text; nothing is joined into a command.
        self.assertEqual(verdict("echo 'r\\\nm -rf /nonexistent-path-a'"), 'allow')

    def test_escaped_backslash_before_newline_is_not_a_continuation(self):
        joined = hook._join_continuations('a\\\\\nb')
        self.assertEqual(joined, 'a\\\\\nb')

    def test_join_leaves_a_comment_line_alone(self):
        # A `#` at the start of a word opens a comment: its trailing backslash is not a continuation.
        self.assertEqual(hook._join_continuations('a # c \\\nrm x'), 'a # c \\\nrm x')
        # ...but a `#` that is not at the start of a word (or is quoted) is no comment.
        self.assertEqual(hook._join_continuations('a#b \\\nc'), 'a#b c')
        self.assertEqual(hook._join_continuations('echo "a # b \\\nc"'), 'echo "a # b c"')

    def test_join_removes_only_continuations(self):
        self.assertEqual(hook._join_continuations('r\\\nm -rf x'), 'rm -rf x')
        self.assertEqual(hook._join_continuations('no continuation here'), 'no continuation here')
        self.assertEqual(hook._join_continuations("'a\\\nb'"), "'a\\\nb'")
        self.assertEqual(hook._join_continuations('"a\\\nb"'), '"ab"')


class TestSegmentsAmpersand(unittest.TestCase):
    def test_single_ampersand_splits(self):
        self.assertEqual(hook.segments('a & b'), ['a', 'b'])

    def test_not_split(self):
        for text in ('a && b', 'a &> f', 'a &>> f', 'a >&2', 'a 2>&1', 'a <&3'):
            with self.subTest(text=text):
                self.assertEqual(len([s for s in hook.segments(text) if s.strip() == '&']), 0)
        self.assertEqual(hook.segments('a && b'), ['a', 'b'])
        self.assertEqual(hook.segments('a 2>&1'), ['a 2>&1'])
        self.assertEqual(hook.segments('a &> f'), ['a &> f'])

    def test_ampersand_in_quotes_is_text(self):
        self.assertEqual(hook.segments('echo "a & b"'), ['echo "a & b"'])


class TestHostileInputIsLinear(unittest.TestCase):
    """CPU time, not wall clock (the machine may be loaded): each hostile 250 KB shape well under the 4 s
    inspection budget, and far under the 10 s hook timeout."""

    LIMIT = 3.0

    def _cpu(self, cmd):
        self.assertLessEqual(len(cmd), hook.MAX_CMD_CHARS)
        t0 = time.process_time()
        verdict(cmd)
        return time.process_time() - t0

    def test_many_continuations(self):
        self.assertLess(self._cpu('r\\\n' * 80000), self.LIMIT)

    def test_many_ampersands(self):
        self.assertLess(self._cpu('a & ' * 60000), self.LIMIT)

    def test_many_keyword_segments(self):
        self.assertLess(self._cpu('; then ' * 35000), self.LIMIT)

    def test_many_case_patterns(self):
        self.assertLess(self._cpu('case x in a) ' * 18000), self.LIMIT)


if __name__ == '__main__':
    unittest.main(verbosity=2)
