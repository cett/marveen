#!/usr/bin/env python3
"""Tests for scripts/intel_db.py, the thin client of the dashboard's /api/intel routes.

A stub HTTP server on an ephemeral port stands in for the dashboard and records
every request, so the CLI surface (arguments in, text out, exit codes) and the
request shape are pinned without a running dashboard. The storage behaviour
itself (ids, upsert vs duplicate, lifecycle filtering) is covered where it
lives, in src/__tests__/intel-store-route.test.ts.

Run: python3 -B scripts/__tests__/intel-db.test.py
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

sys.dont_write_bytecode = True

_SCRIPT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "intel_db.py")
_spec = importlib.util.spec_from_file_location("intel_db", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]

DUMP = {
    "registry": [{"id": "market-20261008-044b3fa0", "title": "T"}],
    "watchlist": [{"id": "w1"}, {"id": "w2"}],
    "active_focus": [],
    "db_path": "/somewhere/intel.db",
}


class StubDashboard:
    """Records requests; `routes` maps (method, path-without-query) to (status, body)."""

    def __init__(self):
        self.requests = []
        self.routes = {}
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                path = self.path.split("?")[0]
                stub.requests.append({
                    "method": self.command,
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "body": json.loads(raw) if raw else None,
                })
                status, body = stub.routes.get((self.command, path), (404, {"error": "not_found"}))
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _serve

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        token = os.path.join(self.tmp.name, ".dashboard-token")
        with open(token, "w", encoding="utf-8") as f:
            f.write("test-token\n")
        self.dash = StubDashboard()
        self.addCleanup(self.dash.close)
        for p in (
            patch.object(mod, "TOKEN_FILE", mod.Path(token)),
            patch.dict(os.environ, {"MARVEEN_DASHBOARD_BASE": self.dash.base}),
        ):
            p.start()
            self.addCleanup(p.stop)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["intel_db.py", *argv]):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = mod._cli()
                except SystemExit as exc:  # argparse errors
                    code = exc.code
        return code, out.getvalue(), err.getvalue()

    # --- plain run / init ----------------------------------------------------

    def test_plain_run_prints_health_counters_and_ok(self):
        self.dash.routes[("GET", "/api/intel/dump")] = (200, DUMP)
        code, out, _ = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("Active registry (14d): 1 rows", out)
        self.assertIn("Watchlist: 2 rows", out)
        self.assertIn("Active focus: 0 rows", out)
        self.assertTrue(out.rstrip().endswith("OK"))
        self.assertEqual(self.dash.requests[0]["path"], "/api/intel/dump?days=14")

    def test_requests_carry_the_bearer_token(self):
        self.dash.routes[("GET", "/api/intel/dump")] = (200, DUMP)
        self.run_cli()
        self.assertEqual(self.dash.requests[0]["auth"], "Bearer test-token")

    def test_init_is_a_post_and_reports_the_location(self):
        self.dash.routes[("POST", "/api/intel/init")] = (200, {"ok": True, "db_path": "/somewhere/intel.db"})
        code, out, _ = self.run_cli("init")
        self.assertEqual(code, 0)
        self.assertIn("/somewhere/intel.db", out)
        self.assertEqual(self.dash.requests[0]["method"], "POST")

    # --- add-fact ------------------------------------------------------------

    def test_add_fact_sends_the_arguments_and_prints_the_id(self):
        self.dash.routes[("POST", "/api/intel/facts")] = (200, {"ok": True, "id": "market-20261008-044b3fa0", "duplicate": False})
        code, out, _ = self.run_cli(
            "add-fact", "--title", "T1", "--domain", "market", "--source", "src", "--tier", "2",
            "--content", "price moved 5%", "--status", "evolving", "--priority", "0.8",
        )
        self.assertEqual((code, out.strip()), (0, "market-20261008-044b3fa0"))
        body = self.dash.requests[0]["body"]
        self.assertEqual(body, {
            "title": "T1", "domain": "market", "source": "src", "source_tier": 2,
            "content": "price moved 5%", "status": "evolving", "priority_score": 0.8,
        })
        self.assertNotIn("id", body)

    def test_add_fact_passes_an_explicit_id_and_clamps_the_priority(self):
        self.dash.routes[("POST", "/api/intel/facts")] = (200, {"ok": True, "id": "mine", "duplicate": False})
        self.run_cli(
            "add-fact", "--id", "mine", "--title", "T", "--domain", "d", "--source", "s", "--tier", "1",
            "--content", "c", "--priority", "7",
        )
        body = self.dash.requests[0]["body"]
        self.assertEqual((body["id"], body["priority_score"]), ("mine", 1.0))

    def test_duplicate_fact_is_reported_and_exits_zero(self):
        self.dash.routes[("POST", "/api/intel/facts")] = (200, {"ok": True, "id": "other-id", "duplicate": True})
        code, out, _ = self.run_cli(
            "add-fact", "--id", "other-id", "--title", "T", "--domain", "d", "--source", "s", "--tier", "1", "--content", "c",
        )
        self.assertEqual(code, 0)
        self.assertIn("DUPLICATE", out)
        self.assertIn("other-id", out)

    def test_bad_tier_is_an_argument_error_without_a_request(self):
        code, _, _ = self.run_cli(
            "add-fact", "--title", "T", "--domain", "d", "--source", "s", "--tier", "4", "--content", "c",
        )
        self.assertEqual(code, 2)
        self.assertEqual(self.dash.requests, [])

    # --- the other writers -----------------------------------------------------

    def test_add_watch_focus_and_decision(self):
        self.dash.routes[("POST", "/api/intel/watchlist")] = (200, {"ok": True, "id": "wid"})
        self.dash.routes[("POST", "/api/intel/focus")] = (200, {"ok": True, "id": "fid"})
        self.dash.routes[("POST", "/api/intel/decisions")] = (200, {"ok": True, "id": "did"})
        self.assertEqual(self.run_cli("add-watch", "--title", "t", "--domain", "d", "--direction", "up")[1].strip(), "wid")
        self.assertEqual(self.run_cli("add-focus", "--topic", "Q3", "--mode", "deep", "--days", "30")[1].strip(), "fid")
        self.assertEqual(self.run_cli("log-decision", "--recommendation", "hold", "--reasoning", "band intact")[1].strip(), "did")
        watch, focus, decision = (r["body"] for r in self.dash.requests)
        self.assertEqual(watch, {"title": "t", "domain": "d", "direction": "up", "notes": ""})
        self.assertEqual(focus, {"topic": "Q3", "mode": "deep", "notes": "", "days": 30})
        self.assertEqual(decision["recommendation"], "hold")
        self.assertEqual(decision["what_would_falsify"], "")

    def test_focus_without_days_sends_no_expiry(self):
        self.dash.routes[("POST", "/api/intel/focus")] = (200, {"ok": True, "id": "fid"})
        self.run_cli("add-focus", "--topic", "open ended")
        self.assertNotIn("days", self.dash.requests[0]["body"])

    # --- dump ------------------------------------------------------------------

    def test_dump_and_the_flag_alias_print_the_three_lists_as_json(self):
        self.dash.routes[("GET", "/api/intel/dump")] = (200, DUMP)
        for argv in (("dump",), ("--dump",)):
            code, out, _ = self.run_cli(*argv)
            self.assertEqual(code, 0)
            data = json.loads(out)
            self.assertEqual(sorted(data), ["active_focus", "registry", "watchlist"])
            self.assertEqual(len(data["watchlist"]), 2)

    def test_dump_days_goes_to_the_query(self):
        self.dash.routes[("GET", "/api/intel/dump")] = (200, DUMP)
        self.run_cli("dump", "--days", "3")
        self.assertEqual(self.dash.requests[0]["path"], "/api/intel/dump?days=3")

    # --- failures --------------------------------------------------------------

    def test_dashboard_refusal_exits_one_with_the_hint(self):
        self.dash.routes[("POST", "/api/intel/watchlist")] = (400, {"error": "invalid_value", "hint": "direction is required"})
        code, out, err = self.run_cli("add-watch", "--title", "t", "--domain", "d", "--direction", "up")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("400", err)
        self.assertIn("direction is required", err)

    def test_unreachable_dashboard_exits_one(self):
        self.dash.close()
        code, _, err = self.run_cli("dump")
        self.assertEqual(code, 1)
        self.assertIn("unreachable", err)
        # tearDown closes the server a second time; make that a no-op
        self.dash.server.shutdown = lambda: None  # type: ignore[method-assign]
        self.dash.server.server_close = lambda: None  # type: ignore[method-assign]

    def test_missing_token_exits_one(self):
        with patch.object(mod, "TOKEN_FILE", mod.Path(self.tmp.name) / "absent"):
            code, _, err = self.run_cli("dump")
        self.assertEqual(code, 1)
        self.assertIn("token", err)
        self.assertEqual(self.dash.requests, [])


class PythonApiTest(unittest.TestCase):
    def test_upsert_raises_on_a_duplicate_and_returns_the_id_otherwise(self):
        with patch.object(mod, "_request", return_value={"ok": True, "id": "a", "duplicate": False}) as req:
            self.assertEqual(mod.upsert_registry_fact(None, "t", "d", "s", 2, "c"), "a")
            self.assertNotIn("id", req.call_args[0][2])
        with patch.object(mod, "_request", return_value={"ok": True, "id": "b", "duplicate": True}):
            with self.assertRaises(mod.DuplicateFactError) as ctx:
                mod.upsert_registry_fact("b", "t", "d", "s", 2, "c")
            self.assertEqual(ctx.exception.fact_id, "b")

    def test_the_readers_slice_the_dump(self):
        with patch.object(mod, "_request", return_value=dict(DUMP)):
            self.assertEqual(len(mod.get_active_registry()), 1)
            self.assertEqual(len(mod.get_watchlist()), 2)
            self.assertEqual(mod.get_active_focus(), [])
            self.assertNotIn("db_path", mod.dump_active())

    def test_base_url_prefers_the_override_then_the_port(self):
        with patch.dict(os.environ, {"MARVEEN_DASHBOARD_BASE": "http://example.test:1/"}):
            self.assertEqual(mod._base_url(), "http://example.test:1")
        with patch.dict(os.environ, {"WEB_PORT": "4567"}):
            os.environ.pop("MARVEEN_DASHBOARD_BASE", None)
            self.assertEqual(mod._base_url(), "http://localhost:4567")


if __name__ == "__main__":
    unittest.main()
