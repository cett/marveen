#!/usr/bin/env python3
"""scripts/hooks/tenant-skill-gate.py: a Bash command over MAX_BASH_COMMAND_CHARS (128 KiB) is refused before shlex runs.

The only scanned field that is free text is a Bash command; Read/Edit/Write/NotebookEdit are scanned by their
file_path / notebook_path alone, so a large Write (its content) is NOT touched by the limit. The command is read
with shlex, a pure-Python lexer that grows a word by string concatenation (quadratic in one long word): a
131072-character word costs about 0.6 s on Python 3.14 and about 0.7 s (max 0.9 s) on Python 3.9 for the two passes on an
unloaded machine, one 550 kB word took 13.6 s, past the host timeout, and a hook that runs into it is non-blocking.
Over the limit the gate DENIES (exit 2, reason code input_too_large) with an O(1) length check, before any tokenizing.
A path word over MAX_PATH_WORD_CHARS (4096) is NOT resolved: os.path.realpath is quadratic in the components of one
path (a ~65000-component word: whole gate median 2.6 s, max 4.4 s on a loaded machine, Python 3.9). It is skipped and
not refused, because a legitimate command carries long words with a "/" that are no path (base64, curl -d, python3 -c,
git commit -m, a URL); its textual and normpath variants are still matched, and when the normalized form is within the
limit (a `x/../` padding collapses) that form is resolved, so a symlink behind padding is followed. The fields that ARE a path (file_path /
notebook_path, Glob and Grep path) are refused over the limit; a Grep / Glob pattern is free text and only skipped.

Pinned here: the limit; the boundary (LIMIT - 1, LIMIT allowed through to the normal path, LIMIT + 1 refused);
a 550 kB command refused quickly; a huge Write / Edit content is not refused; a normal command is unchanged; the
path-field boundary (4095, 4096, 4097), the resolve boundary of a command word (realpath called up to 4096 only),
the five real commands with a long word and the Grep patterns not refused, the deep word on 3.9 and 3.14 under 3 s,
a literal skill path with "x/../" padding still found, and three mutants (length skip off, normpath off, path-field
limit off) that these checks catch.
Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "tenant-skill-gate.py")
MARK = "tul nagy ahhoz"
PATH_MARK = "utvonal-mezo tul hosszu"


def longest_distinct_words(unit="/a", count=31, n=4096):
    """`count` distinct path words of exactly `n` characters (the longest the gate resolves), space separated."""
    words = []
    for i in range(count):
        w = "/%d" % i
        words.append(w + (unit * n)[: n - len(w)])
    return " ".join(words)


def load():
    sys.path.insert(0, os.path.dirname(GATE))
    spec = importlib.util.spec_from_file_location("tsg_limit", GATE)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run_gate(tool, tool_input):
    payload = {"tool_name": tool, "tool_input": tool_input, "cwd": "/tmp"}
    t = time.perf_counter()
    p = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(), capture_output=True, timeout=120)
    return p.returncode, (p.stdout + p.stderr).decode(errors="replace"), time.perf_counter() - t


class LimitTest(unittest.TestCase):
    def test_the_limit_is_128_kib_like_the_outgoing_copy_gate_command_limit(self):
        # shlex is quadratic in one long word, so a higher limit gets close to the 10 s host timeout; 128 KiB
        # (worst measured shape, one long word: about 0.6 s on Python 3.14, about 0.7 s on 3.9) is the command limit the outgoing-copy gate already enforces.
        self.assertEqual(load().MAX_BASH_COMMAND_CHARS, 131072)

    def test_the_boundary_is_exact(self):
        limit = load().MAX_BASH_COMMAND_CHARS
        for delta, refused in ((-1, False), (0, False), (1, True)):
            with self.subTest(length=limit + delta):
                cmd = "x " * ((limit + delta) // 2) + "x" * ((limit + delta) % 2)
                self.assertEqual(len(cmd), limit + delta)
                rc, out, _ = run_gate("Bash", {"command": cmd})
                self.assertEqual(MARK in out, refused, out[:200])
                if refused:
                    self.assertEqual(rc, 2)

    def test_a_550_kb_command_is_refused_quickly(self):
        for cmd in ("x" * 550_000, "../" * 183_000, "\\ " * 275_000):
            rc, out, secs = run_gate("Bash", {"command": cmd})
            self.assertEqual(rc, 2)
            self.assertIn(MARK, out)
            self.assertLess(secs, 0.3)  # includes the interpreter start; the refusal itself is O(1)

    def test_the_worst_shapes_inside_the_limit_finish_in_under_3_s(self):
        # Inside the limit the cost is per distinct path word (realpath, expanduser), and the word list was
        # de-duplicated with a list "in" test: 131072 characters of distinct `/pN` words took 4.1 s.
        # A word over MAX_PATH_WORD_CHARS is not resolved (see the next tests); it still pays the shlex pass.
        limit = load().MAX_BASH_COMMAND_CHARS
        shapes = {
            "distinct /pN words": "".join("/p%d " % i for i in range(30000))[:limit],
            "distinct a/bN words": "".join("a/b%d " % i for i in range(30000))[:limit],
            "one long word": "x" * limit,
            "one long path": ("/" + "a/" * limit)[:limit],
            "../ repeated": ("../" * limit)[:limit],
            "distinct words at the path-word limit": longest_distinct_words(),
            "distinct '..' words at the path-word limit": longest_distinct_words("/tmp/.."),
        }
        for name, cmd in shapes.items():
            with self.subTest(shape=name):
                self.assertLessEqual(len(cmd), limit)
                rc, out, secs = run_gate("Bash", {"command": cmd})
                self.assertEqual(rc, 0, out[:200])
                self.assertLess(secs, 3)

    def test_the_path_word_limit_is_4096(self):
        # PATH_MAX is 1024 on macOS and 4096 on Linux: a longer word is no real path.
        self.assertEqual(load().MAX_PATH_WORD_CHARS, 4096)

    def test_the_path_field_boundary_is_exact(self):
        # The fields that ARE a path are refused over the limit: file_path / notebook_path, Glob and Grep path.
        for delta, refused in ((-1, False), (0, False), (1, True)):
            n = 4096 + delta
            word = ("/" + "a/" * n)[:n]
            self.assertEqual(len(word), n)
            for tool, key in (("Read", "file_path"), ("Write", "file_path"), ("Edit", "file_path"),
                              ("NotebookEdit", "notebook_path"), ("Glob", "path"), ("Grep", "path")):
                with self.subTest(length=n, tool=tool):
                    rc, out, _ = run_gate(tool, {key: word, "pattern": "x"})
                    self.assertEqual(rc, 2 if refused else 0, out[:200])
                    self.assertEqual(PATH_MARK in out, refused, out[:200])

    def test_a_long_word_in_a_bash_command_is_not_refused_but_not_resolved(self):
        # Four boundary words: resolved up to the limit, skipped over it (counted with a patched realpath).
        mod = load()
        calls = []
        real = os.path.realpath
        mod.os.path.realpath = lambda p: calls.append(len(p)) or real(p)
        try:
            for n, resolved in ((4095, True), (4096, True), (4097, False), (100000, False)):
                for name, word in (("absolute", ("/" + "a/" * n)[:n]), ("relative", ("r" + "/a" * n)[:n]),
                                   ("tilde", ("~/" + "a/" * n)[:n])):
                    with self.subTest(length=n, kind=name):
                        del calls[:]
                        mod.bash_skill_dirs("ls " + word, "/tmp")
                        self.assertEqual(len([c for c in calls if c >= n]) == 1, resolved, calls)
        finally:
            mod.os.path.realpath = real

    def test_real_commands_with_a_long_word_are_not_refused(self):
        # The five commands a path-word DENY would have blocked: a long word with a "/" in it that is no path.
        b64 = ("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo/KzAxMjM0NTY3ODk" * 100)[:5000]
        code = "import os\nprint(os.getcwd() + '/x')\n" + "x = 1  # /pad\n" * 440
        cmds = {
            "echo | base64 -d": "echo %s | base64 -d" % b64,
            "curl -d": "curl -s -X POST -d '%s' https://example.test/api" % b64,
            "python3 -c": "python3 -c '%s'" % code,
            "git commit -m": "git commit -m '%s'" % ("fix: the path /a/b is handled; " * 170),
            "curl URL": "curl -s 'https://example.test/%s'" % ("a/" * 2600),
        }
        for name, cmd in cmds.items():
            with self.subTest(command=name):
                self.assertGreater(len(cmd), 4096)
                rc, out, secs = run_gate("Bash", {"command": cmd})
                self.assertEqual(rc, 0, out[:200])
                self.assertLess(secs, 3)
        # Grep: a 5 kB pattern, and a 550 kB one, are free text and are not refused
        for pattern in ("a/" * 2600, "a/" * 275_000):
            rc, out, secs = run_gate("Grep", {"pattern": pattern, "path": "/tmp"})
            self.assertEqual(rc, 0, out[:200])
            self.assertLess(secs, 3)

    def test_a_long_word_still_matches_a_literal_skill_path_even_with_dot_dot_padding(self):
        # Not resolved, but the textual match and the lexical (normpath) variant, both linear, still run on it:
        # "x/../" padding must not hide the real skill directory.
        mod = load()
        plain = "/p/.claude/skills/tenant-y-tool/SKILL.md" + "/" + "a/" * 2500
        padded = "/p/.claude/skills/" + "x/../" * 1200 + "tenant-y-tool/SKILL.md"
        for name, word in (("literal", plain), ("padded", padded)):
            with self.subTest(word=name):
                self.assertGreater(len(word), 4096)
                self.assertIn("tenant-y-tool", mod.bash_skill_dirs("cat " + word, "/tmp"))

    def _link_fixture(self):
        """tmp/.claude-less tree: tmp/skills-root/secretskill/SKILL.md and tmp/link -> tmp/skills-root, where the
        skills root is reached as .../.claude/skills only through the link, so only a followed symlink shows it."""
        root = tempfile.mkdtemp(prefix="tsg-link-")
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        real_skills = os.path.join(root, "real", ".claude", "skills")
        os.makedirs(os.path.join(real_skills, "secretskill"))
        os.symlink(real_skills, os.path.join(root, "link"))
        return root

    def test_a_symlink_behind_dot_dot_padding_is_followed_whatever_the_word_length(self):
        # `link/` + `x/../` * N + `secretskill/SKILL.md`: the padding collapses to a short path, so the word is
        # resolved through its normalized form even when it is longer than MAX_PATH_WORD_CHARS.
        mod = load()
        root = self._link_fixture()
        for target in (3000, 4084, 4096, 4097, 4189, 8000, 100000):
            prefix, suffix = root + "/link/", "secretskill/SKILL.md"
            word = prefix + "x/../" * ((target - len(prefix) - len(suffix)) // 5) + suffix
            with self.subTest(length=len(word)):
                self.assertLessEqual(abs(len(word) - target), 5)
                self.assertIn("secretskill", mod.bash_skill_dirs("cat " + word, "/tmp"))

    def test_a_long_word_that_does_not_collapse_is_not_resolved_and_not_refused(self):
        # The accepted remainder: a word over the limit even after normalization is neither followed nor refused.
        mod = load()
        root = self._link_fixture()
        for n in (4097, 8000):
            word = root + "/link/" + ("d/" * n)[:n] + "secretskill/SKILL.md"
            with self.subTest(length=len(word)):
                self.assertNotIn("secretskill", mod.bash_skill_dirs("cat " + word, "/tmp"))
        rc, out, _ = run_gate("Bash", {"command": "cat " + word})
        self.assertEqual(rc, 0, out[:200])

    def test_mutant_without_the_resolve_of_the_normalized_word_loses_the_padded_symlink(self):
        m = self._mutant("elif len(variants[-1]) <= MAX_PATH_WORD_CHARS:", "elif False:")
        root = self._link_fixture()
        prefix, suffix = root + "/link/", "secretskill/SKILL.md"
        word = prefix + "x/../" * 1000 + suffix
        self.assertGreater(len(word), 4096)
        self.assertNotIn("secretskill", m.bash_skill_dirs("cat " + word, "/tmp"))
        self.assertIn("secretskill", load().bash_skill_dirs("cat " + word, "/tmp"))
        short = prefix + suffix   # unchanged for a short word
        self.assertIn("secretskill", m.bash_skill_dirs("cat " + short, "/tmp"))

    def test_a_deep_path_field_is_refused_before_it_is_resolved(self):
        # One ~65000-component path inside a path field: os.path.realpath is quadratic in the components
        # (whole gate, loaded machine, Python 3.9: median 2.6 s, p90 3.8 s, max 4.4 s before the limit).
        limit = load().MAX_BASH_COMMAND_CHARS
        deep = ("/" + "a/" * limit)[:limit]
        self.assertGreater(deep.count("/"), 60000)
        for tool, inp in (("Read", {"file_path": deep}), ("Write", {"file_path": deep}), ("Edit", {"file_path": deep}),
                          ("NotebookEdit", {"notebook_path": deep}), ("Glob", {"path": deep}), ("Grep", {"path": deep})):
            with self.subTest(tool=tool):
                rc, out, secs = run_gate(tool, inp)
                self.assertEqual(rc, 2)
                self.assertIn(PATH_MARK, out)
                self.assertLess(secs, 3)

    def test_a_deep_word_elsewhere_is_not_resolved_and_finishes_in_under_3_s(self):
        # A command word, a Glob pattern, a Grep pattern / glob of ~65000 components: not refused, not resolved.
        # Run under every interpreter available (the system Python 3.9 and the current one).
        limit = load().MAX_BASH_COMMAND_CHARS
        deep = ("/" + "a/" * limit)[:limit]
        interpreters = [sys.executable] + [p for p in ("/usr/bin/python3",) if os.path.exists(p) and not os.path.samefile(p, sys.executable)]
        for py in interpreters:
            for tool, inp in (("Bash", {"command": deep}), ("Bash", {"command": "ls /tmp %s y" % deep[:60000]}),
                              ("Bash", {"command": "ls " + "/" + "x/../" * 26000 + "y/z"}),   # collapses: resolved short
                              ("Bash", {"command": "ls " + "link/" + "x/../" * 26000 + "y/z"}),
                              ("Glob", {"pattern": deep}), ("Grep", {"pattern": deep}), ("Grep", {"pattern": "x", "glob": deep})):
                with self.subTest(python=py, tool=tool):
                    payload = {"tool_name": tool, "tool_input": inp, "cwd": "/tmp"}
                    t = time.perf_counter()
                    p = subprocess.run([py, GATE], input=json.dumps(payload).encode(), capture_output=True, timeout=120)
                    self.assertEqual(p.returncode, 0, p.stderr.decode(errors="replace")[:200])
                    self.assertLess(time.perf_counter() - t, 3)

    def test_the_path_field_refusal_carries_the_reason_code_of_the_audit_lib(self):
        with open(GATE, encoding="utf-8") as fh:
            src = fh.read()
        self.assertEqual(src.count("DenyExit(2, 'input_too_large')"), 2)  # the command limit and the path-field limit

    def _mutant(self, old, new):
        """The gate source with `old` replaced by `new`, loaded as a module (the hooks dir is on sys.path)."""
        with open(GATE, encoding="utf-8") as fh:
            src = fh.read()
        self.assertEqual(src.count(old), 1, "mutation anchor drifted: %r" % old)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "tsg_mutant.py")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(src.replace(old, new))
            spec = importlib.util.spec_from_file_location("tsg_mutant", path)
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            return m

    def test_mutant_without_the_length_skip_resolves_a_deep_word(self):
        # The length skip switched off: a 5000-character word is resolved (realpath called) - the check above fails.
        m = self._mutant("if len(text) <= MAX_PATH_WORD_CHARS:", "if True:")
        calls = []
        real = os.path.realpath
        m.os.path.realpath = lambda p: calls.append(len(p)) or real(p)
        try:
            m.bash_skill_dirs("ls " + ("/" + "a/" * 2600)[:5000], "/tmp")
        finally:
            m.os.path.realpath = real
        self.assertTrue(any(c >= 5000 for c in calls), calls)

    def test_mutant_without_the_path_field_refusal_lets_a_deep_file_path_through(self):
        m = self._mutant("MAX_PATH_WORD_CHARS = 4096", "MAX_PATH_WORD_CHARS = 10 ** 9")
        self.assertEqual(m.extract("Read", {"file_path": "/" + "a/" * 20000}, "/tmp"), [])  # no PathWordTooLong

    def test_mutant_without_the_normpath_variant_loses_the_dot_dot_padded_skill_path(self):
        padded = "/p/.claude/skills/" + "x/../" * 1200 + "tenant-y-tool/SKILL.md"
        m = self._mutant("variants.append(os.path.normpath(base))", "pass")
        self.assertNotIn("tenant-y-tool", m.bash_skill_dirs("cat " + padded, "/tmp"))
        self.assertIn("tenant-y-tool", load().bash_skill_dirs("cat " + padded, "/tmp"))

    def test_the_decoded_ansi_c_copy_has_the_same_limit_as_the_command(self):
        # shlex reads the command AND a copy with every $'...' decoded. Each `\'` inside a $'...' decodes to
        # `'"'"'` (5 characters for 2), so a command inside the limit can decode to 2.5 times it.
        mod = load()
        limit = mod.MAX_BASH_COMMAND_CHARS

        def quotes(k):
            return "$'" + "\\'" * k + "'"

        k_at_limit = (limit - 2) // 5  # decoded length is 5k + 2
        self.assertEqual(len(mod._ansi_c_decoded(quotes(k_at_limit))), limit)
        for k, refused in ((k_at_limit, False), (k_at_limit + 1, True)):
            with self.subTest(decoded=len(mod._ansi_c_decoded(quotes(k)))):
                cmd = quotes(k)
                self.assertLessEqual(len(cmd), limit)
                rc, out, secs = run_gate("Bash", {"command": cmd})
                self.assertEqual(rc, 2 if refused else 0, out[:200])
                self.assertEqual(MARK in out, refused, out[:200])
        # the worst command inside the limit that decodes to 2.5 times it: refused before any lexing
        cmd = quotes((limit - 3) // 2)
        self.assertLessEqual(len(cmd), limit)
        rc, out, secs = run_gate("Bash", {"command": cmd})
        self.assertEqual(rc, 2)
        self.assertIn(MARK, out)
        self.assertLess(secs, 1)

    def test_the_number_of_distinct_tilde_user_words_is_bounded(self):
        # Each `~name` word is a pwd.getpwnam lookup (~0.15 ms on macOS): 20000 of them took ~3 s inside the size limit.
        mod = load()
        cap = mod.MAX_TILDE_USERS
        self.assertEqual(cap, 256)
        for n, refused in ((cap, False), (cap + 1, True)):
            with self.subTest(users=n):
                rc, out, secs = run_gate("Bash", {"command": " ".join("~u%d" % i for i in range(n))})
                self.assertEqual(rc, 2 if refused else 0, out[:200])
                self.assertEqual("tobb mint" in out, refused, out[:200])
        rc, out, secs = run_gate("Bash", {"command": "".join("~u%d " % i for i in range(20000))[:mod.MAX_BASH_COMMAND_CHARS]})
        self.assertEqual(rc, 2)
        self.assertLess(secs, 1)
        # `~` and `~/x` are the caller's own home, not a lookup: any number of them is fine.
        rc, out, _ = run_gate("Bash", {"command": " ".join("~/f%d" % i for i in range(5000))})
        self.assertEqual(rc, 0, out[:200])

    def test_a_large_write_or_edit_content_is_not_refused(self):
        big = "x" * 550_000
        for tool, inp in (("Write", {"file_path": "/tmp/notes.txt", "content": big}),
                          ("Edit", {"file_path": "/tmp/notes.txt", "old_string": big, "new_string": big})):
            rc, out, _ = run_gate(tool, inp)
            self.assertNotIn(MARK, out)
            self.assertEqual(rc, 0, out[:200])

    def test_a_normal_command_is_unchanged(self):
        rc, out, _ = run_gate("Bash", {"command": "ls -la /tmp"})
        self.assertEqual(rc, 0, out[:200])

    def test_the_refusal_carries_the_reason_code_of_the_audit_lib(self):
        with open(GATE, encoding="utf-8") as fh:
            self.assertIn("DenyExit(2, 'input_too_large')", fh.read())


if __name__ == "__main__":
    unittest.main()
