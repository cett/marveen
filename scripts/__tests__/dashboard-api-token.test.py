#!/usr/bin/env python3
"""dashboard_api.request carries the calling agent's own token, and the shared one only as a
visible fallback (X-Agent-Id names the caller). A local HTTP server records the headers.

Privacy: neutral fixture data (agent id zz-test, made-up tokens), temp directories.
"""
import http.server
import importlib.util
import os
import shutil
import sys
import tempfile
import threading
import unittest

_HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")
sys.path.insert(0, _HOOKS)
_spec = importlib.util.spec_from_file_location("dashboard_api", os.path.join(_HOOKS, "dashboard_api.py"))
api = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(api)  # type: ignore[union-attr]


class Recorder(http.server.BaseHTTPRequestHandler):
    seen = []
    status = 200

    def do_GET(self):
        Recorder.seen.append({"auth": self.headers.get("Authorization"), "agent": self.headers.get("X-Agent-Id")})
        self.send_response(Recorder.status)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    do_POST = do_GET

    def log_message(self, *a):
        pass


class TestDashboardApiToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), Recorder)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Recorder.seen = []
        Recorder.status = 200
        self.store = tempfile.mkdtemp(prefix="t3-store-")
        self._env = {k: os.environ.get(k) for k in ("LEDGER_DB_PATH", "DASHBOARD_BASE_URL", "MARVEEN_AGENT_TOKEN_FILE")}
        os.environ["LEDGER_DB_PATH"] = os.path.join(self.store, "x.db")
        os.environ["DASHBOARD_BASE_URL"] = "http://127.0.0.1:%d" % self.srv.server_address[1]
        os.environ.pop("MARVEEN_AGENT_TOKEN_FILE", None)

    def tearDown(self):
        shutil.rmtree(self.store, ignore_errors=True)
        for k, v in self._env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def write(self, name, text):
        p = os.path.join(self.store, name)
        with open(p, "w") as f:
            f.write(text)
        return p

    def test_own_token_is_sent(self):
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = self.write("own", "own-zz")
        self.write(".dashboard-token", "shared")
        api.request("GET", "/api/x", agent_id="zz-test")
        self.assertEqual(Recorder.seen, [{"auth": "Bearer own-zz", "agent": "zz-test"}])

    def test_missing_own_token_falls_back_and_names_the_caller(self):
        self.write(".dashboard-token", "shared")
        api.request("GET", "/api/x", agent_id="zz-test")
        self.assertEqual(Recorder.seen, [{"auth": "Bearer shared", "agent": "zz-test"}])

    def test_no_token_anywhere_still_sends_the_request_without_authorization(self):
        api.request("GET", "/api/x", agent_id="zz-test")
        self.assertEqual(Recorder.seen[0]["auth"], None)

    def test_refused_own_token_raises_and_is_not_retried_on_the_shared_one(self):
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = self.write("own", "own-zz")
        self.write(".dashboard-token", "shared")
        Recorder.status = 401
        with self.assertRaises(Exception):
            api.request("GET", "/api/x", agent_id="zz-test")
        self.assertEqual(len(Recorder.seen), 1)
        self.assertEqual(Recorder.seen[0]["auth"], "Bearer own-zz")

    def test_kind_shared_uses_the_shared_token_on_purpose(self):
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = self.write("own", "own-zz")
        self.write(".dashboard-token", "shared")
        api.request("GET", "/api/x", agent_id="zz-test", kind="shared")
        self.assertEqual(Recorder.seen[0]["auth"], "Bearer shared")


if __name__ == "__main__":
    unittest.main()
