#!/usr/bin/env python3
"""Phase T3, wave 1: the logging / replay / directive hooks sign their dashboard calls with the
calling agent's own token, fall back to the shared one only when the own file is MISSING (and then
name themselves in X-Agent-Id), and stay silent without any token. Each hook runs as a subprocess
in a throwaway install layout against a local recording server.

Privacy: neutral fixture data (agent ids agent-a / main-x, made-up tokens), temp directories.
"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

_HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")


class Rec(http.server.BaseHTTPRequestHandler):
    seen = []

    def _do(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n:
            self.rfile.read(n)
        Rec.seen.append({"path": self.path.split("?")[0], "auth": self.headers.get("Authorization"),
                         "agent": self.headers.get("X-Agent-Id")})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"text":"","additionalContext":"","transcript":"","directive":""}')

    do_GET = do_POST = _do

    def log_message(self, *a):
        pass


HOOKS = {
    # name: (script, payload builder, expected path, runs for)
    "tool-log": ("tool-log-capture.py",
                 lambda cwd: {"session_id": "s", "tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": cwd},
                 "/api/tool-log", "agent-a"),
    "voice": ("voice-reply-directive.py",
              lambda cwd: {"prompt": '<channel chat_id="42">hi</channel>', "cwd": cwd},
              "/api/voice/directive", "agent-a"),
    "taskstate": ("taskstate-replay.py",
                  lambda cwd: {"source": "compact", "cwd": cwd},
                  "/api/agent-taskstate/agent-a/replay", "agent-a"),
    "inbox-drain": ("inbox-drain.py",
                    lambda cwd: {"cwd": cwd},
                    "/api/agents/main-x/drain-inbox", "main-x"),
    "skill-usage": ("skill-usage-capture.py",
                    lambda cwd: {"tool_name": "Skill", "tool_input": {"skill": "x"}, "session_id": "s", "cwd": cwd},
                    "/api/skill-usage", "agent-a"),
    "artifact-sync": ("artifact-store-sync.py",
                      lambda cwd: {"tool_name": "Artifact", "cwd": cwd,
                                   "tool_input": {"action": "publish", "title": "t"},
                                   "tool_response": {"url": "https://claude.ai/public/artifacts/abc"}},
                      "/api/artifacts", "agent-a"),
}


class TestHooksAgentToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Rec)
        cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        Rec.seen = []
        self.root = tempfile.mkdtemp(prefix="t3-hooks-")
        shutil.copytree(_HOOKS, os.path.join(self.root, "scripts", "hooks"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        os.makedirs(os.path.join(self.root, "store"))
        os.makedirs(os.path.join(self.root, "agents", "agent-a"))
        with open(os.path.join(self.root, ".env"), "w") as f:
            f.write("MAIN_AGENT_ID=main-x\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def put(self, rel, text):
        with open(os.path.join(self.root, rel), "w") as f:
            f.write(text)

    def run_hook(self, key):
        script, payload, _path, who = HOOKS[key]
        cwd = self.root if who == "main-x" else os.path.join(self.root, "agents", who)
        env = dict(os.environ, WEB_PORT=str(self.srv.server_address[1]))
        env.pop("MAIN_AGENT_ID", None)
        env.pop("MARVEEN_AGENT_TOKEN_FILE", None)
        return subprocess.run(
            [sys.executable, os.path.join(self.root, "scripts", "hooks", script)],
            input=json.dumps(payload(cwd)).encode(), env=env, cwd=cwd, timeout=30, capture_output=True)

    def own_token_file(self, who):
        return ".agent-token" if who == "main-x" else "agents/%s/.agent-token" % who

    def test_every_hook_uses_the_own_token_when_present(self):
        for key, (_s, _p, path, who) in HOOKS.items():
            with self.subTest(hook=key):
                Rec.seen = []
                self.put("store/.dashboard-token", "shared\n")
                self.put(self.own_token_file(who), "own-%s\n" % who)
                r = self.run_hook(key)
                self.assertEqual(r.returncode, 0, r.stderr)
                calls = [c for c in Rec.seen if c["path"] == path]
                self.assertTrue(calls, "no call to %s; saw %r" % (path, Rec.seen))
                self.assertEqual({c["auth"] for c in calls}, {"Bearer own-%s" % who})

    def test_every_hook_falls_back_to_the_shared_token_and_names_itself_when_the_own_file_is_missing(self):
        for key, (_s, _p, path, who) in HOOKS.items():
            with self.subTest(hook=key):
                Rec.seen = []
                self.put("store/.dashboard-token", "shared\n")
                for rel in (self.own_token_file(who),):
                    try:
                        os.remove(os.path.join(self.root, rel))
                    except FileNotFoundError:
                        pass
                self.assertEqual(self.run_hook(key).returncode, 0)
                calls = [c for c in Rec.seen if c["path"] == path]
                self.assertTrue(calls)
                self.assertEqual({(c["auth"], c["agent"]) for c in calls}, {("Bearer shared", who)})

    def test_every_hook_is_silent_and_exits_zero_without_any_token(self):
        for key in HOOKS:
            with self.subTest(hook=key):
                Rec.seen = []
                r = self.run_hook(key)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(Rec.seen, [])

    def test_a_refused_own_token_is_not_retried_on_the_shared_one(self):
        # The recording server answers every token with 200, so check the structural property
        # instead: with an own token present the shared token never leaves the machine.
        for key, (_s, _p, _path, who) in HOOKS.items():
            with self.subTest(hook=key):
                Rec.seen = []
                self.put("store/.dashboard-token", "shared\n")
                self.put(self.own_token_file(who), "own\n")
                self.run_hook(key)
                self.assertNotIn("Bearer shared", {c["auth"] for c in Rec.seen})


class TestAutoSkillifyNotify(unittest.TestCase):
    """auto-skillify only talks to the dashboard in _notify_main_agent (a message FROM the agent)."""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        spec = importlib.util.spec_from_file_location("auto_skillify", os.path.join(_HOOKS, "auto-skillify.py"))
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Rec)
        cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        Rec.seen = []
        self.store = tempfile.mkdtemp(prefix="t3-skillify-")
        self._old = (self.mod.DASHBOARD_URL, self.mod.DASHBOARD_STORE_DIR, os.environ.get("MARVEEN_AGENT_TOKEN_FILE"))
        self.mod.DASHBOARD_URL = "http://127.0.0.1:%d" % self.srv.server_address[1]
        self.mod.DASHBOARD_STORE_DIR = self.store
        os.environ.pop("MARVEEN_AGENT_TOKEN_FILE", None)

    def tearDown(self):
        self.mod.DASHBOARD_URL, self.mod.DASHBOARD_STORE_DIR = self._old[0], self._old[1]
        if self._old[2] is not None:
            os.environ["MARVEEN_AGENT_TOKEN_FILE"] = self._old[2]
        shutil.rmtree(self.store, ignore_errors=True)

    def test_own_token_is_used(self):
        p = os.path.join(self.store, "own")
        with open(p, "w") as f:
            f.write("own-zz\n")
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = p
        self.mod._notify_main_agent("zz-agent", "/d", "r")
        self.assertEqual([c["auth"] for c in Rec.seen], ["Bearer own-zz"])

    def test_missing_own_token_falls_back_and_names_the_sender(self):
        with open(os.path.join(self.store, ".dashboard-token"), "w") as f:
            f.write("shared\n")
        self.mod._notify_main_agent("zz-agent", "/d", "r")
        self.assertEqual([(c["auth"], c["agent"]) for c in Rec.seen], [("Bearer shared", "zz-agent")])

    def test_no_token_sends_nothing(self):
        self.mod._notify_main_agent("zz-agent", "/d", "r")
        self.assertEqual(Rec.seen, [])


if __name__ == "__main__":
    unittest.main()
