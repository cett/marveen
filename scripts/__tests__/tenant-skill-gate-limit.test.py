#!/usr/bin/env python3
"""scripts/hooks/tenant-skill-gate.py: a Bash command over MAX_BASH_COMMAND_CHARS (128 KiB) is refused before shlex runs.

The only scanned field that is free text is a Bash command; Read/Edit/Write/NotebookEdit are scanned by their
file_path / notebook_path alone, so a large Write (its content) is NOT touched by the limit. The command is read
with shlex, a pure-Python lexer that grows a word by string concatenation (quadratic in one long word): a
131072-character word takes well under 1 s, one 550 kB word took 13.6 s, past the host
timeout, and a hook that runs into it is non-blocking. Over the limit the gate DENIES (exit 2, reason code
input_too_large) with an O(1) length check, before any tokenizing.

Pinned here: the limit; the boundary (LIMIT - 1, LIMIT allowed through to the normal path, LIMIT + 1 refused);
a 550 kB command refused quickly; a huge Write / Edit content is not refused; a normal command is unchanged.
Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "tenant-skill-gate.py")
MARK = "tul nagy ahhoz"


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
        # (worst measured shape: well under 1 s) is the command limit the outgoing-copy gate already enforces.
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
        limit = load().MAX_BASH_COMMAND_CHARS
        shapes = {
            "distinct /pN words": "".join("/p%d " % i for i in range(30000))[:limit],
            "distinct a/bN words": "".join("a/b%d " % i for i in range(30000))[:limit],
            "one long path": ("/" + "a/" * limit)[:limit],
            "../ repeated": ("../" * limit)[:limit],
            "one long word": "x" * limit,
        }
        for name, cmd in shapes.items():
            with self.subTest(shape=name):
                self.assertEqual(len(cmd), limit)
                rc, out, secs = run_gate("Bash", {"command": cmd})
                self.assertEqual(rc, 0, out[:200])
                self.assertLess(secs, 3)

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
