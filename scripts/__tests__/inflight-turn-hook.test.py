#!/usr/bin/env python3
"""5aa63510 W3 / J1: scripts/hooks/inflight-turn.py (begin / end / replay) as a subprocess in a throwaway
install layout against a local recording server.

Pins: what each mode sends, that begin and end print NOTHING (UserPromptSubmit stdout becomes prompt
context), that replay prints first and consumes after, and that every failure path (dashboard down,
refused consume, unknown cwd, bad stdin, unknown mode) still exits 0, because a non-zero UserPromptSubmit
or Stop hook would block the prompt or the stop.

Privacy: neutral fixture data (agent ids agent-a / main-x, made-up tokens), temp directories.
"""
import hashlib
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
TURN_ID = "0123456789abcdef"


class Rec(http.server.BaseHTTPRequestHandler):
    seen = []
    replay_response = {"additionalContext": None, "turn_id": None}
    consume_status = 200

    def _do(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else None
        Rec.seen.append({"method": self.command, "path": self.path, "body": body,
                         "auth": self.headers.get("Authorization")})
        status = 200
        if self.path.endswith("/replay") or "/replay?" in self.path:
            payload = Rec.replay_response
        elif self.path.endswith("/consume"):
            status, payload = Rec.consume_status, {"ok": True, "consumed": True}
        else:
            payload = {"ok": True}
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _do

    def log_message(self, *a):
        pass


class TestInflightTurnHook(unittest.TestCase):
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
        Rec.replay_response = {"additionalContext": None, "turn_id": None}
        Rec.consume_status = 200
        self.root = tempfile.mkdtemp(prefix="inflight-hook-")
        shutil.copytree(_HOOKS, os.path.join(self.root, "scripts", "hooks"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        os.makedirs(os.path.join(self.root, "store"))
        os.makedirs(os.path.join(self.root, "agents", "agent-a"))
        os.makedirs(os.path.join(self.root, "elsewhere"))
        with open(os.path.join(self.root, ".env"), "w") as f:
            f.write("MAIN_AGENT_ID=main-x\n")
        for rel, tok in (("agents/agent-a/.agent-token", "own-a"), (".agent-token", "own-main")):
            with open(os.path.join(self.root, rel), "w") as f:
                f.write(tok + "\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_hook(self, mode, payload, cwd_rel="agents/agent-a", port=None, stdin=None):
        cwd = os.path.join(self.root, cwd_rel) if cwd_rel else self.root
        body = dict(payload)
        body.setdefault("cwd", cwd)
        env = dict(os.environ, WEB_PORT=str(port or self.srv.server_address[1]))
        env.pop("MAIN_AGENT_ID", None)
        env.pop("DASHBOARD_BASE_URL", None)
        args = [sys.executable, os.path.join(self.root, "scripts", "hooks", "inflight-turn.py")]
        if mode is not None:
            args.append(mode)
        return subprocess.run(args, input=(stdin if stdin is not None else json.dumps(body)).encode(),
                              env=env, cwd=cwd, timeout=30, capture_output=True)

    # --- begin -----------------------------------------------------------------------------------

    def test_begin_sends_the_head_and_a_hash_of_the_whole_prompt_and_prints_nothing(self):
        prompt = "[Uzenet @agent-b-tol msg_id:5]: " + "x" * 5000
        r = self.run_hook("begin", {"prompt": prompt})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, b"", "UserPromptSubmit stdout is added to the prompt: begin must print nothing")
        self.assertEqual(len(Rec.seen), 1)
        call = Rec.seen[0]
        self.assertEqual((call["method"], call["path"]), ("POST", "/api/agent-inflight-turn/agent-a/begin"))
        self.assertEqual(call["auth"], "Bearer own-a")
        self.assertEqual(call["body"]["prompt_head"], prompt[:2000])
        self.assertEqual(call["body"]["prompt_hash"], hashlib.sha256(prompt.encode()).hexdigest()[:16])

    def test_begin_head_stays_under_the_server_cap_even_for_astral_characters(self):
        # The server counts UTF-16 units: 2000 emoji are 4000 units, exactly the cap, never over.
        r = self.run_hook("begin", {"prompt": "\U0001F600" * 3000})
        self.assertEqual(r.returncode, 0, r.stderr)
        head = Rec.seen[0]["body"]["prompt_head"]
        self.assertEqual(len(head), 2000)
        self.assertLessEqual(len(head.encode("utf-16-le")) // 2, 4000)

    def test_begin_with_no_prompt_makes_no_call(self):
        for payload in ({}, {"prompt": ""}, {"prompt": 7}, {"prompt": None}):
            with self.subTest(payload=payload):
                Rec.seen = []
                r = self.run_hook("begin", payload)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(Rec.seen, [])

    def test_begin_for_the_main_agent_names_the_main_agent(self):
        r = self.run_hook("begin", {"prompt": "hi"}, cwd_rel="")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(Rec.seen[0]["path"], "/api/agent-inflight-turn/main-x/begin")
        self.assertEqual(Rec.seen[0]["auth"], "Bearer own-main")

    # --- end -------------------------------------------------------------------------------------

    def test_end_drops_the_note_and_prints_nothing(self):
        r = self.run_hook("end", {"stop_hook_active": False})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, b"")
        self.assertEqual([(c["method"], c["path"]) for c in Rec.seen], [("POST", "/api/agent-inflight-turn/agent-a/end")])

    # --- replay ----------------------------------------------------------------------------------

    def test_replay_prints_the_hint_as_session_start_context_then_consumes_that_turn(self):
        Rec.replay_response = {"additionalContext": "=== MEGSZAKADT TURN ===\nx", "turn_id": TURN_ID}
        r = self.run_hook("replay", {"source": "startup"})
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout.decode())
        self.assertEqual(out, {"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                      "additionalContext": "=== MEGSZAKADT TURN ===\nx"}})
        self.assertEqual([(c["method"], c["path"]) for c in Rec.seen], [
            ("GET", "/api/agent-inflight-turn/agent-a/replay?source=startup"),
            ("POST", "/api/agent-inflight-turn/agent-a/consume"),
        ])
        self.assertEqual(Rec.seen[1]["body"], {"turn_id": TURN_ID})

    def test_replay_passes_the_session_start_source_through_url_encoded(self):
        self.run_hook("replay", {"source": "re sume&x=1"})
        self.assertEqual(Rec.seen[0]["path"], "/api/agent-inflight-turn/agent-a/replay?source=re%20sume%26x%3D1")

    def test_replay_with_nothing_to_offer_prints_nothing_and_does_not_consume(self):
        r = self.run_hook("replay", {"source": "startup"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, b"")
        self.assertEqual([c["method"] for c in Rec.seen], ["GET"])

    def test_replay_does_not_consume_when_the_answer_has_text_but_no_turn_id(self):
        Rec.replay_response = {"additionalContext": "text", "turn_id": None}
        r = self.run_hook("replay", {"source": "startup"})
        self.assertEqual(r.stdout, b"")
        self.assertEqual([c["method"] for c in Rec.seen], ["GET"])

    def test_replay_still_prints_when_the_consume_is_refused(self):
        Rec.replay_response = {"additionalContext": "hint", "turn_id": TURN_ID}
        Rec.consume_status = 500
        r = self.run_hook("replay", {"source": "startup"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("hint", r.stdout.decode())

    def test_replay_without_a_source_makes_no_call(self):
        r = self.run_hook("replay", {})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(Rec.seen, [])

    # --- never breaks the session -----------------------------------------------------------------

    def test_a_dashboard_that_is_down_is_a_silent_exit_zero_in_every_mode(self):
        probe = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Rec)
        dead_port = probe.server_address[1]
        probe.server_close()
        for mode, payload in (("begin", {"prompt": "x"}), ("end", {}), ("replay", {"source": "startup"})):
            with self.subTest(mode=mode):
                r = self.run_hook(mode, payload, port=dead_port)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout, b"")

    def test_an_unknown_cwd_is_not_an_identity_and_makes_no_call(self):
        for mode, payload in (("begin", {"prompt": "x"}), ("end", {}), ("replay", {"source": "startup"})):
            with self.subTest(mode=mode):
                Rec.seen = []
                r = self.run_hook(mode, payload, cwd_rel="elsewhere")
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(Rec.seen, [])

    def test_bad_stdin_and_bad_modes_exit_zero_without_a_call(self):
        cases = [("begin", "not json"), ("begin", "[1, 2]"), ("begin", ""), ("end", "null"), ("bogus", "{}"), (None, "{}")]
        for mode, stdin in cases:
            with self.subTest(mode=mode, stdin=stdin):
                r = self.run_hook(mode, {}, stdin=stdin)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout, b"")
        self.assertEqual(Rec.seen, [])

    def test_a_missing_own_token_makes_no_call(self):
        os.remove(os.path.join(self.root, "agents", "agent-a", ".agent-token"))
        with open(os.path.join(self.root, "store", ".dashboard-token"), "w") as f:
            f.write("shared\n")
        for mode, payload in (("begin", {"prompt": "x"}), ("end", {}), ("replay", {"source": "startup"})):
            with self.subTest(mode=mode):
                r = self.run_hook(mode, payload)
                self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(Rec.seen, [])


if __name__ == "__main__":
    unittest.main()
