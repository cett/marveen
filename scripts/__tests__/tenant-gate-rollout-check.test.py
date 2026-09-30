"""tenant-gate-rollout-check.py: the read-only rollout report (neutral fixtures only)."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "tenant-gate-rollout-check.py")
MATCHER = "Skill|Read|Edit|Write|NotebookEdit|Glob|Grep|Bash"


def cmd(script):
    return "command -v python3 >/dev/null 2>&1 || { echo 'x: python3 not found -- DENY' >&2; exit 2; }; python3 \"/p/%s\"" % script


def full_settings():
    return {"hooks": {
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": cmd("tenant-context.py")}]}],
        "PreToolUse": [{"matcher": MATCHER, "hooks": [{"type": "command", "command": cmd("tenant-skill-gate.py")}]}],
    }}


class TestRolloutCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, "scripts", "hooks"))
        for n in ("tenant-context.py", "tenant-skill-gate.py", "tenant_context_lib.py"):
            open(os.path.join(self.root, "scripts", "hooks", n), "w").close()
        os.makedirs(os.path.join(self.root, "store"))
        self.db = os.path.join(self.root, "store", "claudeclaw.db")
        con = sqlite3.connect(self.db)
        con.executescript("""
            CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
            INSERT INTO schema_version VALUES (64), (65);
            CREATE TABLE tenant_channel_bindings (agent_id TEXT, channel TEXT, external_id TEXT, tenant_id TEXT);
            CREATE TABLE agent_tenant_context (agent_id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, source TEXT,
                                               session_id TEXT, updated_at INTEGER);
            CREATE TABLE tenants (id TEXT PRIMARY KEY, main_agent_id TEXT, disabled_at INTEGER);
            CREATE TABLE tenant_agent_availability (tenant_id TEXT, agent_id TEXT, enabled INTEGER);
            INSERT INTO tenants VALUES ('t-x', NULL, NULL), ('t-y', NULL, NULL);
        """)
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def agent(self, name, settings=None):
        d = os.path.join(self.root, "agents", name, ".claude")
        os.makedirs(d)
        if settings is not None:
            with open(os.path.join(d, "settings.json"), "w") as f:
                json.dump(settings, f)

    def sql(self, *stmts):
        con = sqlite3.connect(self.db)
        for s in stmts:
            con.execute(s)
        con.commit()
        con.close()

    def run_check(self, *extra, main="main-a"):
        p = subprocess.run([sys.executable, SCRIPT, "--root", self.root, "--json", *extra], capture_output=True,
                           text=True, env=dict(os.environ, MAIN_AGENT_ID=main, HOME=self.root))
        return p.returncode, json.loads(p.stdout)

    def levels(self, out, subject):
        return [r["level"] for r in out["results"] if r["subject"] == subject]

    def test_wired_agent_is_ok_and_evidence_is_reported(self):
        self.agent("a1", full_settings())
        self.sql("INSERT INTO agent_tenant_context VALUES ('a1','t-x','bound','s','',0)")
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.levels(out, "a1"), ["OK", "INFO"])   # wired + hook evidence

    def test_wired_agent_without_a_context_row_is_info_not_a_failure(self):
        self.agent("a1", full_settings())
        code, out = self.run_check()
        self.assertEqual(code, 0)
        msg = [r["message"] for r in out["results"] if r["subject"] == "a1" and r["level"] == "INFO"][0]
        self.assertIn("no agent_tenant_context row yet", msg)

    def test_missing_half_wired_and_stale_matcher_fail(self):
        self.agent("no-file")
        self.agent("none", {"hooks": {}})
        half = full_settings()
        half["hooks"]["UserPromptSubmit"] = []
        self.agent("half", half)
        stale = full_settings()
        stale["hooks"]["PreToolUse"][0]["matcher"] = "Bash"
        self.agent("stale", stale)
        code, out = self.run_check()
        self.assertEqual(code, 1)
        for name in ("no-file", "none", "half", "stale"):
            self.assertEqual(self.levels(out, name), ["FAIL"], name)
        self.assertIn("gate matcher", [r["message"] for r in out["results"] if r["subject"] == "stale"][0])

    def test_non_fail_closed_command_fails(self):
        s = full_settings()
        s["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"] = 'python3 "/p/tenant-context.py"'
        s["hooks"]["PreToolUse"][0]["hooks"][0]["command"] = 'python3 "/p/tenant-skill-gate.py"'
        self.agent("open", s)
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("fail-closed", [r["message"] for r in out["results"] if r["subject"] == "open"][0])

    def test_main_agent_is_skipped_as_sub_agent_and_warned_when_gated(self):
        self.agent("main-a")                                   # no settings, must NOT fail
        code, out = self.run_check()
        self.assertEqual(code, 0)
        self.assertEqual(self.levels(out, "main-a"), [])
        self.assertEqual(self.levels(out, "main agent (main-a)"), ["OK"])
        os.makedirs(os.path.join(self.root, ".claude"))
        with open(os.path.join(self.root, ".claude", "settings.json"), "w") as f:
            json.dump(full_settings(), f)
        code, out = self.run_check("--strict")
        self.assertEqual(self.levels(out, "main agent (main-a)"), ["WARN"])
        self.assertEqual(code, 1)                              # --strict turns a WARN into a failing exit

    def test_missing_migration_and_scripts_fail(self):
        self.sql("DELETE FROM schema_version WHERE version = 65", "DROP TABLE agent_tenant_context")
        os.remove(os.path.join(self.root, "scripts", "hooks", "tenant-skill-gate.py"))
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(self.levels(out, "migration"), ["OK", "FAIL"])
        self.assertIn("FAIL", self.levels(out, "script"))

    def test_multi_tenant_agent_without_binding_warns_and_with_binding_is_ok(self):
        self.sql("INSERT INTO tenant_agent_availability VALUES ('t-x','m1',1), ('t-y','m1',1), ('t-x','s1',1)")
        code, out = self.run_check()
        self.assertEqual(code, 0)                              # a WARN alone does not fail
        self.assertEqual(self.levels(out, "m1"), ["WARN"])
        self.assertEqual(self.levels(out, "s1"), [])           # single-tenant agents are not listed
        self.sql("INSERT INTO tenant_channel_bindings VALUES ('m1','telegram','1','t-x')")
        _, out = self.run_check()
        self.assertEqual(self.levels(out, "m1"), ["OK"])
        self.sql("UPDATE tenants SET disabled_at = 5 WHERE id = 't-y'")   # a disabled tenant does not count
        _, out = self.run_check()
        self.assertEqual(self.levels(out, "m1"), [])

    def test_unreadable_database_fails_and_nothing_is_written(self):
        code, out = self.run_check("--db", os.path.join(self.root, "nope", "x.db"))
        self.assertEqual(code, 1)
        self.assertIn("FAIL", self.levels(out, "database"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "nope")))


if __name__ == "__main__":
    unittest.main()
