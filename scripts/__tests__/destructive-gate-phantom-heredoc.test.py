#!/usr/bin/env python3
"""Phantom heredoc openers in scripts/hooks/destructive-gate.py.

The heredoc scan used `re.search('<<-?\\s*NAME')` on every line. The 2nd and 3rd `<` of a here-string
(`cat <<< x`), a `<<word` inside a comment or inside quotes all read as an opener, and with no delimiter line
the "body" ran to the END of the command: a destructive command on the NEXT line was blanked as heredoc data and
allowed. On one line it was denied. The base had the same hole (not a regression of the earlier gate work), but
the shapes are everyday ones.

The opener is now a `<<` the shell reads as one: outside quotes and comments, not part of `<<<`, not in `$(( ))`,
with the quote state carried across lines. Real heredocs (file, quoted delimiter, `<<-`, two on a line, one inside
`"$(cat <<'EOF' ...)"`, an interpreter's) keep their verdicts. Missing an opener is the safe error, so every
change here can only ADD a refusal.

The banned command is never run: only check_bash's verdict and the heredoc ranges are read. Neutral fixtures.
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
_spec = importlib.util.spec_from_file_location("destructive_gate_phantom", _HOOK_PATH)
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


class TestPhantomOpenersDoNotHideTheNextLine(unittest.TestCase):
    """Each shape: text that LOOKS like an opener, then a destructive command on the next line."""

    SHAPES = [
        ('here-string', "cat <<< x\n" + X),
        ('here-string, quoted word', "cat <<< 'x'\n" + X),
        ('here-string, glued', "cat<<<x\n" + X),
        ('here-string, a blank line between', "cat <<< x\n\n" + X),
        ('two here-strings', "cat <<< a <<< b\n" + X),
        ('grep with a here-string', "grep a <<< b\n" + X),
        ('read -r with a here-string', "read -r v <<< x\n" + X),
        ('here-string, an unrelated line, then the command', "cat <<< x\necho y\n" + X),
        ('comment holding <<<', "echo a # <<< x\n" + X),
        ('single-quoted <<<', "echo '<<< x'\n" + X),
        ('double-quoted <<<', 'echo "<<< x"\n' + X),
        ('here-string inside a substitution', 'echo "$(cat <<< x)"\n' + X),
        ('double-quoted << text', 'echo "a <<EOF b"\n' + X),
        ('single-quoted << text', "echo 'a <<EOF b'\n" + X),
        ('trailing comment', "ls # see <<EOF\n" + X),
        ('comment line', "# see <<EOF\n" + X),
        ('a quote that spans lines holds the opener', 'echo "line one\n<<EOF\nline three"\n' + X),
        ('a single quote that spans lines', "echo 'one\n<<EOF\nthree'\n" + X),
        ('shift in arithmetic', "echo $((1<<n))\n" + X),
        ('shift in arithmetic inside double quotes', 'echo "$((a <<b))"\n' + X),
    ]

    def test_next_line_command_is_denied(self):
        for name, cmd in self.SHAPES:
            with self.subTest(name):
                self.assertEqual(verdict(cmd), 'deny', cmd)

    def test_no_range_is_cut_for_them(self):
        for name, cmd in self.SHAPES:
            with self.subTest(name):
                self.assertEqual(hook._heredoc_body_ranges(cmd), ([], []), cmd)

    def test_same_line_was_and_stays_denied(self):
        self.assertEqual(verdict("cat <<< x; " + X), 'deny')
        self.assertEqual(verdict(X), 'deny')


class TestRealHeredocsKeepTheirVerdicts(unittest.TestCase):
    def test_allow(self):
        shapes = [
            ('file heredoc, the body quotes the command', "cat > /tmp/f <<EOF\n" + X + "\nEOF\n"),
            ('quoted delimiter', "cat <<'EOF' > f\n" + X + "\nEOF\n"),
            ('double-quoted delimiter', 'cat <<"EOF" > f\n' + X + "\nEOF\n"),
            ('dash heredoc, tab-indented terminator', "cat <<-EOF > f\n\t" + X + "\n\tEOF\n"),
            ('commit-message heredoc inside a double-quoted substitution',
             "git commit -m \"$(cat <<'EOF'\nthen " + X + "\nEOF\n)\""),
            ('a here-string, then a real heredoc on the same line', "cat <<< x; cat > f <<EOF\n" + X + "\nEOF\n"),
            ('a comment line, then a real heredoc', "# note\ncat > f <<EOF\n" + X + "\nEOF\n"),
            ('a body that holds an unbalanced quote and a comment sign', "cat > f <<EOF\nit's # <<X\n" + X + "\nEOF\n"),
            ('two heredocs on one line', "cat <<A <<B > f\n" + X + "\nA\n" + X + "\nB\n"),
            ('an unterminated heredoc runs to the end, like the shell', "cat > f <<EOF\n" + X),
            ('python heredoc that is harmless', "python3 - <<PY\nprint(1)\nPY\n"),
        ]
        for name, cmd in shapes:
            with self.subTest(name):
                self.assertEqual(verdict(cmd), 'allow', cmd)

    def test_command_after_a_closed_heredoc_is_still_read(self):
        self.assertEqual(verdict("cat > f <<EOF\nhello\nEOF\n" + X), 'deny')
        self.assertEqual(verdict("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"\n" + X), 'deny')

    def test_an_interpreter_heredoc_body_is_code_and_is_read(self):
        data, code = hook._heredoc_body_ranges("python3 - <<PY\nimport os\nPY\n")
        self.assertEqual((data, code), ([], [(15, 25)]))
        # a shell or interpreter that RUNS the body: the command in it is read (same verdict as before this change)
        self.assertEqual(verdict("bash <<EOF\n" + X + "\nEOF\n"), 'deny')
        self.assertEqual(verdict("python3 - <<PY\n" + X + "\nPY\n"), 'deny')

    def test_exact_ranges(self):
        self.assertEqual(hook._heredoc_body_ranges("cat <<EOF > f\nab\nEOF\nrm x"), ([(14, 17)], []))
        self.assertEqual(hook._heredoc_body_ranges("cat <<-EOF > f\n\tab\n\tEOF\nrm x"), ([(15, 19)], []))
        # the opener inside a double-quoted command substitution (a commit message) IS one: its body is cut
        cmd = "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\""
        self.assertEqual(hook._heredoc_body_ranges(cmd), ([(29, 33)], []))
        self.assertEqual(cmd[29:33], "msg\n")
        # no delimiter line: the body runs to the end of the command
        self.assertEqual(hook._heredoc_body_ranges("cat <<EOF > f\nab\ncd"), ([(14, 19)], []))
        # two openers: their bodies follow one after the other
        self.assertEqual(hook._heredoc_body_ranges("cat <<A <<B\nx\nA\ny\nB\n"), ([(12, 14), (16, 18)], []))


class TestCostStaysLinear(unittest.TestCase):
    def test_scan_cpu_time(self):
        # CPU time, not wall clock: a loaded machine is not the gate's fault. Measured 0.05 s each.
        size = 250000
        inputs = ["cat <<A\n" * (size // 8), "bash -c \"a\" " * (size // 12), "$(" * (size // 2),
                  "cat <<a " * (size // 8), "# x <<a\n" * (size // 8), "echo \"" * (size // 6)]
        for cmd in inputs:
            t0 = time.process_time()
            hook._heredoc_body_ranges(cmd)
            self.assertLess(time.process_time() - t0, 1.0, cmd[:20])


if __name__ == '__main__':
    unittest.main(verbosity=2)
