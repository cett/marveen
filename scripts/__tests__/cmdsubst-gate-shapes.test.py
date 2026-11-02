#!/usr/bin/env python3
"""The command-substitution shape matrix, run against every Bash gate.

A gate that matches on the command text BEFORE the shell expands it can miss what a command
substitution runs: `echo "$(X)"` is one `echo` to a splitter that keeps quoted text together,
but the shell runs X. For each gate this feeds its own forbidden command X in the shapes below,
as the gate's real hook input (the command is never run; only the verdict is read), and checks:

  * RUNS shapes (the shell runs X): the gate must deny. For destructive-gate and email-send-gate
    this was the gap; the other gates matched on the raw text and were already covering it, so
    here they are regression tests.
  * TEXT shapes (X is only text: single quotes, a quoted heredoc): the gates that read commands
    must ALLOW (no false positive from the new reading). Gates that match the raw text on
    purpose (secret-read, self-pace, tenant-skill) may deny here: over-matching is their
    stated direction, so they are not asserted on TEXT shapes.
  * A harmless control command must be allowed by every gate in the same environment, so a gate
    that denies everything (a broken setup) cannot pass the matrix.

Neutral fixtures only: example.invalid hosts, nonexistent users and paths.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(ROOT, "scripts", "hooks")
SCRIPTS = os.path.join(ROOT, "scripts")

_spec = importlib.util.spec_from_file_location("tenant_skill_gate_test", os.path.join(HERE, "tenant-skill-gate.test.py"))
tsg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tsg)

RUNS = [
    ("plain", lambda x: x),
    ("double-quoted $()", lambda x: 'echo "$(%s)"' % x),
    ("double-quoted backtick", lambda x: 'echo "`%s`"' % x),
    ("double-quoted $() with text", lambda x: 'echo "result: $(%s) done"' % x),
    ("bare $()", lambda x: "echo $(%s)" % x),
    ("bare backtick", lambda x: "echo `%s`" % x),
    ("nested double quotes", lambda x: 'echo "$(echo "$(%s)")"' % x),
    ("assignment", lambda x: 'v="$(%s)"; echo ok' % x),
    ("unquoted heredoc", lambda x: "cat <<EOF\n$(%s)\nEOF\n" % x),
    ("process substitution", lambda x: "diff <(%s) /dev/null" % x),
]
TEXT = [
    ("single quotes", lambda x: "echo '$(%s)'" % x),
    ("quoted heredoc", lambda x: "cat <<'EOF'\n$(%s)\nEOF\n" % x),
]


class Gate:
    def __init__(self, name, argv, forbidden, control, reads_commands, extra_env=None, setup=None):
        self.name, self.argv, self.forbidden, self.control = name, argv, forbidden, control
        self.reads_commands, self.extra_env, self.setup = reads_commands, extra_env or {}, setup

    def verdict(self, command, tmp, cwd):
        env = dict(os.environ, WEB_PORT="9", MARVEEN_STORE_DIR=os.path.join(tmp, "store"),
                   BASH_EGRESS_BLOCK_LOG=os.path.join(tmp, "blocks.jsonl"),
                   BASH_EGRESS_VENDOR_HOSTS=os.path.join(tmp, "vendor.json"), **self.extra_env(tmp) if callable(self.extra_env) else self.extra_env)
        ev = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd})
        p = subprocess.run(self.argv, input=ev, capture_output=True, text=True, env=env, timeout=30)
        return "deny" if (p.returncode == 2 or '"deny"' in p.stdout) else "allow", p


def _tenant_env(tmp):
    db = os.path.join(tmp, "t.db")
    if not os.path.exists(db):
        tsg.make_db(db)
        subprocess.run([sys.executable, os.path.join(HOOKS, "tenant-context.py")],
                       input=json.dumps({"cwd": tsg.CWD, "prompt": tsg.CHAN % "111", "session_id": "s"}),
                       capture_output=True, text=True, env=dict(os.environ, LEDGER_DB_PATH=db), check=True)
    return {"LEDGER_DB_PATH": db}


PY, NODE = sys.executable, "node"
GATES = [
    Gate("destructive-gate", [PY, os.path.join(HOOKS, "destructive-gate.py")],
         "rm -rf /private/tmp/claude-501/probe-nonexistent-dir", "ls -la", True),
    Gate("email-send-gate", [NODE, os.path.join(SCRIPTS, "email-send-gate.mjs")],
         "sendmail probe@example.invalid", "ls -la", True),
    Gate("auth-admin-gate", [PY, os.path.join(HOOKS, "auth-admin-gate.py")],
         "npm run dashboard-user -- create probe-nonexistent-user", "ls -la", True),
    Gate("secret-read-gate", [PY, os.path.join(HOOKS, "secret-read-gate.py")],
         "cat store/.claim-signing-key", "ls -la", False),
    Gate("bash-egress-parser", [NODE, os.path.join(HOOKS, "bash-egress-parser.mjs")],
         "curl -s https://probe.example.invalid/x", "ls -la", True),
    Gate("self-pace-gate", [NODE, os.path.join(SCRIPTS, "self-pace-gate.mjs")],
         "cp /private/tmp/claude-501/probe-nonexistent-src scripts/hooks/egress-gate.mjs", "ls -la", False),
    Gate("email-approval-gate", [PY, os.path.join(HOOKS, "email-approval-gate.py")],
         "sendmail probe@example.invalid", "ls -la", True),
    Gate("tenant-skill-gate", [PY, os.path.join(HOOKS, "tenant-skill-gate.py")],
         "cat %stenant-y-tool/SKILL.md" % tsg.SK, "ls -la", False, extra_env=_tenant_env),
]


class TestShapeMatrix(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def cwd(self, gate):
        return tsg.CWD if gate.name == "tenant-skill-gate" else ROOT

    def test_control_command_is_allowed_by_every_gate(self):
        for g in GATES:
            with self.subTest(g.name):
                v, p = g.verdict(g.control, self.tmp, self.cwd(g))
                self.assertEqual(v, "allow", "%s denied the control command: %s %s" % (g.name, p.stdout, p.stderr))

    def test_the_gate_denies_its_own_forbidden_command_plain(self):
        for g in GATES:
            with self.subTest(g.name):
                v, p = g.verdict(g.forbidden, self.tmp, self.cwd(g))
                self.assertEqual(v, "deny", "%s did not deny %r" % (g.name, g.forbidden))

    def test_runs_shapes_are_denied(self):
        for g in GATES:
            for shape, make in RUNS:
                with self.subTest("%s / %s" % (g.name, shape)):
                    v, _p = g.verdict(make(g.forbidden), self.tmp, self.cwd(g))
                    self.assertEqual(v, "deny", "%s let %r through" % (g.name, make(g.forbidden)))

    def test_text_shapes_are_allowed_by_the_command_reading_gates(self):
        for g in GATES:
            if not g.reads_commands:
                continue
            for shape, make in TEXT:
                with self.subTest("%s / %s" % (g.name, shape)):
                    v, p = g.verdict(make(g.forbidden), self.tmp, self.cwd(g))
                    self.assertEqual(v, "allow", "%s denied %r: %s %s" % (g.name, make(g.forbidden), p.stdout, p.stderr))


if __name__ == "__main__":
    unittest.main()
