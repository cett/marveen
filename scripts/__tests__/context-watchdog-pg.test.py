#!/usr/bin/env python3
"""Tests for the PostgreSQL mode of scripts/hooks/context-watchdog.py (H1 reads + H2a writes).

In PG mode the hook never opens the SQLite file. ONE record call per PostToolUse (POST /api/v1/hooks/watchdog-record)
carries the token_usage row, the spans and the stale-turn close and answers the threshold; only past the watchdog
percentage, for a top-level session: the dedup read (`want: prior_handoff` on /api/v1/hooks/watchdog-facts), the facts
(`want: handoff`), the injection and the audit row (POST /api/v1/hook-audit). All under a short budget, ONE attempt per
call, no retry, no fallback. A stub HTTP server plays the dashboard; the SQLite fixture deliberately CONTRADICTS the stub
and a `sitecustomize` poison makes any sqlite3.connect fail loudly and leave a marker, so a touch of the wrong place shows.
The differential against the REAL TypeScript routes is src/__tests__/hooks-tenant-python-differential.test.ts.

Each cell has a red a removed guard would give (the mutants are listed in the PR text and run by the QA gates):
  - sqlite3.connect still reached in PG mode            -> test_pg_mode_never_opens_the_sqlite_file
  - the route adapter is not selected in PG mode        -> test_pg_mode_text_comes_from_the_route_not_the_stale_sqlite
  - a failed dedup read treated as "no prior row"       -> test_every_prior_handoff_failure_injects_nothing_it_never_fails_open
  - the threshold withheld/guessed after a record error -> test_every_record_failure_injects_nothing_and_never_falls_back
  - per-span calls instead of one record call           -> test_one_record_call_carries_usage_spans_and_the_stale_close
  - the audit row not written / not read back           -> test_the_emit_audit_pair_dedups_the_next_call
  - the shared deadline becomes per-call                -> test_the_calls_share_one_short_deadline
  - a retry after a 5xx                                 -> test_a_5xx_is_asked_once
Neutral fixtures only (agent-a, agent-b).
"""
import hashlib
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
# isolated copy of the hook (empty store, no PG marker): PR 959 test-only isolation, see pg_install_isolation.py
from pg_install_isolation import isolated_hooks_dir, isolated_install_root  # noqa: E402
HOOK = os.path.join(isolated_hooks_dir(), "context-watchdog.py")
# the agent is read from the cwd under the hook's own install root (the isolated one): same agent-a fixture, new root
CWD = os.path.join(isolated_install_root(), "agents", "agent-a")
FACTS = "/api/v1/hooks/watchdog-facts"
RECORD = "/api/v1/hooks/watchdog-record"
AUDIT = "/api/v1/hook-audit"
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

# sqlite3.connect raises and leaves a marker: in PG mode the hook must never reach it.
POISON = """
import os, sqlite3
def _boom(*a, **k):
    with open(os.environ["POISON_MARK"], "w") as f:
        f.write("sqlite3.connect")
    raise RuntimeError("sqlite3.connect reached in PG mode")
sqlite3.connect = _boom
"""


class Script:
    """The dashboard's behaviour: answers the three routes, keeps the audit rows it was sent (so the dedup pair is real).
    Each route can be overridden with (status, json-able or raw bytes, delay_seconds)."""

    def __init__(self, threshold=400000, facts=None):
        self.threshold = threshold
        self.facts = STUB_FACTS if facts is None else facts
        self.record = None
        self.prior = None
        self.handoff = None
        self.audit = None
        self.audit_rows = []

    def __call__(self, path, body):
        body = body or {}
        if path == RECORD:
            return self.record or (200, {"threshold_tokens": self.threshold, "usage": True, "spans": len(body.get("spans") or []), "dropped": 0}, 0)
        if path == FACTS and body.get("want") == "prior_handoff":
            if self.prior:
                return self.prior
            rows = [r for r in self.audit_rows if r["session_id"] == body.get("session_id")]
            return 200, (rows[-1]["answer"] if rows else None), 0
        if path == FACTS and body.get("want") == "handoff":
            return self.handoff or (200, self.facts, 0)
        if path == AUDIT:
            if self.audit:
                return self.audit
            self.audit_rows.append({"session_id": body.get("session_id"), "body": body,
                                    "answer": {"ts": int(time.time()), "reason": body.get("reason"), "content_hash": body.get("content_hash")}})
            return 200, {"ok": True}, 0
        return 400, {"error": "invalid_value"}, 0


class Dashboard:
    """A stub of the dashboard. `script(path, body)` -> (status, json-able or raw bytes, delay_seconds). Every request is logged."""

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
                status, obj, delay = outer.script(self.path, body)
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

    def calls(self):
        """(path, want) per request, in order: the record call has no want."""
        return [(c["path"], (c["body"] or {}).get("want")) for c in self.log]

    def paths(self):
        return [c["path"] for c in self.log]


def closed_port_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return "http://127.0.0.1:%d" % port


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


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
        self.db_hash = sha(self.db_path)
        self.db_mtime = os.stat(self.db_path).st_mtime_ns
        self.transcript = os.path.join(self.tmp.name, "transcript.jsonl")
        self.token_file = os.path.join(self.tmp.name, "token")
        with open(self.token_file, "w") as f:
            f.write(TOKEN)
        self.empty = os.path.join(self.tmp.name, "empty")
        os.mkdir(self.empty)
        self.poison_dir = os.path.join(self.tmp.name, "poison")
        os.mkdir(self.poison_dir)
        with open(os.path.join(self.poison_dir, "sitecustomize.py"), "w") as f:
            f.write(POISON)
        self.poison_mark = os.path.join(self.tmp.name, "poison.mark")
        self.dash = None
        self.script = None

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
            # the poison is for PG mode only: SQLite mode has to connect
            env["PYTHONPATH"] = self.poison_dir
            env["POISON_MARK"] = self.poison_mark
        if url:
            env["DASHBOARD_BASE_URL"] = url
        return env

    def serve(self, script=None):
        self.script = script or Script()
        self.dash = Dashboard(self.script)
        return self.dash

    def reserve(self, script):
        """Replace the stub (a second call of the hook against a different behaviour) keeping nothing of the first."""
        self.dash.close()
        return self.serve(script)

    def run_hook(self, tokens=HIGH, url=None, pg=True, session="sess-1", events=None, **payload_extra):
        sqlite_cells._write_jsonl(self.transcript, events or [sqlite_cells._user_event(), sqlite_cells._usage_event(input_tokens=tokens)])
        payload = {"session_id": session, "tool_name": "Bash", "cwd": CWD, "transcript_path": self.transcript}
        payload.update(payload_extra)
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True,
                           env=self.env(url=url if url is not None else (self.dash.url if self.dash else None), pg=pg), timeout=30)
        p.wall = time.monotonic() - t0
        return p

    def assertNoSqliteTouch(self):
        self.assertFalse(os.path.exists(self.poison_mark), "sqlite3.connect was reached in PG mode")
        self.assertEqual(sha(self.db_path), self.db_hash)
        self.assertEqual(os.stat(self.db_path).st_mtime_ns, self.db_mtime)

    def text_of(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.strip(), "the hook injected nothing: " + proc.stderr)
        return json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]

    def assertSilent(self, p, calls):
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(self.dash.calls() if self.dash else [], calls)
        self.assertLess(p.wall, 4.0)  # interpreter start + the 1.5 s budget, far under the 10 s harness timeout
        self.assertNoSqliteTouch()


class TestPgModeWrites(Base):
    def test_pg_mode_never_opens_the_sqlite_file(self):
        # the whole path: record, prior_handoff, facts, emit, audit. The stale file is untouched and sqlite3.connect never ran.
        self.serve()
        self.text_of(self.run_hook())
        self.assertNoSqliteTouch()

    def test_one_record_call_carries_usage_spans_and_the_stale_close(self):
        d = self.serve()
        p = self.run_hook(tokens=LOW)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(d.paths(), [RECORD])  # ONE call below the line, not one per span
        body = d.log[0]["body"]
        self.assertEqual(d.log[0]["auth"], "Bearer " + TOKEN)
        self.assertEqual(set(body), {"usage", "spans", "close_stale"})
        u = body["usage"]
        self.assertEqual((u["session_id"], u["input_tokens"], u["output_tokens"], u["model"], u["tool_name"]),
                         ("sess-1", LOW, 50, "claude-test-model", "Bash"))
        ops = [(s["operation"], s["span_id"], s["parent_span_id"], s["trace_id"], s["status"]) for s in body["spans"]]
        self.assertEqual(ops, [("agent.turn", "turn-uuid-1", None, "sess-1", "running"), ("model.call", "msg_1", "turn-uuid-1", "sess-1", "ok")])
        self.assertEqual(body["close_stale"], {"trace_id": "sess-1", "keep_span_id": "turn-uuid-1"})
        self.assertNotIn("tenant_id", json.dumps(body))  # the tenants are the server's, never sent
        self.assertNoSqliteTouch()

    def test_a_transcript_without_a_turn_start_sends_the_model_span_alone_and_no_close(self):
        d = self.serve()
        self.run_hook(tokens=LOW, events=[sqlite_cells._usage_event(input_tokens=LOW)])
        body = d.log[0]["body"]
        self.assertEqual([s["operation"] for s in body["spans"]], ["model.call"])
        self.assertIsNone(body["spans"][0]["parent_span_id"])
        self.assertIsNone(body["close_stale"])

    def test_the_sqlite_and_the_route_payloads_are_the_same_row(self):
        # the shared builders: the row the SQLite writer inserts is the row the route payload names
        d = self.serve()
        self.run_hook(tokens=LOW)
        sent = d.log[0]["body"]["usage"]
        hook = sqlite_cells.hook
        ev = sqlite_cells._usage_event(input_tokens=LOW)
        self.assertEqual(hook.build_usage("sess-1", ev, "Bash"), sent)

    def test_pg_mode_text_comes_from_the_route_not_the_stale_sqlite(self):
        d = self.serve()
        text = self.text_of(self.run_hook())
        for fact in ("stub work item", "[kanban card-stub]", "agent-stub [active]: stub recent line", "#7 [in_progress]: Stub card", "stub next step"):
            self.assertIn(fact, text)
        for stale in ("stale sqlite work", "stale peer line", "Stale card", "stale next step", "card-stale"):
            self.assertNotIn(stale, text)
        self.assertEqual(d.calls(), [(RECORD, None), (FACTS, "prior_handoff"), (FACTS, "handoff"), (AUDIT, None)])

    def test_the_threshold_comes_from_the_record_answer(self):
        self.serve(Script(threshold=200000))
        self.assertIn("250,000 / 200,000", self.text_of(self.run_hook()))  # not the 123456 the stale SQLite row holds

    def test_a_null_threshold_is_the_default_not_the_stale_sqlite_row(self):
        self.serve(Script(threshold=None))
        self.assertIn("250,000 / 400,000", self.text_of(self.run_hook()))

    def test_below_the_line_only_the_record_call_is_made(self):
        d = self.serve()
        p = self.run_hook(tokens=LOW)
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(d.calls(), [(RECORD, None)])

    def test_a_spawned_sub_agent_records_tokens_and_spans_but_never_injects(self):
        d = self.serve()
        p = self.run_hook(agent_id="sub-uuid")
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(d.calls(), [(RECORD, None)])  # no dedup read, no facts, no audit row
        self.assertEqual(len(d.log[0]["body"]["spans"]), 2)
        self.assertEqual(self.script.audit_rows, [])
        self.assertNoSqliteTouch()

    def test_the_requests_carry_the_agents_own_token(self):
        d = self.serve()
        self.text_of(self.run_hook())
        self.assertEqual({c["path"] for c in d.log}, {RECORD, FACTS, AUDIT})
        self.assertTrue(all(c["auth"] == "Bearer " + TOKEN for c in d.log))

    def test_without_pg_mode_the_dashboard_is_not_asked_and_sqlite_is_read_and_written(self):
        d = self.serve(Script(threshold=200000))
        text = self.text_of(self.run_hook(pg=False))
        self.assertEqual(d.log, [])
        self.assertIn("stale sqlite work", text)
        self.assertIn("250,000 / 123,456", text)
        self.assertNotEqual(sha(self.db_path), self.db_hash)  # the SQLite path still writes its rows


class TestDedupPair(Base):
    def test_the_emit_audit_pair_dedups_the_next_call(self):
        # the audit row lands (through the dashboard), the next call reads it back and emits nothing
        d = self.serve()
        self.text_of(self.run_hook())
        self.assertEqual(len(self.script.audit_rows), 1)
        row = self.script.audit_rows[0]["body"]
        self.assertEqual((row["hook_type"], row["verdict"], row["trigger_source"], row["session_id"], row["tool_name"]),
                         ("PostToolUse", "handoff", "watchdog", "sess-1", "Bash"))
        self.assertRegex(row["reason"], r"^ctx=\d+%$")
        self.assertTrue(row["content_hash"])
        self.assertNotIn("agent_id", row)  # the agent is the token's
        n = len(d.log)
        second = self.run_hook()
        self.assertEqual(second.returncode, 0)
        self.assertEqual(second.stdout.strip(), "")
        self.assertEqual(len(self.script.audit_rows), 1)
        # record, the dedup read, then (rule 4) the facts to compare the content: unchanged -> nothing emitted, no audit row
        self.assertEqual(d.calls()[n:], [(RECORD, None), (FACTS, "prior_handoff"), (FACTS, "handoff")])

    def test_a_changed_fact_emits_again_once_the_gap_has_passed(self):
        self.serve()
        self.text_of(self.run_hook())
        self.script.audit_rows[0]["answer"]["ts"] -= 1000
        self.script.facts = dict(STUB_FACTS, last_outgoing="a different next step")
        self.assertIn("a different next step", self.text_of(self.run_hook()))
        self.assertEqual(len(self.script.audit_rows), 2)

    def test_a_slow_facts_call_leaves_the_audit_row_its_own_budget(self):
        # The facts call answers after 1.25 s of the shared 1.5 s: ~0.25 s is left, under the 0.3 s minimum attempt time, so on
        # the shared deadline the audit call would be skipped and the NEXT call would find no prior row and inject again. The
        # audit call has its own 0.4 s: the row is written, the HANDOFF is injected, the next call dedups.
        d = self.serve()
        self.script.handoff = (200, STUB_FACTS, 1.25)
        p = self.run_hook()
        self.text_of(p)
        self.assertEqual(d.paths().count(AUDIT), 1)
        self.assertEqual(len(self.script.audit_rows), 1)
        self.assertLess(p.wall, 3.0)  # 1.5 s shared + at most 0.4 s of the audit's own + interpreter start

    def test_the_audit_budget_is_small_and_its_own_a_slow_audit_endpoint_costs_at_most_it(self):
        d = self.serve()
        self.script.handoff = (200, STUB_FACTS, 1.25)
        self.script.audit = (200, {"ok": True}, 6)
        p = self.run_hook()
        self.text_of(p)  # emit comes first, the slow audit cannot take the injection back
        self.assertEqual(d.paths().count(AUDIT), 1)
        self.assertIn("audit row was not written", p.stderr)
        self.assertLess(p.wall, 3.0)

    def test_an_answer_of_null_is_a_first_crossing_and_emits(self):
        d = self.serve()
        self.script.prior = (200, None, 0)
        self.text_of(self.run_hook())
        self.assertEqual(d.calls()[-1], (AUDIT, None))

    def test_a_failed_audit_write_after_the_emit_is_one_stderr_line_and_the_text_is_still_injected(self):
        d = self.serve()
        self.script.audit = (500, {"error": "x"}, 0)
        p = self.run_hook()
        self.assertIn("stub work item", self.text_of(p))
        self.assertEqual(p.stderr.count("\n"), 1, p.stderr)
        self.assertIn("audit row was not written", p.stderr)
        self.assertEqual([c for c in d.paths() if c == AUDIT], [AUDIT])  # once, no retry
        self.assertNoSqliteTouch()


class TestRouteFailures(Base):
    """A route that does not answer usably: injection absent, exit 0, no audit row, no SQLite touch, inside the short budget."""

    def test_every_record_failure_injects_nothing_and_never_falls_back(self):
        cases = {
            "5xx": (503, {"error": "x"}, 0),
            "403": (403, {"error": "forbidden"}, 0),
            "not json": (200, b"<html>", 0),
            "missing key": (200, {"other": 1}, 0),
            "string": (200, {"threshold_tokens": "400000"}, 0),
            "negative": (200, {"threshold_tokens": -5}, 0),
            "boolean": (200, {"threshold_tokens": True}, 0),
            "timeout": (200, {"threshold_tokens": 400000}, 6),
        }
        for name, answer in cases.items():
            with self.subTest(name):
                self.serve()
                self.script.record = answer
                p = self.run_hook()
                # one record call, no retry, and nothing after it: no threshold means no pct and no HANDOFF
                self.assertSilent(p, [(RECORD, None)])
                self.dash.close()

    def test_a_refused_connection_returns_at_once_and_injects_nothing(self):
        p = self.run_hook(url=closed_port_url())
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")
        self.assertLess(p.wall, 2.5)
        self.assertNoSqliteTouch()

    def test_every_prior_handoff_failure_injects_nothing_it_never_fails_open(self):
        # a failed dedup read must NOT read as "no prior row" (that rule is for an ANSWER of null): else the hook would
        # emit on every tool call. No facts call, no injection, no audit row.
        cases = {
            "5xx": (500, {"error": "x"}, 0),
            "403": (403, {"error": "forbidden"}, 0),
            "not json": (200, b"{oops", 0),
            "not an object": (200, [1, 2], 0),
            "ts not an integer": (200, {"ts": "100", "reason": "ctx=61%", "content_hash": "h"}, 0),
            "reason not text": (200, {"ts": 100, "reason": 5, "content_hash": "h"}, 0),
            "timeout": (200, None, 6),
        }
        for name, answer in cases.items():
            with self.subTest(name):
                self.serve()
                self.script.prior = answer
                p = self.run_hook()
                self.assertSilent(p, [(RECORD, None), (FACTS, "prior_handoff")])
                self.assertEqual(self.script.audit_rows, [])
                self.dash.close()

    def test_every_handoff_failure_injects_nothing_and_writes_no_audit_row(self):
        bad_facts = {
            "5xx": (500, {"error": "x"}, 0),
            "403": (403, {"error": "forbidden"}, 0),
            "not json": (200, b"{oops", 0),
            "not an object": (200, [1, 2], 0),
            "own malformed": (200, dict(STUB_FACTS, own={"status": 1}), 0),
            "too many recent rows": (200, dict(STUB_FACTS, recent=STUB_FACTS["recent"] * 4), 0),
            "card number not an integer": (200, dict(STUB_FACTS, cards=[{"number": "7", "title": "t", "status": "waiting"}]), 0),
            "last_outgoing not text": (200, dict(STUB_FACTS, last_outgoing=5), 0),
            "timeout": (200, STUB_FACTS, 6),
        }
        for name, answer in bad_facts.items():
            with self.subTest(name):
                self.serve()
                self.script.handoff = answer
                p = self.run_hook()
                self.assertSilent(p, [(RECORD, None), (FACTS, "prior_handoff"), (FACTS, "handoff")])
                self.assertEqual(self.script.audit_rows, [])
                self.dash.close()

    def test_a_5xx_is_asked_once(self):
        d = self.serve()
        self.script.record = (500, {"error": "x"}, 0)
        self.run_hook()
        self.assertEqual(len(d.log), 1)

    def test_a_slow_dashboard_costs_at_most_the_short_deadline(self):
        d = self.serve()
        self.script.record = (200, {"threshold_tokens": 400000}, 6)
        p = self.run_hook()
        self.assertEqual(p.stdout.strip(), "")
        self.assertLess(p.wall, 3.5)
        self.assertEqual(len(d.log), 1)

    def test_the_calls_share_one_short_deadline(self):
        # the record call answers after 1.0 s, the dedup read would take 6 s: ~0.5 s is left for it, so the run ends near 1.5 s
        # in total, NOT 1.0 + 1.5 (a per-call budget). The pre-read work of the hook (interpreter, transcript) is a few ms.
        self.serve()
        self.script.record = (200, {"threshold_tokens": 400000}, 1.0)
        self.script.prior = (200, None, 6)
        p = self.run_hook()
        self.assertEqual(p.stdout.strip(), "")
        self.assertEqual(self.script.audit_rows, [])
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
        calls = []

        def fake(agent_id, session_id, want, deadline, extra=None):
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

    def test_the_record_answer_threshold_must_be_a_positive_integer_zero_is_not_one(self):
        # A zero threshold read as a number would make pct 0 and the hook SILENT, which looks like "below the line" from the
        # outside (the end-to-end cell cannot tell it from a refused answer). So the reader itself is pinned: the route never
        # answers 0, and an answer of 0 is a malformed answer (RouteError, no HANDOFF path, no guess), exactly like a negative
        # number, a boolean (True is an int in Python), a string or a float. null is the one accepted non-number: the default.
        hook = self.hook
        real = hook._route_post
        try:
            for bad in (0, -1, True, False, "400000", 400000.0, [], {}):
                hook._route_post = lambda *a, _v=bad, **k: {"threshold_tokens": _v}
                with self.subTest(answer=repr(bad)):
                    try:
                        got = hook.record_via_route("agent-a", "sess-1", None, [], None, None)
                    except Exception as exc:
                        self.assertEqual(type(exc).__name__, "RouteError")
                    else:
                        self.fail("a threshold answer of %r was accepted as %r" % (bad, got))
            hook._route_post = lambda *a, **k: {"threshold_tokens": None}
            self.assertEqual(hook.record_via_route("agent-a", "sess-1", None, [], None, None), hook.DEFAULT_THRESHOLD_TOKENS)
            hook._route_post = lambda *a, **k: {"threshold_tokens": 1}
            self.assertEqual(hook.record_via_route("agent-a", "sess-1", None, [], None, None), 1)
        finally:
            hook._route_post = real

    def test_a_missing_fact_is_absent_in_both(self):
        facts = self.hook.facts_from_sqlite(self.conn, "agent-a")
        self.assertEqual(facts, {"own": None, "recent": [], "cards": [], "last_outgoing": None})
        text = self.hook.render_handoff(facts, 0.6, 240000, 400000)
        self.assertNotIn("Aktualis feladat", text)
        self.assertNotIn("Nyitott kartyak", text)
        self.assertNotIn("Kovetkezo lepes", text)

    def test_the_dedup_decision_is_the_same_over_a_sqlite_row_and_a_route_answer(self):
        # decide_emit(prev, ...) is the one rule: SQLite feeds it the row tuple, PG mode the route's answer as the same tuple
        hook = self.hook
        now = 10_000
        row = (now - 10, "ctx=62%", "h-same")
        self.assertEqual(hook.decide_emit(None, 0.62, now, lambda: "t")[0], True)  # no prior row: first crossing
        self.assertEqual(hook.decide_emit(row, 0.72, now, lambda: "t")[0], True)  # band changed
        # same band, changed content, but inside the 300 s gap: nothing (rule 4 needs the gap too)
        self.assertEqual(hook.decide_emit(row, 0.62, now, lambda: "changed")[0], False)
        text = "stable"
        same = (now - 1000, "ctx=62%", hook._hash_handoff_text(text))
        self.assertEqual(hook.decide_emit(same, 0.62, now, lambda: text), (False, None, None))


if __name__ == "__main__":
    unittest.main()
