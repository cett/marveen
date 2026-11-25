#!/usr/bin/env python3
"""Tests for the PostgreSQL mode of the tenant hooks (tenant-context.py, tenant-skill-gate.py).

In PG mode the hooks never open the SQLite file (stale there); they ask the dashboard (POST /api/v1/hooks/tenant-facts, PUT
/api/v1/hooks/tenant-context, POST /api/v1/hooks/skill-gate) and decide with the same policy code. A stub HTTP server plays
the dashboard. The differential against the REAL TypeScript route (same data, both modes) is
src/__tests__/hooks-tenant-python-differential.test.ts; here the answers are canned, so each cell isolates one behaviour.

Each cell has a red a removed guard would give (the mutants are listed in the PR text and run by the QA gates):
  - the PG path reads SQLite                     -> test_pg_mode_never_reads_the_sqlite_file
  - a SQLite fallback after a route error        -> test_route_down_is_a_refusal_not_a_sqlite_read
  - the deadline passes the hook timeout         -> test_a_dashboard_that_hangs_costs_less_than_the_deadline
  - another agent's message resolves             -> test_a_message_for_another_agent_is_unknown_even_if_the_route_returns_it
Neutral fixtures only (agent-a, agent-b, tenant-x, tenant-y).
"""
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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOKS = os.path.join(ROOT, "scripts", "hooks")
sys.path.insert(0, HOOKS)
import tenant_context_lib as tcl  # noqa: E402

CWD = os.path.join(ROOT, "agents", "agent-a")
SK = CWD + "/.claude/skills/"
TOKEN = "test-token-agent-a"
CHAN = '<channel source="plugin:telegram:telegram" chat_id="%s" message_id="1" user="u">\nhi\n</channel>'
FACTS = "/api/v1/hooks/tenant-facts"
CONTEXT = "/api/v1/hooks/tenant-context"
GATE = "/api/v1/hooks/skill-gate"


def frame(msg_id):
    return ('[Uzenet @coord-tol -- trusted team member, msg_id:%s]: <trusted-peer source="agent:coord">\nhi\n</trusted-peer>' % msg_id)


class Dashboard:
    """A stub of the dashboard. `script(method, path, body)` -> (status, json-able, delay_seconds). Every request is logged."""

    def __init__(self, script):
        self.script = script
        self.log = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _serve(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                body = json.loads(raw) if raw else None
                outer.log.append({"method": self.command, "path": self.path, "body": body,
                                  "auth": self.headers.get("Authorization"), "agent": self.headers.get("X-Agent-Id")})
                status, obj, delay = outer.script(self.command, self.path, body)
                if delay:
                    time.sleep(delay)
                data = json.dumps(obj).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass  # the hook gave up and closed the connection

            do_GET = do_POST = do_PUT = _serve

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def calls(self, path=None):
        return [c for c in self.log if path is None or c["path"] == path]


def free_closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
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

    def env(self, url=None, db=None, pg=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith("MARVEEN_PG") and k != "DASHBOARD_BASE_URL"}
        env.update(SECRET_MOUNT_DIR=self.empty, CLAUDECLAW_ENV_DIR=self.empty, MARVEEN_AGENT_TOKEN_FILE=self.token_file,
                   LEDGER_DB_PATH=db or os.path.join(self.tmp.name, "does-not-exist", "x.db"))
        if pg:
            env["MARVEEN_PG_URL"] = "postgres://placeholder.invalid/db"
        if url:
            env["DASHBOARD_BASE_URL"] = url
        return env

    def serve(self, script):
        self.dash = Dashboard(script)
        return self.dash

    def run_hook(self, name, payload, **kw):
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, os.path.join(HOOKS, name)], input=json.dumps(payload),
                           capture_output=True, text=True, env=self.env(**kw), timeout=60)
        p.wall = time.monotonic() - t0
        return p

    def prompt(self, text, sid="s1", **kw):
        return self.run_hook("tenant-context.py", {"cwd": CWD, "prompt": text, "session_id": sid}, **kw)

    def gate(self, tool, **inp):
        return self.run_hook("tenant-skill-gate.py", {"tool_name": tool, "tool_input": inp, "cwd": CWD, "session_id": "s1"},
                             url=self.dash.url if self.dash else None)


def facts_answer(sources, serves=None):
    return {"sources": sources, "serves": serves or {}}


# ── RouteFacts: the lookups answered from one prefetched answer ──────────────────────────────────────

class TestRouteFacts(unittest.TestCase):
    def sources(self, prompt):
        return tcl.route_sources(tcl.parse_sources(prompt))

    def test_a_lookup_that_was_not_prefetched_raises_instead_of_guessing(self):
        facts = tcl.RouteFacts("agent-a", [], {"sources": [], "serves": {}})
        for call in (lambda: facts.binding("agent-a", "telegram", "111"), lambda: facts.serves("agent-a", "tenant-x"),
                     lambda: facts.message(11), lambda: facts.schedule("agent-a", "job")):
            with self.assertRaises(tcl.FactsUnavailable):
                call()

    def test_a_fact_for_another_agent_raises(self):
        req = self.sources(CHAN % "111")
        facts = tcl.RouteFacts("agent-a", req, facts_answer([{"kind": "channel", "binding": "tenant-x"}], {"tenant-x": True}))
        self.assertEqual(facts.binding("agent-a", "telegram", "111"), "tenant-x")
        with self.assertRaises(tcl.FactsUnavailable):
            facts.binding("agent-b", "telegram", "111")
        with self.assertRaises(tcl.FactsUnavailable):
            facts.serves("agent-b", "tenant-x")

    def test_an_answer_that_does_not_fit_the_request_is_refused(self):
        req = self.sources(CHAN % "111")
        for bad in (None, [], {"sources": "x", "serves": {}}, {"sources": [], "serves": {}},
                    {"sources": [{"kind": "message"}], "serves": {}},
                    {"sources": [{"kind": "channel", "binding": 5}], "serves": {}},
                    {"sources": [{"kind": "channel", "binding": None}], "serves": {"tenant-x": "yes"}}):
            with self.assertRaises(tcl.FactsUnavailable, msg=repr(bad)):
                tcl.RouteFacts("agent-a", req, bad)

    def test_no_marker_makes_no_call_and_resolves_to_the_default_tenant(self):
        def never(_):
            raise AssertionError("the dashboard must not be asked for a plain prompt")
        facts = tcl.prefetch_facts("agent-a", "typed in the terminal", never)
        self.assertEqual(tcl.resolve_prompt(facts, "agent-a", "typed in the terminal"), ("default", "default", "local"))

    def test_unidentifiable_sources_make_no_call_and_are_unknown(self):
        p = '<channel source="plugin:telegram:telegram">hi</channel>'
        def never(_):
            raise AssertionError("an unknown source needs no fact")
        facts = tcl.prefetch_facts("agent-a", p, never)
        self.assertEqual(tcl.resolve_prompt(facts, "agent-a", p)[0], "unknown")

    def test_the_request_names_each_source_once(self):
        p = CHAN % "111" + "\n" + CHAN % "111" + "\n" + frame(11) + "\n" + frame(11)
        self.assertEqual(self.sources(p), [{"kind": "channel", "channel": "telegram", "external_id": "111"},
                                          {"kind": "message", "msg_id": 11}])

    def test_the_resolver_cannot_widen_a_missing_fact(self):
        # the answer names the channel but not the tenant's serves flag: bound must not be invented
        req = self.sources(CHAN % "111")
        facts = tcl.RouteFacts("agent-a", req, facts_answer([{"kind": "channel", "binding": "tenant-x"}], {}))
        with self.assertRaises(tcl.FactsUnavailable):
            tcl.resolve_prompt(facts, "agent-a", CHAN % "111")


# ── tenant-context.py in PG mode ─────────────────────────────────────────────────────────────────────

def routing(binding_for=None, messages=None, schedules=None, serves=None, record_status=200):
    """A dashboard script answering the facts route from small tables and accepting the record."""
    binding_for = binding_for or {}
    messages = messages or {}
    schedules = schedules or {}
    serves = serves or {}

    def script(method, path, body):
        if path == FACTS:
            out = []
            for s in body["sources"]:
                if s["kind"] == "channel":
                    out.append({"kind": "channel", "binding": binding_for.get((s["channel"], s["external_id"]))})
                elif s["kind"] == "message":
                    m = messages.get(s["msg_id"])
                    out.append({"kind": "message", "message": m,
                                "inter_agent_binding": binding_for.get(("inter-agent", (m or {}).get("from_agent") or ""))} if m
                               else {"kind": "message", "message": None})
                else:
                    out.append({"kind": "scheduled", "schedule": schedules.get(s["name"])})
            return 200, facts_answer(out, serves), 0
        if path == CONTEXT:
            return (record_status, {"ok": True} if record_status == 200 else {"error": "forbidden"}, 0)
        return 404, {"error": "not_found"}, 0
    return script


class TestTenantContextPg(Base):
    def test_a_bound_channel_is_recorded_through_the_route_with_the_agents_own_token(self):
        d = self.serve(routing({("telegram", "111"): "tenant-x"}, serves={"tenant-x": True}))
        p = self.prompt(CHAN % "111", url=d.url)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([c["path"] for c in d.log], [FACTS, CONTEXT])
        self.assertEqual(d.log[0]["body"]["sources"], [{"kind": "channel", "channel": "telegram", "external_id": "111"}])
        rec = d.log[1]
        self.assertEqual(rec["method"], "PUT")
        self.assertEqual({k: rec["body"][k] for k in ("status", "tenant_id", "session_id")}, {"status": "bound", "tenant_id": "tenant-x", "session_id": "s1"})
        self.assertIn("channel:telegram:111", rec["body"]["source"])
        self.assertTrue(all(c["auth"] == "Bearer " + TOKEN for c in d.log))
        self.assertNotIn("agent_id", rec["body"])   # the server takes the caller from the token, the hook does not assert one

    def test_plain_prompt_asks_for_no_facts_and_records_the_default_tenant(self):
        d = self.serve(routing())
        p = self.prompt("typed in the terminal", url=d.url)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([c["path"] for c in d.log], [CONTEXT])
        self.assertEqual({k: d.log[0]["body"][k] for k in ("status", "tenant_id", "source")}, {"status": "default", "tenant_id": "default", "source": "local"})

    def test_scheduled_and_message_sources(self):
        d = self.serve(routing({("inter-agent", "coord"): "tenant-x"},
                               messages={13: {"to_agent": "agent-a", "from_agent": "coord", "tenant_id": "default"}},
                               schedules={"job-y": {"tenant_id": "tenant-y"}}, serves={"tenant-x": True, "tenant-y": True}))
        self.prompt(frame(13), url=d.url)
        self.assertEqual((d.log[-1]["body"]["status"], d.log[-1]["body"]["tenant_id"]), ("bound", "tenant-x"))
        self.prompt('<scheduled-task source="scheduled-task:job-y">\nbody\n</scheduled-task>', url=d.url)
        self.assertEqual((d.log[-1]["body"]["status"], d.log[-1]["body"]["tenant_id"]), ("bound", "tenant-y"))

    def test_a_missing_row_is_unknown(self):
        d = self.serve(routing())   # no message, no schedule
        self.prompt(frame(99), url=d.url)
        self.assertEqual((d.log[-1]["body"]["status"], d.log[-1]["body"]["tenant_id"]), ("unknown", ""))
        self.prompt('<scheduled-task source="scheduled-task:nope">x</scheduled-task>', url=d.url)
        self.assertEqual((d.log[-1]["body"]["status"], d.log[-1]["body"]["tenant_id"]), ("unknown", ""))

    def test_a_tenant_the_agent_no_longer_serves_is_unknown(self):
        d = self.serve(routing({("telegram", "111"): "tenant-x"}, serves={"tenant-x": False}))
        self.prompt(CHAN % "111", url=d.url)
        self.assertEqual((d.log[-1]["body"]["status"], d.log[-1]["body"]["tenant_id"]), ("unknown", ""))

    def test_a_message_for_another_agent_is_unknown_even_if_the_route_returns_it(self):
        # defence in depth: the server already hides it (message null); the policy refuses it on its own as well
        d = self.serve(routing(messages={12: {"to_agent": "agent-b", "from_agent": "coord", "tenant_id": "tenant-x"}}, serves={"tenant-x": True}))
        self.prompt(frame(12), url=d.url)
        self.assertEqual((d.log[-1]["body"]["status"], d.log[-1]["body"]["tenant_id"]), ("unknown", ""))

    def test_pg_mode_never_reads_the_sqlite_file(self):
        # the stale file says channel 111 is tenant-y; the route says tenant-x; a hook that read the file would record tenant-y
        db = os.path.join(self.tmp.name, "stale.db")
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE tenant_channel_bindings (agent_id TEXT, channel TEXT, external_id TEXT, tenant_id TEXT)")
        con.execute("INSERT INTO tenant_channel_bindings VALUES ('agent-a','telegram','111','tenant-y')")
        con.commit(); con.close()
        d = self.serve(routing({("telegram", "111"): "tenant-x"}, serves={"tenant-x": True, "tenant-y": True}))
        p = self.prompt(CHAN % "111", url=d.url, db=db)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(d.log[-1]["body"]["tenant_id"], "tenant-x")
        con = sqlite3.connect(db)
        try:
            self.assertEqual([r[0] for r in con.execute("SELECT name FROM sqlite_master")], ["tenant_channel_bindings"])   # nothing was written either
        finally:
            con.close()

    def test_route_down_is_a_refusal_not_a_sqlite_read(self):
        # the file has a valid answer; with the dashboard down the marked prompt must be refused, not served from the file
        db = os.path.join(self.tmp.name, "live.db")
        con = sqlite3.connect(db)
        with open(os.path.join(ROOT, "src", "migrations", "0065_agent_tenant_context.sql")) as f:
            con.executescript(f.read())
        con.execute("CREATE TABLE tenant_channel_bindings (agent_id TEXT, channel TEXT, external_id TEXT, tenant_id TEXT)")
        con.execute("INSERT INTO tenant_channel_bindings VALUES ('agent-a','telegram','111','tenant-x')")
        con.commit(); con.close()
        p = self.prompt(CHAN % "111", url="http://127.0.0.1:%d" % free_closed_port(), db=db)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("refusing the prompt", p.stderr)
        con = sqlite3.connect(db)
        try:
            self.assertEqual(con.execute("SELECT count(*) FROM agent_tenant_context").fetchone()[0], 0)   # no fallback write either
        finally:
            con.close()

    def test_a_refused_connection_is_not_retried_and_fails_fast(self):
        p = self.prompt(CHAN % "111", url="http://127.0.0.1:%d" % free_closed_port())
        self.assertEqual(p.returncode, 2)
        self.assertLess(p.wall, 3.0)

    def test_a_failed_record_invalidates_then_serves(self):
        state = {"puts": 0}
        base = routing({("telegram", "111"): "tenant-x"}, serves={"tenant-x": True})

        def script(method, path, body):
            if path == CONTEXT:
                state["puts"] += 1
                if state["puts"] == 1:
                    return 403, {"error": "forbidden"}, 0   # the server refuses the bound record
            return base(method, path, body)
        d = self.serve(script)
        p = self.prompt(CHAN % "111", url=d.url)
        self.assertEqual(p.returncode, 0, p.stderr)
        last = d.calls(CONTEXT)[-1]["body"]
        self.assertEqual((last["status"], last["tenant_id"], last["source"]), ("unknown", "", "hook-error"))

    def test_record_and_invalidation_both_failing_refuses_the_prompt(self):
        d = self.serve(routing({("telegram", "111"): "tenant-x"}, serves={"tenant-x": True}, record_status=500))
        p = self.prompt(CHAN % "111", url=d.url)
        self.assertEqual(p.returncode, 2)
        self.assertIn("refusing the prompt", p.stderr)

    def test_a_plain_prompt_still_needs_the_record_to_go_through(self):
        p = self.prompt("typed in the terminal", url="http://127.0.0.1:%d" % free_closed_port())
        self.assertEqual(p.returncode, 2)   # no lookup was needed, but a stale previous tenant must not survive

    def test_a_dashboard_that_hangs_costs_less_than_the_deadline(self):
        d = self.serve(lambda m, p, b: (200, {}, 30))
        p = self.prompt(CHAN % "111", url=d.url)
        self.assertEqual(p.returncode, 2)
        self.assertLess(p.wall, 8.0, "the hook must finish inside the 10 s harness timeout with margin")

    def test_a_dashboard_error_answer_is_retried_once_a_4xx_is_not(self):
        d = self.serve(lambda m, p, b: (503, {}, 0))
        self.prompt("typed in the terminal", url=d.url)
        self.assertEqual(len(d.calls(CONTEXT)), 4)   # record: 2 attempts, invalidate: 2 attempts
        d.close()
        d = self.serve(lambda m, p, b: (400, {}, 0))
        self.prompt("typed in the terminal", url=d.url)
        self.assertEqual(len(d.calls(CONTEXT)), 2)   # one attempt each, deterministic answers are not asked twice

    def test_without_pg_mode_the_dashboard_is_not_asked(self):
        db = os.path.join(self.tmp.name, "t.db")
        con = sqlite3.connect(db)
        with open(os.path.join(ROOT, "src", "migrations", "0065_agent_tenant_context.sql")) as f:
            con.executescript(f.read())
        con.commit(); con.close()
        d = self.serve(routing())
        p = self.prompt("typed in the terminal", url=d.url, db=db, pg=False)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(d.log, [])


class TestRouteClient(unittest.TestCase):
    """hook_route.call counted in-process: a timing assertion cannot see an instant retry of a refused connection."""

    def setUp(self):
        import urllib.error
        import hook_route
        self.hr, self.ue = hook_route, urllib.error
        self.calls = 0
        self.orig = hook_route.dashboard_api.request
        hook_route.dashboard_api.request = self.fake

    def tearDown(self):
        self.hr.dashboard_api.request = self.orig

    def fake(self, *a, **kw):
        self.calls += 1
        raise self.error

    def call(self):
        return self.hr.call("POST", "/api/v1/hooks/x", {}, "agent-a", self.hr.Deadline())

    def test_refused_is_asked_once(self):
        self.error = self.ue.URLError(ConnectionRefusedError(61, "refused"))
        with self.assertRaises(self.hr.RouteError):
            self.call()
        self.assertEqual(self.calls, 1)

    def test_a_timeout_is_asked_twice_and_no_more(self):
        self.error = TimeoutError("timed out")
        with self.assertRaises(self.hr.RouteError):
            self.call()
        self.assertEqual(self.calls, 2)

    def test_an_exhausted_deadline_asks_nothing(self):
        self.error = TimeoutError("timed out")
        with self.assertRaises(self.hr.RouteError):
            self.hr.call("POST", "/x", {}, "agent-a", self.hr.Deadline(total=0.1))
        self.assertEqual(self.calls, 0)

    def test_the_error_text_carries_no_token_and_no_body(self):
        self.error = self.ue.HTTPError("http://x", 500, "secret-body-text", {}, None)
        with self.assertRaises(self.hr.RouteError) as cm:
            self.call()
        self.assertNotIn("secret-body-text", str(cm.exception))
        self.assertNotIn(TOKEN, str(cm.exception))


# ── tenant-skill-gate.py in PG mode ──────────────────────────────────────────────────────────────────

def gate_answer(ctx_status="bound", ctx_tenant="tenant-x", age=0, serves=True, skills=None, context=True):
    ctx = {"status": ctx_status, "tenant_id": ctx_tenant, "source": "test", "session_id": "s", "updated_at": int(time.time()) - age} if context else None
    return {"context": ctx, "serves": serves, "skills": skills if skills is not None else []}


OWN = {"id": "tenant-x-demo", "tenant_id": "tenant-x", "dir": "tenant-x-demo", "names": ["demo", "demo-skill", "tenant-x-demo"], "granted": []}
FOREIGN = {"id": "tenant-y-tool", "tenant_id": "*", "dir": "tenant-y-tool", "names": ["tool", "tenant-y-tool"], "granted": []}
SHARED = {"id": "tenant-y-shared", "tenant_id": "*", "dir": "tenant-y-shared", "names": ["shared", "tenant-y-shared"], "granted": ["tenant-x"]}


class TestSkillGatePg(Base):
    def answer(self, **kw):
        self.serve(lambda m, p, b: (200, gate_answer(**kw), 0))

    def blocked(self, tool, **inp):
        p = self.gate(tool, **inp)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("TENANT-SKILL-KAPU", p.stderr)
        return p.stderr

    def allowed(self, tool, **inp):
        p = self.gate(tool, **inp)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_owner_and_grantee_are_allowed_a_foreign_skill_is_blocked(self):
        self.answer(skills=[OWN, FOREIGN, SHARED])
        self.allowed("Skill", skill="tenant-x-demo")
        self.allowed("Skill", skill="tenant-y-shared")
        self.blocked("Skill", skill="tenant-y-tool")
        self.blocked("Read", file_path=SK + "tenant-y-tool/SKILL.md")
        self.allowed("Read", file_path=SK + "tenant-y-shared/SKILL.md")

    def test_one_call_carries_every_target_with_the_casefold_computed_by_the_hook(self):
        self.answer(skills=[OWN, FOREIGN])
        self.blocked("Bash", command="cat %sTenant-Y-Tool/SKILL.md; ls %sStra\u00dfe/x" % (SK, SK))
        calls = self.dash.calls(GATE)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["method"], "POST")
        self.assertEqual(calls[0]["auth"], "Bearer " + TOKEN)
        targets = {(t["kind"], t["value"]): t["folded"] for t in calls[0]["body"]["targets"]}
        self.assertEqual(targets[("dir", "Tenant-Y-Tool")], "tenant-y-tool")
        # Python casefold (sharp s -> ss), not str.lower() / toLowerCase, which keep the sharp s
        self.assertEqual(targets[("dir", "Straße")], "strasse")

    def test_a_case_variant_of_a_foreign_directory_is_blocked(self):
        self.answer(skills=[OWN, FOREIGN])
        self.blocked("Read", file_path=SK + "TENANT-Y-TOOL/SKILL.md")

    def test_no_context_unknown_conflict_stale_and_unserved_all_block(self):
        for kw in (dict(context=False), dict(ctx_status="unknown", ctx_tenant=""), dict(ctx_status="conflict", ctx_tenant=""),
                   dict(age=999999), dict(serves=False)):
            self.dash = None
            self.answer(skills=[OWN], **kw)
            self.blocked("Skill", skill="tenant-x-demo")
            self.dash.close()

    def test_a_call_that_cannot_involve_a_skill_asks_nothing(self):
        d = self.serve(lambda m, p, b: (500, {}, 0))
        self.allowed("Read", file_path=CWD + "/notes.md")
        self.allowed("Bash", command="ls /tmp")
        self.assertEqual(d.log, [])

    def test_a_fleet_skill_is_not_in_the_answer_and_is_allowed(self):
        self.answer(skills=[])
        self.allowed("Skill", skill="handoff")

    def test_every_route_failure_blocks_with_the_generic_gate_error(self):
        for script in (lambda m, p, b: (500, {"error": "x"}, 0), lambda m, p, b: (403, {"error": "forbidden"}, 0),
                       lambda m, p, b: (200, {"skills": "no"}, 0), lambda m, p, b: (200, None, 0)):
            d = self.serve(script)
            err = self.blocked("Skill", skill="tenant-x-demo")
            self.assertIn("BLOKKOL", err)
            d.close()
            self.dash = None

    def test_the_no_context_403_is_a_deny_for_a_skill_call_and_never_a_block_of_every_tool(self):
        # The dashboard answers a shared agent with no fresh tenant context 403 on skill-gate (the correct fail-closed answer; only the
        # two context-recording routes are exempt). The hook must read that as "this call cannot be cleared" for a call that names a
        # skill, FLEET skill included (the answer that would say it is a fleet skill is the one that did not come), and must not ask,
        # and so not block, a call that cannot involve a skill.
        d = self.serve(lambda m, p, b: (403, {"error": "forbidden", "hint": "No fresh tenant context for this shared agent"}, 0))
        for skill in ("tenant-x-demo", "handoff"):
            err = self.blocked("Skill", skill=skill)
            self.assertIn("BLOKKOL", err)
            self.assertNotIn("No fresh tenant context", err)  # the answer body is never echoed
        n = len(d.log)
        self.allowed("Read", file_path=CWD + "/notes.md")
        self.allowed("Bash", command="ls /tmp")
        self.allowed("Grep", pattern="x", path=CWD)
        self.assertEqual(len(d.log), n)  # no further call for the tools that cannot involve a skill

    def test_route_down_blocks_and_never_reads_sqlite(self):
        # a file that would ALLOW the call: the gate must not consult it in PG mode
        db = os.path.join(self.tmp.name, "live.db")
        con = sqlite3.connect(db)
        with open(os.path.join(ROOT, "src", "migrations", "0065_agent_tenant_context.sql")) as f:
            con.executescript(f.read())
        con.execute("CREATE TABLE skills (id TEXT, name TEXT, content TEXT, tenant_id TEXT)")
        con.commit(); con.close()
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "tenant-skill-gate.py")], capture_output=True, text=True,
                           input=json.dumps({"tool_name": "Skill", "tool_input": {"skill": "tenant-x-demo"}, "cwd": CWD}),
                           env=self.env(url="http://127.0.0.1:%d" % free_closed_port(), db=db))
        self.assertEqual(p.returncode, 2)
        self.assertIn("BLOKKOL", p.stderr)

    def test_a_dashboard_that_hangs_blocks_inside_the_deadline(self):
        self.serve(lambda m, p, b: (200, gate_answer(skills=[OWN]), 30))
        t0 = time.monotonic()
        self.blocked("Skill", skill="tenant-x-demo")
        self.assertLess(time.monotonic() - t0, 8.0)

    def test_the_masked_answer_decides_like_the_full_rows(self):
        """The server returns the caller's own tenant or '*' for an owner, and the caller's tenant or nothing for the
        grants. The decision of skill_accessible on that must equal the decision on the full rows, for each case."""
        full = [("owner", {"tenant_id": "tenant-x", "granted": set()}), ("grantee", {"tenant_id": "tenant-y", "granted": {"tenant-x", "tenant-z"}}),
                ("foreign", {"tenant_id": "tenant-y", "granted": {"tenant-z"}}), ("foreign-other-grant", {"tenant_id": "tenant-z", "granted": set()})]

        def mask(row, mine):
            return {"tenant_id": mine if mine is not None and row["tenant_id"] == mine else "*",
                    "granted": {mine} if mine is not None and mine in row["granted"] else set()}
        for mine in ("tenant-x", "default", None):
            for name, row in full:
                tenant = mine
                if tenant is None:
                    continue   # no context: usable_context returns None and the gate never calls skill_accessible
                self.assertEqual(tcl.skill_accessible(row, tenant), tcl.skill_accessible(mask(row, mine), tenant), "%s as %s" % (name, mine))

    def test_the_answer_shape_check_refuses_a_malformed_context(self):
        with self.assertRaises(tcl.FactsUnavailable):
            tcl.gate_facts_from_answer({"context": {"status": "bound"}, "serves": True, "skills": []})
        with self.assertRaises(tcl.FactsUnavailable):
            tcl.gate_facts_from_answer({"context": None, "serves": "yes", "skills": []})
        skills, ctx, serves = tcl.gate_facts_from_answer(gate_answer(skills=[OWN]))
        self.assertEqual((skills[0]["names"], ctx["tenant_id"], serves), ({"demo", "demo-skill", "tenant-x-demo"}, "tenant-x", True))


class TestFrontmatterNameLinear(unittest.TestCase):
    """_frontmatter_name reads a skill's `name:` in linear time and gives exactly what the regular expression it replaced gave.
    Mutant: put the old re.search back and the TIME cell is red (seconds)."""

    @staticmethod
    def legacy(content):
        m = tcl.FRONTMATTER_NAME_RX.match(content or "")
        if not m:
            return None
        import re
        nm = re.search(r'^name:\s*(.+?)\s*$', m.group(1), re.MULTILINE)
        return nm.group(1).strip().strip('"\'') if nm else None

    def test_fixed_cases_equal_the_old_expression(self):
        for text in ("---\nname: demo\n---\nx", '---\nname: "demo"\n---\n', "---\nname:\tdemo\t\n---\n", "---\nname:\n  demo\n---\n",
                     "---\nname:   \n---\n", "---\nname:\n---\n", "---\nname:\n\nname: second\n---\n", "---\nname: a\rb\n---\n",
                     "---\r\nname: demo\r\n---\r\n", "---\nname:  demo \n---\n", "---\n  name: no\n---\n", "no fence", ""):
            self.assertEqual(tcl._frontmatter_name(text), self.legacy(text), repr(text))

    def test_generated_texts_equal_the_old_expression(self):
        seed = [0x2545f491]

        def nxt(n):
            seed[0] = (seed[0] * 1103515245 + 12345) & 0xffffffff
            return seed[0] % n

        tokens = ["name:", "name:", "name: ", " ", " ", "  ", "\t", "\n", "\n", "\r", "\r\n", " ", " ", '"', "'", "a", "b",
                  "demo", "---", "\n---", "description:", "x y", ":"]
        for _ in range(30000):
            s = "" if nxt(4) == 0 else "---\n"
            for _ in range(nxt(14)):
                s += tokens[nxt(len(tokens))]
            if nxt(3) != 0:
                s += "\n---\ntail"
            self.assertEqual(tcl._frontmatter_name(s), self.legacy(s), repr(s))

    def test_the_slow_shape_is_fast(self):
        n = 200000
        for text in ("---\nname: x" + " " * n + "y\n---\n", "---\nname: x" + "\t" * n + "y\n---\n", "---\nname:" + " " * n + "\n---\n",
                     "---\n" + ("name: a" + " " * 50 + "b\n") * 4000 + "---\n", "---\n" + "name:\n" * (n // 6) + "---\n"):
            t0 = time.monotonic()
            tcl._frontmatter_name(text)
            self.assertLess(time.monotonic() - t0, 0.5)


if __name__ == "__main__":
    unittest.main()
