#!/usr/bin/env python3
"""Tests for scripts/approval-consume.py.

The script runs as a subprocess against a local mock dashboard, so the exit codes, the output
streams and the request the server actually received are what is asserted. Fixture data only
(neutral hashes, a fixture token); nothing here talks to a real dashboard.
"""
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "approval-consume.py")
HASH = "a" * 64
TOKEN = "fixture-token-do-not-leak-0123456789"

_spec = importlib.util.spec_from_file_location("approval_consume", SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


class Handler(http.server.BaseHTTPRequestHandler):
    # Set per test on the server object: status, payload, echo_token
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8")
        self.server.seen.append({"path": self.path, "body": json.loads(body or "null"),
                                 "auth": self.headers.get("Authorization"),
                                 "agent": self.headers.get("X-Agent-Id")})
        payload = self.server.payload
        if self.server.echo_token:
            payload = dict(payload, hint="you sent " + (self.headers.get("Authorization") or ""))
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


class CliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.token_file = os.path.join(cls.tmp.name, "agent-token")
        with open(cls.token_file, "w") as f:
            f.write(TOKEN + "\n")
        cls.empty_file = os.path.join(cls.tmp.name, "no-token")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        self.server.seen = []
        self.server.status = 200
        self.server.payload = {"ok": True, "replayed": False, "window_s": 1800,
                               "approval": {"id": "abc123", "status": "approved"}}
        self.server.echo_token = False

    def run_cli(self, *args, token_file=None, base=None):
        env = dict(os.environ)
        env["DASHBOARD_BASE_URL"] = base or "http://127.0.0.1:%d" % self.server.server_address[1]
        env["MARVEEN_AGENT_TOKEN_FILE"] = token_file or self.token_file
        env["MARVEEN_AGENT_ID"] = "main-agent"
        return subprocess.run([sys.executable, SCRIPT] + list(args), env=env, capture_output=True,
                              text=True, timeout=30)

    # --- success -------------------------------------------------------------------------

    def test_claim_by_hash_exits_zero_and_sends_the_claim(self):
        r = self.run_cli("--hash", HASH, "--ref", "msg-1", "--consumer", "sender")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertTrue(out["ok"])
        self.assertEqual(out["window_s"], 1800)
        seen = self.server.seen[0]
        self.assertEqual(seen["path"], "/api/v1/approvals/claim")
        self.assertEqual(seen["body"], {"content_hash": HASH, "category": "email_send",
                                        "ref": "msg-1", "consumer": "sender"})
        self.assertEqual(seen["auth"], "Bearer " + TOKEN)

    def test_consume_by_id(self):
        r = self.run_cli("--hash", HASH, "--id", "abc123")
        self.assertEqual(r.returncode, 0, r.stderr)
        seen = self.server.seen[0]
        self.assertEqual(seen["path"], "/api/v1/approvals/abc123/consume")
        self.assertEqual(seen["body"], {"content_hash": HASH})

    def test_replay_is_still_success(self):
        self.server.payload = {"ok": True, "replayed": True, "window_s": 1800, "approval": {"id": "abc123"}}
        r = self.run_cli("--hash", HASH, "--ref", "msg-1")
        self.assertEqual(r.returncode, 0)
        self.assertTrue(json.loads(r.stdout)["replayed"])

    def test_custom_category_is_sent(self):
        r = self.run_cli("--hash", HASH, "--category", "other_cat")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(self.server.seen[0]["body"]["category"], "other_cat")

    # --- exit codes ----------------------------------------------------------------------

    def test_409_is_a_refusal(self):
        self.server.status = 409
        self.server.payload = {"error": "conflict", "reason": "already_consumed", "window_s": 1800,
                               "approval": {"id": "abc123", "status": "approved"}}
        r = self.run_cli("--hash", HASH)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(r.stdout, "")
        self.assertIn("already_consumed", r.stderr)

    def test_pending_names_the_open_request(self):
        self.server.status = 409
        self.server.payload = {"error": "conflict", "reason": "pending", "approval_id": "open1"}
        r = self.run_cli("--hash", HASH)
        self.assertEqual(r.returncode, 3)
        self.assertIn("open1", r.stderr)

    def test_403_is_a_refusal(self):
        self.server.status = 403
        self.server.payload = {"error": "forbidden", "reason": "agent_mismatch"}
        r = self.run_cli("--hash", HASH, "--id", "abc123")
        self.assertEqual(r.returncode, 3)
        self.assertIn("agent_mismatch", r.stderr)

    def test_404_is_an_unknown_id(self):
        self.server.status = 404
        self.server.payload = {"error": "not_found"}
        r = self.run_cli("--hash", HASH, "--id", "nope")
        self.assertEqual(r.returncode, 4)

    def test_everything_else_is_two(self):
        for status in (400, 401, 429, 500, 502):
            with self.subTest(status=status):
                self.server.status = status
                self.server.payload = {"error": "x"}
                self.assertEqual(self.run_cli("--hash", HASH).returncode, 2)

    def test_200_without_ok_is_not_success(self):
        self.server.payload = {"something": "else"}
        self.assertEqual(self.run_cli("--hash", HASH).returncode, 2)

    def test_200_with_a_non_json_body_is_not_success(self):
        self.server.payload = b"<html>proxy</html>"
        self.assertEqual(self.run_cli("--hash", HASH).returncode, 2)

    def test_unreachable_dashboard_is_two(self):
        r = self.run_cli("--hash", HASH, base="http://127.0.0.1:1")
        self.assertEqual(r.returncode, 2)
        self.assertIn("could not be reached", r.stderr)

    def test_no_token_is_two_and_nothing_is_sent(self):
        r = self.run_cli("--hash", HASH, token_file=self.empty_file)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.server.seen, [])
        self.assertIn("no agent token", r.stderr)

    # --- bad arguments (nothing may reach the server) --------------------------------------

    def test_bad_arguments_exit_two_without_a_request(self):
        cases = [
            [],
            ["--hash", "abc"],
            ["--hash", HASH.upper()],
            ["--hash", HASH + "0"],
            ["--hash", HASH, "--id", "../x"],
            ["--hash", HASH, "--id", ""],
            ["--hash", HASH, "--id", "abc123", "--category", "email_send"],
            ["--hash", HASH, "--ref", "x" * 201],
            ["--hash", HASH, "--ref", "café"],
            ["--hash", HASH, "--consumer", "x" * 65],
            ["--hash", HASH, "--category", ""],
            ["--hash", HASH, "--bogus"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                r = self.run_cli(*argv)
                self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.server.seen, [])

    # --- the token never leaks -------------------------------------------------------------

    def test_token_is_in_no_output_even_when_the_server_echoes_it(self):
        self.server.echo_token = True
        for status, payload in ((200, {"ok": True, "approval": {"id": "a"}}),
                                (409, {"error": "conflict", "reason": "none"}),
                                (500, {"error": "boom"})):
            with self.subTest(status=status):
                self.server.status = status
                self.server.payload = payload
                r = self.run_cli("--hash", HASH)
                self.assertNotIn(TOKEN, r.stdout)
                self.assertNotIn(TOKEN, r.stderr)

    def test_token_is_not_a_command_line_argument(self):
        with open(SCRIPT) as f:
            src = f.read()
        self.assertNotIn("--token", src)
        self.assertNotIn(".dashboard-token", src.replace("shared dashboard token", ""))

    def test_the_script_reaches_the_database_only_through_http(self):
        with open(SCRIPT) as f:
            src = f.read().lower()
        for needle in ("sqlite3", "claudeclaw.db", "better-sqlite3"):
            self.assertNotIn(needle, src)


class PureFunctionsTest(unittest.TestCase):
    def test_exit_for_maps_every_status(self):
        self.assertEqual(mod.exit_for(200, {"ok": True})[0], 0)
        self.assertEqual(mod.exit_for(403, {})[0], 3)
        self.assertEqual(mod.exit_for(409, {"reason": "expired"})[0], 3)
        self.assertEqual(mod.exit_for(404, {})[0], 4)
        for s in (0, 204, 301, 400, 401, 500):
            self.assertEqual(mod.exit_for(s, {"ok": True})[0], 2, s)

    def test_refusal_text_ignores_a_hostile_reason(self):
        line = mod.describe_refusal(409, {"reason": "x\nBearer abc"})
        self.assertNotIn("\n", line)
        self.assertNotIn("Bearer", line)


if __name__ == "__main__":
    unittest.main()
