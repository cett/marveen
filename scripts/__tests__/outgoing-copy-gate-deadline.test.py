#!/usr/bin/env python3
"""scripts/hooks/outgoing-copy-gate.py: a check that cannot finish in time is a DENY, not a pass.

A hook still running at the host's timeout is NON-blocking, so an audit that runs past it waves the send
through unchecked. The MCP send path has no size cap (the Bash path has one): an email body of one 550 kB
word kept strip_technical() busy for over 90 s. The gate now runs its work in a child process and DENIES
(exit 2) when the child is not done within GATE_DEADLINE_SEC (default 6 s, under the 10 s host timeout).

Pinned here: an input that takes longer than the deadline is denied with the deadline message, well before
it could finish; a normal send is untouched (same exit code, no deadline message); the exit status of the
work passes through; a work killed by a signal is a deny; a work that raises is a deny.
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
MARK = "nem fejezodott be"  # the deadline message


def _rules_file():
    fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"bad_name_patterns": ["zzzneverzzz"], "correction": "x"}, fh)
    fh.close()
    return fh.name


RULES = _rules_file()


def run_gate(payload, deadline=None):
    env = dict(os.environ, OUTGOING_COPY_GATE_RULES=RULES)
    if deadline is not None:
        env["GATE_DEADLINE_SEC"] = str(deadline)
    t = time.perf_counter()
    p = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(), capture_output=True, env=env, timeout=120)
    return p.returncode, (p.stdout + p.stderr).decode(errors="replace"), time.perf_counter() - t


def email(body):
    return {"tool_name": "mcp__gmail__gmail_send_email",
            "tool_input": {"to": ["a@b.test"], "subject": "teszt", "body": body}, "cwd": "/tmp"}


# One 60 kB word: strip_technical() alone needs ~13 s on it, far past a 1 s deadline.
SLOW_BODY = "x" * 60_000
FINE_BODY = "Szia, a terv kész, és a többi is rendben van, de nem tudom hogy mikor lesz."


class DeadlineTest(unittest.TestCase):
    def test_an_input_that_outlasts_the_deadline_is_denied_quickly(self):
        rc, out, secs = run_gate(email(SLOW_BODY), deadline=1)
        self.assertEqual(rc, 2, out[:300])
        self.assertIn(MARK, out)
        self.assertLess(secs, 5, "the deny must come at the deadline, not when the audit would finish")

    def test_the_default_deadline_is_below_the_host_timeout(self):
        spec = importlib.util.spec_from_file_location("ocg_deadline", GATE)
        g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(g)
        self.assertLess(g.DEADLINE_SEC_DEFAULT, 10)
        self.assertGreater(g.DEADLINE_SEC_DEFAULT, 1)

    def test_a_normal_send_is_unaffected(self):
        rc, out, _ = run_gate(email(FINE_BODY), deadline=1)
        self.assertEqual(rc, 0, out[:300])
        self.assertNotIn(MARK, out)

    def test_a_tool_the_gate_ignores_still_passes(self):
        rc, out, _ = run_gate({"tool_name": "Read", "tool_input": {"file_path": "/tmp/x"}}, deadline=1)
        self.assertEqual(rc, 0, out[:300])

    def test_the_work_exit_status_passes_through(self):
        # A real content deny (a bad name) is exit 2 from the work itself, not from the deadline.
        env_rules = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"bad_name_patterns": ["BADNAME"], "correction": "use the right name"}, env_rules)
        env_rules.close()
        env = dict(os.environ, OUTGOING_COPY_GATE_RULES=env_rules.name, GATE_DEADLINE_SEC="5")
        p = subprocess.run([sys.executable, GATE], input=json.dumps(email("Szia BADNAME, minden rendben.")).encode(),
                           capture_output=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 2)
        self.assertNotIn(MARK, (p.stdout + p.stderr).decode(errors="replace"))

    def test_a_bad_deadline_value_falls_back_to_the_default(self):
        spec = importlib.util.spec_from_file_location("ocg_deadline2", GATE)
        g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(g)
        for bad in ("", "abc", "0", "-3"):
            os.environ["GATE_DEADLINE_SEC"] = bad
            try:
                self.assertEqual(g._deadline_seconds(), g.DEADLINE_SEC_DEFAULT)
            finally:
                os.environ.pop("GATE_DEADLINE_SEC", None)


class RunWithDeadlineTest(unittest.TestCase):
    """_run_with_deadline() on its own, with stand-in work, in a subprocess so os.fork and sys.exit are real."""

    def _run(self, work_src, seconds):
        code = (
            "import importlib.util, os, sys, time\n"
            "spec = importlib.util.spec_from_file_location('g', %r)\n"
            "g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
            "%s\n"
            "g._run_with_deadline(work, %r)\n"
            "print('PARENT-FELL-THROUGH')\n" % (GATE, work_src, seconds)
        )
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=60)
        return p.returncode, (p.stdout + p.stderr).decode(errors="replace")

    def test_exit_code_of_the_work_is_the_exit_code(self):
        self.assertEqual(self._run("def work():\n    sys.exit(0)", 5)[0], 0)
        self.assertEqual(self._run("def work():\n    sys.exit(2)", 5)[0], 2)
        self.assertEqual(self._run("def work():\n    sys.exit(7)", 5)[0], 7)

    def test_work_that_returns_is_exit_zero_and_the_parent_does_not_run_on(self):
        rc, out = self._run("def work():\n    pass", 5)
        self.assertEqual(rc, 0)
        self.assertNotIn("PARENT-FELL-THROUGH", out)

    def test_work_past_the_deadline_is_a_deny_and_is_killed(self):
        rc, out = self._run("def work():\n    time.sleep(30)", 0.3)
        self.assertEqual(rc, 2)
        self.assertIn(MARK, out)

    def test_work_killed_by_a_signal_is_a_deny(self):
        rc, _ = self._run("def work():\n    os.kill(os.getpid(), 9)", 5)
        self.assertEqual(rc, 2)

    def test_work_that_raises_is_a_deny(self):
        rc, _ = self._run("def work():\n    raise RuntimeError('boom')", 5)
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
