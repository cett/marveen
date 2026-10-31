#!/usr/bin/env python3
"""scripts/hooks/outgoing-copy-gate.py: a text over MAX_AUDIT_CHARS (256 KiB) is refused before any pattern runs.

The MCP send path (an email body) had no size cap, unlike the Bash path (MAX_CMD_CHARS). A check that cannot
finish inside the hook timeout lets the mail through, so over the limit the gate DENIES with exit 2 and a
"too large" message; the length check is O(1) and runs first.

Pinned here: the limit is 256 KiB; a body over it is denied quickly (whatever its shape) with the message; a
body exactly at it is audited as before (not refused for size); a normal send is unchanged.
Run: python3 <thisfile>   (OUTGOING_COPY_GATE_PATH names another gate file)   Exit 0 = all pass.
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
GATE = os.environ.get("OUTGOING_COPY_GATE_PATH") or os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
MARK = "tul nagy ahhoz"


def _rules():
    fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"bad_name_patterns": ["zzzneverzzz"], "correction": "x"}, fh)
    fh.close()
    return fh.name


RULES = _rules()


def run_gate(body):
    env = dict(os.environ, OUTGOING_COPY_GATE_RULES=RULES)
    payload = {"tool_name": "mcp__gmail__gmail_send_email", "tool_input": {"to": ["a@b.test"], "subject": "teszt", "body": body}, "cwd": "/tmp"}
    t = time.perf_counter()
    p = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(), capture_output=True, env=env, timeout=120)
    return p.returncode, (p.stdout + p.stderr).decode(errors="replace"), time.perf_counter() - t


class AuditLimitTest(unittest.TestCase):
    def test_the_limit_is_256_kib(self):
        spec = importlib.util.spec_from_file_location("ocg_limit", GATE)
        g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(g)
        self.assertEqual(g.MAX_AUDIT_CHARS, 262144)

    def test_a_body_over_the_limit_is_denied_quickly_whatever_its_shape(self):
        for name, body in (
            ("one word", "x" * 262145),
            ("words", "Szia, a terv kész. " * 20000),
            ("tags", "<a " * 100000),
            ("550 kB", "x" * 550000),
        ):
            with self.subTest(name):
                rc, out, secs = run_gate(body)
                self.assertEqual(rc, 2, out[:300])
                self.assertIn(MARK, out)
                self.assertLess(secs, 3)

    def test_a_body_just_under_the_limit_is_audited_not_refused_for_size(self):
        # The limit counts the whole collected text (subject and the rest of the mail too), so stay a little under.
        rc, out, _ = run_gate("x" * 262000)
        self.assertNotIn(MARK, out)

    def test_a_normal_send_is_unchanged(self):
        rc, out, _ = run_gate("Szia, a terv kész, és a többi is rendben van, de nem tudom hogy mikor lesz.")
        self.assertEqual(rc, 0, out[:300])


if __name__ == "__main__":
    unittest.main()
