#!/usr/bin/env python3
"""Unit tests for scripts/hooks/shell_subst.py (the command-substitution reader).

The case list scripts/hooks/shell-subst-cases.json is shared with the JS twin
(scripts/shell-subst.mjs, src/__tests__/shell-subst.test.ts): both must give the same bodies.
Also: the linear-time ceiling on hostile input, and the differential property against a real
shell (the shell is asked to run only `echo`-like probes, never anything destructive).
"""
import importlib.util
import json
import os
import random
import re
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOKS = os.path.join(os.path.dirname(_HERE), "hooks")
sys.path.insert(0, _HERE)
sys.path.insert(0, _HOOKS)

import shell_subst  # noqa: E402
from timing_budget import LINEAR_CEILING_SEC, best_of, describe  # noqa: E402

with open(os.path.join(_HOOKS, "shell-subst-cases.json"), encoding="utf-8") as _f:
    CASES = json.load(_f)


class TestSharedCases(unittest.TestCase):
    def test_every_case(self):
        for case in CASES:
            with self.subTest(case["name"]):
                self.assertEqual(shell_subst.top_bodies(case["command"]), case["bodies"], repr(case["command"]))

    def test_case_list_is_not_trivially_small(self):
        self.assertGreaterEqual(len(CASES), 40)


class TestRecursion(unittest.TestCase):
    """top_bodies() gives the OUTERMOST bodies; recursing on them finds each next level."""

    @staticmethod
    def _all(text, acc=None):
        acc = [] if acc is None else acc
        for b in shell_subst.top_bodies(text):
            acc.append(b)
            TestRecursion._all(b, acc)
        return acc

    def test_each_level_is_reachable(self):
        self.assertEqual(self._all('echo "$(echo "$(echo `rm x`)")"'), ['echo "$(echo `rm x`)"', 'echo `rm x`', 'rm x'])

    def test_every_nested_shape_reaches_the_command(self):
        for cmd in (
            'a "$(b "$(c "$(rm x)")")"',
            'a `b \\`c \\\\\\`rm x\\\\\\` \\``',
            'cat <<EOF\n$(b "$(rm x)")\nEOF\n',
            'a <(b <(rm x))',
            'a $(b $(c $(rm x)))',
        ):
            with self.subTest(cmd):
                self.assertTrue(any(b.strip() == "rm x" for b in self._all(cmd)), self._all(cmd))


class TestNeverRaises(unittest.TestCase):
    def test_garbage_does_not_raise(self):
        rnd = random.Random(11)
        atoms = ["$(", ")", "`", "'", '"', "\\", "<<", "<<-", "EOF", "\n", "#", "<(", ">(", "$'", " ", "a", "$((", "<<<"]
        for _ in range(5000):
            text = "".join(rnd.choice(atoms) for _ in range(rnd.randint(0, 30)))
            self.assertIsInstance(shell_subst.top_bodies(text), list)
            self.assertIsInstance(shell_subst.top_bodies(text, True), list)


class TestLinear(unittest.TestCase):
    SIZE = 262144

    def _budget(self, text):
        t = best_of(lambda: shell_subst.top_bodies(text))
        self.assertLess(t, LINEAR_CEILING_SEC, describe(t))

    def test_unterminated_substitutions(self):
        self._budget("$(" * (self.SIZE // 2))

    def test_unterminated_double_quoted_substitutions(self):
        self._budget('"$(' * (self.SIZE // 3))

    def test_backticks(self):
        self._budget("`a" * (self.SIZE // 2))

    def test_many_heredoc_openers(self):
        self._budget("<<A\n" * (self.SIZE // 4))

    def test_many_bodies(self):
        self._budget('echo "$(a)" ' * (self.SIZE // 12))

    def test_parens_and_quotes(self):
        self._budget("(" * self.SIZE)
        self._budget("'a' " * (self.SIZE // 4))
        self._budget("\\" * self.SIZE)

    def test_long_heredoc_delimiter_word(self):
        self._budget("cat <<" + "a" * self.SIZE)
        self._budget("cat <<" + "'a'" * (self.SIZE // 3))


@unittest.skipUnless(os.path.exists("/bin/bash"), "needs bash")
class TestAgainstRealShell(unittest.TestCase):
    """What the shell runs (probe markers on stderr) equals what the reader returns.

    Substitutions hold only `echo MARK >&2` or a bare marker word (a "command not found" line
    when run), so nothing here can touch the machine. A literal marker (single quote, comment,
    escaped, quoted heredoc) must NOT be run by the shell and must NOT be a body.
    """

    def _gen(self, rnd):
        n = [0]

        def mark(kind):
            n[0] += 1
            return "MARK%s%d" % (kind, n[0])

        def leaf():
            return "echo %s >&2" % mark("X")

        def cmd_exec(d):
            r = rnd.random()
            if d <= 0 or r < 0.3:
                return leaf()
            if r < 0.5:
                return "echo " + word(d - 1, "cmd") + " " + word(d - 1, "cmd") + "; " + leaf()
            if r < 0.7:
                return leaf() + " ; echo " + word(d - 1, "cmd")
            return "echo " + word(d - 1, "cmd")

        def word(d, ctx):
            r = rnd.random()
            if ctx == "cmd":
                if r < 0.15:
                    return "plain"
                if r < 0.3:
                    return "'lit $(%s) `%s` x'" % (mark("L"), mark("L"))
                if r < 0.5 and d > 0:
                    return '"' + "".join(word(d - 1, "dq") for _ in range(rnd.randint(1, 3))) + '"'
                if r < 0.65 and d > 0:
                    return "$(" + cmd_exec(d - 1) + ")"
                if r < 0.75 and d > 0:
                    return "`" + cmd_exec(d - 1).replace("`", "\\`") + "`"
                if r < 0.8:
                    return "\\$(%s)" % mark("L")
                if r < 0.85:
                    return "\\`"
                if r < 0.9:
                    return "$'a\\'b $(%s)'" % mark("L")
                return "w"
            if r < 0.3:
                return "txt "
            if r < 0.5:
                return "it's "
            if r < 0.7 and d > 0:
                return "$(" + cmd_exec(d - 1) + ")"
            if r < 0.85 and d > 0:
                return "`" + cmd_exec(d - 1).replace("`", "\\`") + "`"
            if r < 0.92:
                return "\\$(%s)" % mark("L")
            return '\\"'

        cmd = "echo " + " ".join(word(3, "cmd") for _ in range(rnd.randint(1, 3)))
        r = rnd.random()
        if r < 0.15:
            cmd += "\ncat <<EOF >/dev/null\nbody $(%s) `%s` \\$(%s) \"q\" 's'\nEOF\n" % (mark("X"), mark("X"), mark("L"))
        elif r < 0.3:
            cmd += "\ncat <<'EOF' >/dev/null\nbody $(%s) `%s`\nEOF\n" % (mark("L"), mark("L"))
        elif r < 0.4:
            cmd += "\n# comment $(%s) `%s`\necho done" % (mark("L"), mark("L"))
        elif r < 0.5:
            cmd += ' # trailing $(%s) "\n:' % mark("L")
        return cmd

    @staticmethod
    def _all(text, acc=None):
        acc = [] if acc is None else acc
        for b in shell_subst.top_bodies(text):
            acc.append(b)
            TestAgainstRealShell._all(b, acc)
        return acc

    def test_random_commands(self):
        rnd = random.Random(20261102)
        checked = 0
        for _ in range(400):
            cmd = self._gen(rnd)
            p = subprocess.run(["/bin/bash", "-c", cmd], capture_output=True, text=True, timeout=20,
                               env={"PATH": "/usr/bin:/bin"})
            if "syntax error" in p.stderr or "unexpected EOF" in p.stderr:
                continue
            checked += 1
            ran_x = set(re.findall(r"MARKX\d+", p.stderr))
            ran_l = set(re.findall(r"(MARKL\d+): command not found", p.stderr))
            bodies = self._all(cmd)
            found_x = set(re.findall(r"MARKX\d+", "\n".join(bodies)))
            found_l = set()
            for body in bodies:
                for part in re.split(r"[;\n]", body):
                    m = re.fullmatch(r"\s*(MARKL\d+)\s*", part)
                    if m:
                        found_l.add(m.group(1))
            self.assertEqual((ran_x, ran_l), (found_x, found_l), repr(cmd))
        self.assertGreater(checked, 250)


if __name__ == "__main__":
    unittest.main()
