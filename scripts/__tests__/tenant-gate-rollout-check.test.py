"""tenant-gate-rollout-check.py: the read-only rollout report (neutral fixtures only).

The database-side facts come from GET /api/admin/tenant-gate-status; a stub HTTP server on an ephemeral
port serves that payload so the real script runs unmodified, as a subprocess, against fixture settings files.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

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


def healthy_status():
    return {
        "now": 1000,
        "migrations": [
            {"version": 64, "table": "tenant_channel_bindings", "applied": True, "table_exists": True},
            {"version": 65, "table": "agent_tenant_context", "applied": True, "table_exists": True},
        ],
        "contexts": [],
        "multi_tenant_agents": [],
    }


class TestRolloutCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, "scripts", "hooks"))
        for n in ("tenant-context.py", "tenant-skill-gate.py", "tenant_context_lib.py"):
            open(os.path.join(self.root, "scripts", "hooks", n), "w").close()
        os.makedirs(os.path.join(self.root, "store"))
        with open(os.path.join(self.root, "store", ".dashboard-token"), "w") as f:
            f.write("test-token\n")

        self.status = healthy_status()
        self.status_code = 200
        self.requests = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                test.requests.append((self.path, self.headers.get("Authorization")))
                if self.path != "/api/admin/tenant-gate-status":
                    code, body = 404, {"error": "not_found"}
                else:
                    code, body = test.status_code, test.status
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def agent(self, name, settings=None):
        d = os.path.join(self.root, "agents", name, ".claude")
        os.makedirs(d)
        if settings is not None:
            with open(os.path.join(d, "settings.json"), "w") as f:
                json.dump(settings, f)

    def run_check(self, *extra, main="main-a", base=None):
        env = dict(os.environ, MAIN_AGENT_ID=main, HOME=self.root, MARVEEN_DASHBOARD_BASE=base or self.base)
        p = subprocess.run([sys.executable, "-B", SCRIPT, "--root", self.root, "--json", *extra], capture_output=True,
                           text=True, env=env)
        return p.returncode, json.loads(p.stdout)

    def levels(self, out, subject):
        return [r["level"] for r in out["results"] if r["subject"] == subject]

    def test_wired_agent_is_ok_and_evidence_is_reported(self):
        self.agent("a1", full_settings())
        self.status["contexts"] = [{"agent_id": "a1", "status": "bound", "tenant_id": "t-x", "updated_at": 940}]
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.levels(out, "a1"), ["OK", "INFO"])   # wired + hook evidence
        msg = [r["message"] for r in out["results"] if r["subject"] == "a1" and r["level"] == "INFO"][0]
        self.assertEqual(msg, "hook active: status=bound tenant=t-x age=60s")

    def test_the_request_is_one_authenticated_get(self):
        self.run_check()
        self.assertEqual(self.requests, [("/api/admin/tenant-gate-status", "Bearer test-token")])

    def test_wired_agent_without_a_context_row_is_info_not_a_failure(self):
        self.agent("a1", full_settings())
        code, out = self.run_check()
        self.assertEqual(code, 0)
        msg = [r["message"] for r in out["results"] if r["subject"] == "a1" and r["level"] == "INFO"][0]
        self.assertIn("no agent_tenant_context row yet", msg)

    def test_unknown_or_conflicting_context_is_called_out(self):
        self.status["contexts"] = [{"agent_id": "a9", "status": "conflict", "tenant_id": None, "updated_at": 1}]
        _, out = self.run_check()
        self.assertEqual(self.levels(out, "a9"), ["INFO"])

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
        self.status["migrations"][1].update(applied=False, table_exists=False)
        os.remove(os.path.join(self.root, "scripts", "hooks", "tenant-skill-gate.py"))
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertEqual(self.levels(out, "migration"), ["OK", "FAIL"])
        self.assertIn("FAIL", self.levels(out, "script"))

    def test_a_migration_without_its_table_fails(self):
        self.status["migrations"][0]["table_exists"] = False
        _, out = self.run_check()
        self.assertEqual(self.levels(out, "migration"), ["FAIL", "OK"])

    def test_multi_tenant_agent_without_binding_warns_and_with_binding_is_ok(self):
        self.status["multi_tenant_agents"] = [{"agent_id": "m1", "tenant_count": 2, "has_binding": False}]
        code, out = self.run_check()
        self.assertEqual(code, 0)                              # a WARN alone does not fail
        self.assertEqual(self.levels(out, "m1"), ["WARN"])
        self.assertEqual(self.levels(out, "tenants"), [])
        self.status["multi_tenant_agents"][0]["has_binding"] = True
        _, out = self.run_check()
        self.assertEqual(self.levels(out, "m1"), ["OK"])
        self.status["multi_tenant_agents"] = []                # nothing multi-tenant: an INFO, not silence
        _, out = self.run_check()
        self.assertEqual(self.levels(out, "tenants"), ["INFO"])

    def test_an_older_dashboard_without_the_endpoint_warns_so_the_pre_restart_run_still_works(self):
        self.status_code = 404
        code, out = self.run_check()
        self.assertEqual(code, 0)                              # the documented first run, before the restart
        self.assertEqual(self.levels(out, "dashboard"), ["WARN"])
        self.assertIn("older than this check", [r["message"] for r in out["results"] if r["subject"] == "dashboard"][0])
        self.assertEqual(self.levels(out, "migration"), [])
        self.assertEqual(self.levels(out, "script"), ["OK", "OK", "OK"])   # the file checks still ran
        code, _ = self.run_check("--strict")
        self.assertEqual(code, 1)

    def test_a_server_error_fails(self):
        self.status_code = 500
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("500", [r["message"] for r in out["results"] if r["subject"] == "dashboard"][0])

    def test_unreachable_dashboard_fails_and_nothing_is_written(self):
        code, out = self.run_check(base="http://127.0.0.1:1")
        self.assertEqual(code, 1)
        self.assertIn("FAIL", self.levels(out, "dashboard"))
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "store"))), [".dashboard-token"])

    def test_missing_token_fails(self):
        os.remove(os.path.join(self.root, "store", ".dashboard-token"))
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("token", [r["message"] for r in out["results"] if r["subject"] == "dashboard"][0])
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
