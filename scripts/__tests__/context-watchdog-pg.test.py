#!/usr/bin/env python3
"""Tests for the PostgreSQL mode of scripts/hooks/context-watchdog.py (the READS that feed the threshold and the HANDOFF).

In PG mode the hook never reads the stale SQLite file for the threshold or the HANDOFF facts: it asks the dashboard
(POST /api/v1/hooks/watchdog-facts, want threshold|handoff) under a short budget, ONE attempt, no retry, no fallback. A
stub HTTP server plays the dashboard; the SQLite fixture deliberately CONTRADICTS the stub so a read from the wrong
place shows. The differential against the REAL TypeScript route is src/__tests__/hooks-tenant-python-differential.test.ts (the context-watchdog cells).

Each cell has a red a removed guard would give (the mutants are listed in the PR text and run by the QA gates):
  - the route adapter is not selected in PG mode        -> test_pg_mode_text_comes_from_the_route_not_the_stale_sqlite
  - a SQLite fallback after a route error               -> test_every_threshold_failure_injects_nothing_and_never_falls_back,
                                                           test_every_handoff_failure_injects_nothing_and_writes_no_audit_row
  - the dedup read moved to the route / dropped         -> test_the_dedup_still_reads_the_sqlite_row_the_same_hook_wrote
  - the shared deadline becomes per-call                -> test_the_two_calls_share_one_short_deadline
  - a retry after a 5xx                                 -> test_a_5xx_is_asked_once
Neutral fixtures only (agent-a, agent-b).
"""
import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOK = os.path.join(ROOT, "scripts", "hooks", "context-watchdog.py")
CWD = os.path.join(ROOT, "agents", "agent-a")
ROUTE = "/api/v1/hooks/watchdog-facts"
TOKEN = "test-token-agent-a"

# The SQLite fixture helpers of the SQLite-mode cells (same schema the hook reads).
_spec = importlib.util.spec_from_file_location("context_watchdog_sqlite_cells", os.path.join(HERE, "context-watchdog.test.py"))
sqlite_cells = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sqlite_cells)

STUB_FACTS = {
    "own": {"task_ref": "card-stub", "status": "active", "summary": "stub work item"},
    "recent": [{"agent_id": "agent-stub", "status": "active", "summary": "stub recent line"}],
    "cards": [{"number": 7, "title": "Stub card", "status": "in_progress"}],
    "last_outgoing": "stub next step",
}
# Past the 60% line of a 400000 threshold (250000 / 400000 = 62.5%) and far below it.
HIGH = 250000
LOW = 1000


class Dashboard:
    """A stub of the dashboard. `script(body)` -> (status, json-able or raw bytes, delay_seconds). Every request is logged."""

    def __init__(self, script):
        self.script = script
        self.log = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                body = json.loads(raw) if raw else None
                outer.log.append({"path": self.path, "body": body, "auth": self.headers.get("Authorization"),
                                  "agent": self.headers.get("X-Agent-Id")})
                status, obj, delay = outer.script(body)
                if delay:
                    time.sleep(delay)
                data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass  # the hook gave up and closed the connection

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def wants(self):
        return [c["body"].get("want") for c in self.log]


def closed_port_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return "http://127.0.0.1:%d" % port


def answering(threshold=None, facts=None, threshold_status=200, handoff_status=200, threshold_delay=0, handoff_delay=0,
              threshold_raw=None, handoff_raw=None):
    """A dashboard script: `want: threshold` -> {threshold_tokens}, `want: handoff` -> the facts (or a raw / failing answer)."""
    def script(body):
        want = (body or {}).get("want")
        if want == "threshold":
            if threshold_raw is not None:
                return threshold_status, threshold_raw, threshold_delay
            return threshold_status, {"threshold_tokens": threshold}, threshold_delay
        if want == "handoff":
            if handoff_raw is not None:
                return handoff_status, handoff_raw, handoff_delay
            return handoff_status, STUB_FACTS if facts is None else facts, handoff_delay
        return 400, {"error": "invalid_value"}, 0
    return script


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "test.db")
        conn = sqlite_cells._make_db(self.db_path)
        # A STALE SQLite state that contradicts the stub in every fact and in the threshold.
        conn.execute("INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id, updated_at) "
                     "VALUES ('agent-a', 'context_restart_gate', ?, 'default', 0)", (json.dumps({"thresholdTokens": 123456}),))
        conn.execute("INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) "
                     "VALUES ('b1', 'agent-a', 'card-stale', 'done', 'stale sqlite work', 100)")
        conn.execute("INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) "
                     "VALUES ('b2', 'agent-b', NULL, 'active', 'stale peer line', 200)")
        conn.execute("INSERT INTO kanban_cards (id, title, status, assignee, updated_at, archived_at) "
                     "VALUES ('k1', 'Stale card', 'in_progress', 'agent-a', 100, NULL)")
        conn.execute("INSERT INTO agent_messages (from_agent, to_agent, content, created_at) "
                     "VALUES ('agent-a', 'agent-b', 'stale next step', 100)")
        conn.commit()
        conn.close()
        self.transcript = os.path.join(self.tmp.name, "transcript.jsonl")
        self.token_file = os.path.join(self.tmp.name, "token")
        with open(self.token_file, "w") as f:
            f.write(TOKEN)
        self.empty = os.path.join(self.tmp.name, "empty")
        os.mkdir(self.empty)
        self.dash = None

    def tearDown(self):
        if self.dash:
            self.dash.close()
        self.tmp.cleanup()

    def env(self, url=None, pg=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith("MARVEEN_PG") and k != "DASHBOARD_BASE_URL"}
        env.update(SECRET_MOUNT_DIR=self.empty, CLAUDECLAW_ENV_DIR=self.empty, MARVEEN_AGENT_TOKEN_FILE=self.token_file,
                   LEDGER_DB_PATH=self.db_path)
        if pg:
            env["MARVEEN_PG_URL"] = "postgres://placeholder.invalid/db"
        if url:
            env["DASHBOARD_BASE_URL"] = url
        return env

    def serve(self, script):
        self.dash = Dashboard(script)
        return self.dash

    def run_hook(self, tokens=HIGH, url=None, pg=True, session="sess-1", **payload_extra):
        sqlite_cells._write_jsonl(self.transcript, [sqlite_cells._usage_event(input_tokens=tokens)])
        payload = {"session_id": session, "tool_name": "Bash", "cwd": CWD, "transcript_path": self.transcript}
        payload.update(payload_extra)
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True,
                           env=self.env(url=url if url is not None else (self.dash.url if self.dash else None), pg=pg), timeout=30)
        p.wall = time.monotonic() - t0
        return p

    def handoff_rows(self):
        conn = sqlite3.connect(self.db_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM hook_audit_log WHERE verdict = 'handoff'").fetchone()[0]
        finally:
            conn.close()

    def text_of(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.strip(), "the hook injected nothing")
        return json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]


class TestPgModeReads(Base):
    def test_pg_mode_text_comes_from_the_route_not_the_stale_sqlite(self):
        d = self.serve(answering(threshold=400000))
        text = self.text_of(self.run_hook())
        for fact in ("stub work item", "[kanban card-stub]", "agent-stub [active]: stub recent line", "#7 [in_progress]: Stub card",
                     "stub next step"):
            self.assertIn(fact, text)
        for stale in ("stale sqlite work", "stale peer line", "Stale card", "stale next step", "card-stale"):
            self.assertNotIn(stale, text)
        self.assertEqual(d.wants(), ["threshold", "handoff"])

    def test_the_threshold_comes_from_the_route(self):
        self.serve(answering(threshold=200000))
        text = self.text_of(self.run_hook(tokens=HIGH))
        self.assertIn("250,000 / 200,000", text)  # not the 123456 the stale SQLite row holds

    def test_a_null_threshold_is_the_default_not_the_stale_sqlite_row(self):
        self.serve(answering(threshold=None))
        text = self.text_of(self.run_hook(tokens=HIGH))
        self.assertIn("250,000 / 400,000", text)

    def test_the_requests_carry_the_agents_own_token_and_only_the_want(self):
        d = self.serve(answering(threshold=400000))
        self.text_of(self.run_hook())
        self.assertEqual({c["path"] for c in d.log}, {ROUTE})
        self.assertTrue(all(c["auth"] == "Bearer " + TOKEN for c in d.log))
        self.assertEqual([c["body"] for c in d.log], [{"want": "threshold"}, {"want": "handoff"}])

    def test_below_the_line_only_the_threshold_is_asked(self):
        d = self.serve(answering(threshold=400000))
        p = self.run_hook(tokens=LOW)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(d.wants(), ["threshold"])

    def test_a_spawned_sub_agent_never_asks_for_the_handoff(self):
        d = self.serve(answering(threshold=400000))
        p = self.run_hook(agent_id="sub-uuid")
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(d.wants(), ["threshold"])
        self.assertEqual(self.handoff_rows(), 0)

    def test_without_pg_mode_the_dashboard_is_not_asked_and_sqlite_is_read(self):
        d = self.serve(answering(threshold=200000))
        text = self.text_of(self.run_hook(pg=False))
        self.assertEqual(d.log, [])
        self.assertIn("stale sqlite work", text)
        self.assertIn("250,000 / 123,456", text)

    def test_the_bookkeeping_still_goes_to_sqlite_in_pg_mode(self):
        # token_usage / spans / the audit row stay on SQLite until H2: the hook still writes them (and the next cell relies on it)
        self.serve(answering(threshold=400000))
        self.text_of(self.run_hook())
        conn = sqlite3.connect(self.db_path)
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM token_usage").fetchone()[0], 1)
        finally:
            conn.close()
        self.assertEqual(self.handoff_rows(), 1)


class TestDedupCoupling(Base):
    def test_the_dedup_still_reads_the_sqlite_row_the_same_hook_wrote(self):
        # Two consecutive qualifying calls, unchanged state: the first emits and writes the audit row (SQLite), the
        # second must emit NOTHING. If the dedup read moved to a PG hook_audit_log that holds no 'handoff' row, the
        # second call would see "no prior row" and emit again, on every tool call.
        d = self.serve(answering(threshold=400000))
        first = self.run_hook(tokens=HIGH)
        self.text_of(first)
        self.assertEqual(self.handoff_rows(), 1)
        second = self.run_hook(tokens=HIGH)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(second.stdout.strip(), "")
        self.assertEqual(self.handoff_rows(), 1)
        # the second call still asked the threshold and (rule 4) built the text once to compare it: at most one handoff call
        self.assertEqual(d.wants(), ["threshold", "handoff", "threshold", "handoff"])

    def test_a_changed_fact_emits_again_once_the_gap_has_passed(self):
        self.serve(answering(threshold=400000))
        self.text_of(self.run_hook(tokens=HIGH))
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE hook_audit_log SET ts = ts - 1000 WHERE verdict = 'handoff'")
        conn.commit()
        conn.close()
        changed = dict(STUB_FACTS, last_outgoing="a different next step")
        self.dash.close()
        self.serve(answering(threshold=400000, facts=changed))
        self.assertIn("a different next step", self.text_of(self.run_hook(tokens=HIGH)))
        self.assertEqual(self.handoff_rows(), 2)


class TestRouteFailures(Base):
    """A route that does not answer usably: injection absent, exit 0, no audit row, no SQLite read, inside the short budget."""

    def assertSilent(self, p, d, wants):
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(self.handoff_rows(), 0)
        self.assertEqual(d.wants() if d else [], wants)
        self.assertLess(p.wall, 4.0)  # interpreter start + the 1.5 s budget, far under the 10 s harness timeout

    def test_every_threshold_failure_injects_nothing_and_never_falls_back(self):
        cases = {
            "5xx": dict(threshold_status=503, threshold_raw={"error": "x"}),
            "403": dict(threshold_status=403, threshold_raw={"error": "forbidden"}),
            "not json": dict(threshold_raw=b"<html>"),
            "missing key": dict(threshold_raw={"other": 1}),
            "string": dict(threshold_raw={"threshold_tokens": "400000"}),
            "negative": dict(threshold_raw={"threshold_tokens": -5}),
            "boolean": dict(threshold_raw={"threshold_tokens": True}),
            "timeout": dict(threshold_delay=6),
        }
        for name, kw in cases.items():
            with self.subTest(name):
                d = self.serve(answering(**kw))
                p = self.run_hook(tokens=HIGH)
                # one threshold call, no retry, and no handoff call: no threshold means no pct and no HANDOFF
                self.assertSilent(p, d, ["threshold"])
                self.dash.close()

    def test_a_refused_connection_returns_at_once_and_injects_nothing(self):
        p = self.run_hook(tokens=HIGH, url=closed_port_url())
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(self.handoff_rows(), 0)
        self.assertLess(p.wall, 2.5)

    def test_every_handoff_failure_injects_nothing_and_writes_no_audit_row(self):
        bad_facts = {
            "5xx": dict(handoff_status=500, handoff_raw={"error": "x"}),
            "403": dict(handoff_status=403, handoff_raw={"error": "forbidden"}),
            "not json": dict(handoff_raw=b"{oops"),
            "not an object": dict(handoff_raw=[1, 2]),
            "own malformed": dict(facts=dict(STUB_FACTS, own={"status": 1})),
            "too many recent rows": dict(facts=dict(STUB_FACTS, recent=STUB_FACTS["recent"] * 4)),
            "card number not an integer": dict(facts=dict(STUB_FACTS, cards=[{"number": "7", "title": "t", "status": "waiting"}])),
            "last_outgoing not text": dict(facts=dict(STUB_FACTS, last_outgoing=5)),
            "timeout": dict(handoff_delay=6),
        }
        for name, kw in bad_facts.items():
            with self.subTest(name):
                d = self.serve(answering(threshold=400000, **kw))
                p = self.run_hook(tokens=HIGH)
                self.assertSilent(p, d, ["threshold", "handoff"])
                self.dash.close()

    def test_a_5xx_is_asked_once(self):
        d = self.serve(answering(threshold_status=500, threshold_raw={"error": "x"}))
        self.run_hook(tokens=HIGH)
        self.assertEqual(len(d.log), 1)

    def test_a_slow_dashboard_costs_at_most_the_short_deadline(self):
        d = self.serve(answering(threshold=400000, threshold_delay=6))
        p = self.run_hook(tokens=HIGH)
        self.assertEqual(p.stdout.strip(), "")
        self.assertLess(p.wall, 3.5)
        self.assertEqual(len(d.log), 1)

    def test_the_two_calls_share_one_short_deadline(self):
        # the threshold answers after 1.0 s, the handoff would take 6 s: ~0.5 s is left for it, so the run ends near 1.5 s in
        # total, NOT 1.0 + 1.5 (a per-call budget). The pre-read work of the hook (interpreter, transcript) is a few ms.
        self.serve(answering(threshold=400000, threshold_delay=1.0, handoff_delay=6))
        p = self.run_hook(tokens=HIGH)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(self.handoff_rows(), 0)
        self.assertLess(p.wall, 2.3)


class TestParityOfTheAdapters(unittest.TestCase):
    """The same facts through the SQLite adapter and through the route adapter give the same dict and the same text."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "t.db")
        self.conn = sqlite_cells._make_db(self.db_path)
        self.hook = sqlite_cells.hook

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_the_route_adapter_gives_the_dict_of_the_sqlite_adapter_and_the_pure_render_the_same_text(self):
        c = self.conn
        c.execute("INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) VALUES ('b1', 'agent-a', 'ref-1', 'active', 'own work', 100)")
        c.execute("INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) VALUES ('b2', 'agent-b', NULL, 'blocked', 'peer stuck', 300)")
        c.execute("INSERT INTO kanban_cards (id, title, status, assignee, updated_at, archived_at) VALUES ('k1', 'Card one', 'in_progress', 'agent-a', 200, NULL)")
        c.execute("INSERT INTO kanban_cards (id, title, status, assignee, updated_at, archived_at) VALUES ('k2', 'Card two', 'waiting', 'agent-a', 100, NULL)")
        c.execute("INSERT INTO agent_messages (from_agent, to_agent, content, created_at) VALUES ('agent-a', 'agent-b', 'the next step', 50)")
        c.commit()
        facts = self.hook.facts_from_sqlite(c, "agent-a")
        self.assertEqual([x["number"] for x in facts["cards"]], [1, 2])  # SQLite: the rowid is the number
        self.assertEqual(facts["own"]["task_ref"], "ref-1")

        # what the route would answer for the same rows: the same dict, through JSON
        class Stub:
            pass
        calls = []

        def fake(agent_id, session_id, want, deadline):
            calls.append(want)
            return json.loads(json.dumps(facts))
        original = self.hook._route_call
        self.hook._route_call = fake
        try:
            via_route = self.hook.facts_from_route("agent-a", "s", None)
        finally:
            self.hook._route_call = original
        self.assertEqual(via_route, facts)
        import datetime
        now = datetime.datetime(2026, 11, 27, 12, 0, 0, tzinfo=datetime.timezone.utc)
        a = self.hook.render_handoff(facts, 0.62, 248000, 400000, now=now)
        b = self.hook.render_handoff(via_route, 0.62, 248000, 400000, now=now)
        self.assertEqual(a, b)
        # and the SQLite-install entry point renders the same text as before the split (modulo the header clock)
        c_text = self.hook.build_handoff(c, "agent-a", 0.62, 248000, 400000)
        self.assertEqual(c_text.split("\n", 1)[1], a.split("\n", 1)[1])

    def test_a_missing_fact_is_absent_in_both(self):
        facts = self.hook.facts_from_sqlite(self.conn, "agent-a")
        self.assertEqual(facts, {"own": None, "recent": [], "cards": [], "last_outgoing": None})
        text = self.hook.render_handoff(facts, 0.6, 240000, 400000)
        self.assertNotIn("Aktualis feladat", text)
        self.assertNotIn("Nyitott kartyak", text)
        self.assertNotIn("Kovetkezo lepes", text)


if __name__ == "__main__":
    unittest.main()
