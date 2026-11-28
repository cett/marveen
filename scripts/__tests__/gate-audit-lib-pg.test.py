#!/usr/bin/env python3
"""Tests for the PostgreSQL mode of scripts/hooks/gate_audit_lib.py (the decision counts and deny rows of the PreToolUse gates).

In PG mode the frozen SQLite file is never written: the gate sends ONE request (POST /api/v1/hooks/gate-audit) under a short
deadline, one attempt, and a deny that cannot be delivered waits in a bounded spool (store/.gate-audit-spool/<agent>.jsonl) for the
next successful call; an allow is a statistic and is aggregated in a counts file, sent at most once per minute. A stub HTTP server
plays the dashboard. The differential against the REAL TypeScript route is src/__tests__/hooks-gate-audit-python-differential.test.ts.

The rules these cells pin (each names the mutant a removed guard gives; the QA gates run them):
  - a deny is spooled, not dropped, when the route fails          -> test_a_failed_call_spools_the_deny (mutant a)
  - the verdict, exit status and stderr never change              -> test_audited_keeps_the_exit_status_and_stderr_when_the_route_fails (mutant b)
  - the drain deletes only after the route acknowledged           -> test_a_failing_drain_puts_everything_back (mutant g)
  - one acknowledged call, the spool then empty, no duplicates    -> test_the_drain_after_recovery_sends_the_spooled_deny_once
  - a torn or forged spool line cannot stop or poison a drain     -> test_torn_and_forged_lines_are_dropped_and_do_not_stop_the_drain
  - the spool is bounded; the batch fits the route's caps         -> test_a_full_spool_drops_the_new_entry..., test_the_drain_batch_fits_the_route_caps
  - no trusted agent -> no token -> nothing is filed              -> test_an_unattributed_process_files_nothing
  - the whole write stays inside the alarm budget                 -> test_a_slow_route_stays_inside_the_budget
Neutral fixtures only (agent-a, agent-b).

Run: python3 <thisfile>
"""
import importlib.util
import io
import json
import os
import shutil
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
# isolated copy of the hooks (empty store, no PG marker): PR 959 test-only isolation, see pg_install_isolation.py
from pg_install_isolation import isolated_hooks_dir, isolated_install_root  # noqa: E402
HOOKS = isolated_hooks_dir()
ROUTE = "/api/v1/hooks/gate-audit"
TOKEN = "test-token-agent-a"

sys.path.insert(0, HOOKS)
_spec = importlib.util.spec_from_file_location("gate_audit_lib_pg_under_test", os.path.join(HOOKS, "gate_audit_lib.py"))
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)


class Dashboard:
    """A stub of the dashboard. `script(n, body)` -> (status, json-able or raw bytes, delay_seconds); n counts requests from 1."""

    def __init__(self, script=None):
        self.script = script or (lambda n, body: (200, {"ok": True, "counts": len(body.get("counts", [])), "denies": len(body.get("denies", []))}, 0))
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
                status, payload, delay = outer.script(len(outer.log), body)
                if delay:
                    time.sleep(delay)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def closed_port_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return "http://127.0.0.1:%d" % port


ENV_KEYS = ("MARVEEN_PG_CONFIGURED", "MARVEEN_PG_URL", "SECRET_MOUNT_DIR", "CLAUDECLAW_ENV_DIR", "DASHBOARD_BASE_URL", "LEDGER_DB_PATH",
            "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR", "MARVEEN_AGENT_TOKEN_FILE", "MARVEEN_AGENT_ID", "WEB_PORT")


class PgModeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="gate-audit-pg-")
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        token = os.path.join(self.tmp, "token")
        with open(token, "w") as fh:
            fh.write(TOKEN)
        os.environ.update({
            "MARVEEN_PG_CONFIGURED": "1",                       # pg_mode(): the marker (no .env in the test root, no secret mount)
            "SECRET_MOUNT_DIR": os.path.join(self.tmp, "no-secrets"),
            "CLAUDECLAW_ENV_DIR": self.tmp,                      # an empty directory: no .env
            "LEDGER_DB_PATH": os.path.join(self.tmp, "store", "claudeclaw.db"),  # the store directory (the spool lives next to it)
            "CLAUDE_CONFIG_DIR": os.path.join(isolated_install_root(), "agents", "agent-a", ".claude-config"),  # PR 959: under the isolated root
            "MARVEEN_AGENT_TOKEN_FILE": token,
        })
        self.dash = None
        self.spool_dir = os.path.join(self.tmp, "store", ".gate-audit-spool")
        self.spool = os.path.join(self.spool_dir, "agent-a.jsonl")
        self.counts = os.path.join(self.spool_dir, "agent-a.counts")
        self.stamp = os.path.join(self.spool_dir, "agent-a.stamp")

    def tearDown(self):
        if self.dash:
            self.dash.close()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers -------------------------------------------------------------------------------------------------------
    def serve(self, script=None):
        self.dash = Dashboard(script)
        os.environ["DASHBOARD_BASE_URL"] = self.dash.url
        return self.dash

    def down(self):
        os.environ["DASHBOARD_BASE_URL"] = closed_port_url()

    def lines(self, path):
        try:
            with open(path) as fh:
                return [json.loads(ln) for ln in fh.read().split("\n") if ln.strip()]
        except FileNotFoundError:
            return []

    def put(self, path, entries, raw=None):
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "a") as fh:
            for e in entries:
                fh.write(json.dumps(e) + "\n")
            if raw:
                fh.write(raw)

    def entry(self, gate="destructive-gate", reason="denied", row=True, ts=None, trace_id=None):
        return {"gate": gate, "reason": reason, "ts": ts or int(time.time()), "trace_id": trace_id, "row": row}

    def age_stamp(self, seconds=120):
        old = time.time() - seconds
        os.utime(self.stamp, (old, old))

    def deny(self, gate="destructive-gate", reason="denied", deny_row=True, session=None):
        return lib.record(gate, "deny", reason, agent_id="agent-a", deny_row=deny_row, session_id=session)


class TestDeliver(PgModeCase):
    def test_a_deny_is_one_acknowledged_call_with_the_token_agent_and_leaves_nothing_behind(self):
        d = self.serve()
        self.assertTrue(self.deny("tenant-skill-gate", "denied", session="sess-1234"))
        self.assertEqual(len(d.log), 1)
        call = d.log[0]
        self.assertEqual(call["path"], ROUTE)
        self.assertEqual(call["auth"], "Bearer " + TOKEN)
        self.assertEqual(call["agent"], "agent-a")
        self.assertEqual(call["body"]["counts"], [{"gate": "tenant-skill-gate", "decision": "deny", "reason": "denied", "n": 1}])
        self.assertEqual(len(call["body"]["denies"]), 1)
        self.assertEqual({k: v for k, v in call["body"]["denies"][0].items() if k != "ts"},
                         {"gate": "tenant-skill-gate", "reason": "denied", "trace_id": "sess-1234"})
        self.assertEqual(self.lines(self.spool), [])
        self.assertFalse(os.path.exists(self.spool) and os.path.getsize(self.spool) > 0)

    def test_a_gate_that_posts_its_own_row_sends_the_count_only(self):
        d = self.serve()
        self.assertTrue(self.deny("destructive-gate", "denied", deny_row=False))
        self.assertEqual(d.log[0]["body"], {"counts": [{"gate": "destructive-gate", "decision": "deny", "reason": "denied", "n": 1}], "denies": []})

    def test_the_session_id_is_cleaned_before_it_leaves(self):
        d = self.serve()
        self.deny(session="w3c-abcdef")
        self.assertNotIn("trace_id", d.log[0]["body"]["denies"][0])
        self.deny(session="has spaces and\nnewline")
        self.assertNotIn("trace_id", d.log[1]["body"]["denies"][0])

    def test_the_body_carries_the_fixed_fields_only(self):
        d = self.serve()
        self.deny(session="sess-1")
        lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        allowed_top = {"counts", "denies"}
        for call in d.log:
            self.assertEqual(set(call["body"]), allowed_top)
            for c in call["body"]["counts"]:
                self.assertEqual(set(c), {"gate", "decision", "reason", "n"})
            for r in call["body"]["denies"]:
                self.assertLessEqual(set(r), {"gate", "reason", "ts", "trace_id"})

    def test_an_allow_is_a_file_append_not_a_call_and_the_first_one_flushes(self):
        d = self.serve()
        self.assertTrue(lib.record("destructive-gate", "allow", "", agent_id="agent-a"))  # no stamp yet: flushes at once
        self.assertEqual(len(d.log), 1)
        self.assertEqual(d.log[0]["body"], {"counts": [{"gate": "destructive-gate", "decision": "allow", "reason": "", "n": 1}], "denies": []})
        for _ in range(3):
            self.assertFalse(lib.record("destructive-gate", "allow", "", agent_id="agent-a"))  # inside the minute: appended only
        self.assertEqual(len(d.log), 1)
        self.assertEqual(sum(e["n"] for e in self.lines(self.counts)), 3)

    def test_the_counts_are_aggregated_into_one_call_after_the_interval(self):
        d = self.serve()
        lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        for _ in range(3):
            lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        lib.record("secret-read-gate", "error", "gate_error", agent_id="agent-a")
        self.age_stamp()
        lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        self.assertEqual(len(d.log), 2)
        self.assertEqual(sorted((c["gate"], c["decision"], c["reason"], c["n"]) for c in d.log[1]["body"]["counts"]),
                         [("destructive-gate", "allow", "", 4), ("secret-read-gate", "error", "gate_error", 1)])
        self.assertEqual(self.lines(self.counts), [])

    def test_a_deny_call_carries_the_waiting_counts_too(self):
        d = self.serve()
        lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        for _ in range(2):
            lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        self.deny()
        self.assertEqual(len(d.log), 2)
        self.assertEqual(sorted((c["decision"], c["n"]) for c in d.log[1]["body"]["counts"]), [("allow", 2), ("deny", 1)])


class TestFailure(PgModeCase):
    FAILURES = {
        "refused": None,
        "5xx": (503, {"error": "x"}, 0),
        "4xx": (403, {"error": "forbidden"}, 0),
        "bad json": (200, b"<html>not json</html>", 0),
        "not acknowledged": (200, {"ok": True, "counts": 0, "denies": 0}, 0),
        "ok false": (200, {"ok": False}, 0),
        "null answer": (200, b"null", 0),
    }

    def failing(self, name):
        if self.FAILURES[name] is None:
            self.down()
        else:
            reply = self.FAILURES[name]
            self.serve(lambda n, body: reply)

    def test_a_failed_call_spools_the_deny(self):
        for name in self.FAILURES:
            with self.subTest(failure=name):
                shutil.rmtree(self.spool_dir, ignore_errors=True)
                self.failing(name)
                started = time.monotonic()
                self.assertFalse(self.deny("tenant-skill-gate", "denied", session="sess-9"))
                self.assertLess(time.monotonic() - started, 1.2)
                spooled = self.lines(self.spool)
                self.assertEqual(len(spooled), 1, name)
                self.assertEqual({k: v for k, v in spooled[0].items() if k != "ts"},
                                 {"gate": "tenant-skill-gate", "reason": "denied", "trace_id": "sess-9", "row": True})
                if self.dash:
                    self.dash.close()
                    self.dash = None

    def test_a_count_only_deny_is_spooled_too_with_row_false(self):
        self.down()
        self.deny(deny_row=False)
        self.assertEqual([e["row"] for e in self.lines(self.spool)], [False])

    def test_a_forged_allow_count_with_a_reason_cannot_stop_the_counts_from_being_delivered(self):
        # The route refuses a count whose decision is allow and whose reason is not empty, and ONE such entry makes the WHOLE
        # request a 400. A forged counts line is as possible as a forged spool line (same file, same OS user), so the hook
        # drops it (_valid_count) and the real counts go through. The stub applies the route's rule.
        def route_like(n, body):
            if any(c["decision"] == "allow" and c["reason"] != "" for c in body["counts"]):
                return 400, {"error": "invalid_value"}, 0
            return 200, {"ok": True, "counts": len(body["counts"]), "denies": len(body["denies"])}, 0

        self.put(self.counts, [{"gate": "destructive-gate", "decision": "allow", "reason": "denied", "n": 5},
                               {"gate": "destructive-gate", "decision": "allow", "reason": "", "n": 3},
                               {"gate": "secret-read-gate", "decision": "deny", "reason": "", "n": 2}])  # deny with no reason: also invalid
        d = self.serve(route_like)
        self.assertTrue(self.deny("tenant-skill-gate"))  # acknowledged: no forged entry reached the route
        sent = sorted((c["gate"], c["decision"], c["reason"], c["n"]) for call in d.log for c in call["body"]["counts"])
        self.assertEqual(sent, [("destructive-gate", "allow", "", 3), ("tenant-skill-gate", "deny", "denied", 1)])
        self.assertEqual(self.lines(self.counts), [])

    def test_the_own_deny_is_spooled_before_the_counts_are_put_back(self):
        # An alarm (SIGALRM) landing inside the put-back must cost a count at most, never this call's own deny: the evidence is
        # spooled FIRST. The put-back is made to blow up (as the alarm would), and the deny is already in the spool.
        self.down()
        lib.record("destructive-gate", "allow", "", agent_id="agent-a")  # a waiting count, so there is something to put back
        real = lib._append_entries

        def boom(path, entries, cap):
            if path == self.counts:
                raise KeyboardInterrupt("the alarm, inside the counts put-back")
            return real(path, entries, cap)

        lib._append_entries = boom
        try:
            with self.assertRaises(BaseException):
                lib._send_pending("agent-a", time.monotonic(), {"gate": "tenant-skill-gate", "reason": "denied", "ts": int(time.time()), "trace_id": None, "row": True})
        finally:
            lib._append_entries = real
        self.assertEqual([e["gate"] for e in self.lines(self.spool)], ["tenant-skill-gate"])

    def test_a_recovery_that_blows_up_still_spools_the_own_deny(self):
        # the stale-claim recovery is statistics maintenance: whatever it raises (the alarm included), this call's own deny
        # is already on its way to the spool, never lost before anything was written
        self.down()
        real = lib._recover_stale_claims

        def boom(path, cap):
            raise KeyboardInterrupt("the alarm, inside the recovery")

        lib._recover_stale_claims = boom
        try:
            with self.assertRaises(BaseException):
                lib._send_pending("agent-a", time.monotonic(), {"gate": "tenant-skill-gate", "reason": "denied", "ts": int(time.time()), "trace_id": None, "row": True})
        finally:
            lib._recover_stale_claims = real
        self.assertEqual([e["gate"] for e in self.lines(self.spool)], ["tenant-skill-gate"])

    def test_an_orphaned_counts_claim_of_a_dead_process_is_taken_back_and_a_fresh_one_is_left_alone(self):
        stale = self.counts + ".4242.flushing"
        fresh = self.counts + ".4343.flushing"
        self.put(stale, [{"gate": "destructive-gate", "decision": "allow", "reason": "", "n": 7}])
        self.put(fresh, [{"gate": "destructive-gate", "decision": "allow", "reason": "", "n": 100}])
        old = time.time() - lib.STALE_CLAIM_S - 60
        os.utime(stale, (old, old))
        d = self.serve()
        self.assertTrue(self.deny("tenant-skill-gate"))
        sent = {}
        for call in d.log:
            for c in call["body"]["counts"]:
                sent[c["decision"]] = sent.get(c["decision"], 0) + c["n"]
        self.assertEqual(sent, {"allow": 7, "deny": 1})  # the dead claim's 7 are counted once; the live process's 100 are not touched
        self.assertTrue(os.path.exists(fresh))
        self.assertFalse(os.path.exists(stale))

    def test_an_allow_is_not_spooled_and_the_count_waits_in_the_counts_file(self):
        self.down()
        self.assertFalse(lib.record("destructive-gate", "allow", "", agent_id="agent-a"))
        self.assertEqual(self.lines(self.spool), [])  # an allow is a statistic, never spooled as evidence
        self.assertEqual([(e["decision"], e["n"]) for e in self.lines(self.counts)], [("allow", 1)])

    def test_the_counts_come_back_after_a_failed_send_without_double_counting(self):
        self.down()
        lib.record("destructive-gate", "allow", "", agent_id="agent-a")  # stamp missing: tries, fails, puts the count back
        for _ in range(2):
            lib.record("destructive-gate", "allow", "", agent_id="agent-a")
        self.deny()
        d = self.serve()
        self.deny()  # recovery
        sent = {}
        for call in d.log:
            for c in call["body"]["counts"]:
                sent[(c["decision"])] = sent.get(c["decision"], 0) + c["n"]
        self.assertEqual(sent, {"allow": 3, "deny": 2})

    def test_a_slow_route_stays_inside_the_budget(self):
        self.serve(lambda n, body: (200, {"ok": True, "counts": 1, "denies": 1}, 5))
        started = time.monotonic()
        self.assertFalse(self.deny())
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, lib.WRITE_BUDGET_S + 0.6, "took %.2f s" % elapsed)
        self.assertEqual(len(self.lines(self.spool)), 1)  # the deny waits for the next call

    def test_the_gate_is_never_told_about_any_of_it(self):
        # record() never raises, whatever the state of the spool directory
        os.makedirs(self.spool_dir, mode=0o700)
        os.chmod(self.spool_dir, 0)
        try:
            self.down()
            self.assertFalse(self.deny())
        finally:
            os.chmod(self.spool_dir, stat.S_IRWXU)

    def test_audited_keeps_the_exit_status_and_stderr_when_the_route_fails(self):
        for name in ("refused", "5xx", "bad json"):
            for code in (0, 2, 1):
                with self.subTest(failure=name, code=code):
                    shutil.rmtree(self.spool_dir, ignore_errors=True)
                    self.failing(name)
                    buf = io.StringIO()

                    def gate():
                        sys.stderr.write("the gate's own message\n")
                        sys.exit(code)

                    with redirect_stderr(buf):
                        with self.assertRaises(SystemExit) as caught:
                            lib.audited("destructive-gate", gate, deny_row=True)
                    self.assertEqual(caught.exception.code, code)
                    self.assertEqual(buf.getvalue(), "the gate's own message\n")
                    if self.dash:
                        self.dash.close()
                        self.dash = None


class TestDrain(PgModeCase):
    def test_the_drain_after_recovery_sends_the_spooled_deny_once(self):
        self.down()
        self.deny("tenant-skill-gate", "denied", session="sess-old")
        self.assertEqual(len(self.lines(self.spool)), 1)
        d = self.serve()
        self.assertTrue(self.deny("destructive-gate"))
        self.assertEqual(len(d.log), 2)  # the call itself, then ONE drain call
        drained = d.log[1]["body"]
        self.assertEqual(drained["counts"], [{"gate": "tenant-skill-gate", "decision": "deny", "reason": "denied", "n": 1}])
        self.assertEqual([(r["gate"], r["trace_id"]) for r in drained["denies"]], [("tenant-skill-gate", "sess-old")])
        self.assertEqual(self.lines(self.spool), [])
        self.assertTrue(self.deny("destructive-gate"))
        self.assertEqual(len(d.log), 3)  # nothing left to drain: no duplicate of the old deny
        self.assertEqual(len(d.log[2]["body"]["denies"]), 1)

    def test_a_count_only_entry_drains_as_a_count_without_a_row(self):
        self.put(self.spool, [self.entry("secret-read-gate", "denied", row=False)])
        d = self.serve()
        self.deny()
        self.assertEqual(d.log[1]["body"], {"counts": [{"gate": "secret-read-gate", "decision": "deny", "reason": "denied", "n": 1}], "denies": []})

    def test_a_failing_drain_puts_everything_back(self):
        self.put(self.spool, [self.entry("tenant-skill-gate"), self.entry("secret-read-gate")])
        self.serve(lambda n, body: (200, {"ok": True, "counts": len(body["counts"]), "denies": len(body["denies"])}) + (0,) if n == 1 else (500, {}, 0))
        self.assertTrue(self.deny())  # the call itself is acknowledged; the drain call fails
        self.assertEqual(sorted(e["gate"] for e in self.lines(self.spool)), ["secret-read-gate", "tenant-skill-gate"])
        self.assertEqual([f for f in os.listdir(self.spool_dir) if f.endswith(".flushing")], [])  # the claim is released

    def test_a_dead_route_at_the_drain_keeps_the_entries_even_through_an_alarm(self):
        # an interrupt (the alarm of the budget) in the middle of the drain call must put the claimed lines back as well
        self.put(self.spool, [self.entry("tenant-skill-gate")])
        self.serve(lambda n, body: (200, {"ok": True, "counts": len(body["counts"]), "denies": len(body["denies"])}, 0) if n == 1 else (200, {}, 3))
        started = time.monotonic()
        lib.record("destructive-gate", "deny", "denied", agent_id="agent-a", deny_row=True)
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertEqual([e["gate"] for e in self.lines(self.spool)], ["tenant-skill-gate"])

    def test_torn_and_forged_lines_are_dropped_and_do_not_stop_the_drain(self):
        good = self.entry("tenant-skill-gate", trace_id="sess-ok")
        forged = [
            {"gate": "not-a-gate", "reason": "denied", "ts": 1, "row": True},
            {"gate": ["list"], "reason": "denied", "ts": 1, "row": True},          # unhashable: must not raise
            {"gate": {"a": 1}, "reason": {"b": 2}, "ts": 1, "row": True},
            {"gate": "destructive-gate", "reason": "because the command rm -rf was bad", "ts": 1, "row": True},
            {"gate": "destructive-gate", "reason": "denied", "ts": "123", "row": True},
            {"gate": "destructive-gate", "reason": "denied", "ts": True, "row": True},
            {"gate": "destructive-gate", "reason": "denied", "ts": 1, "row": "yes"},
            {"gate": "destructive-gate", "reason": "denied", "ts": 1, "row": True, "trace_id": "w3c-abc"},
            {"gate": "destructive-gate", "reason": "denied", "ts": 1, "row": True, "trace_id": ["x"]},
        ]
        self.put(self.spool, [good] + forged, raw='{"gate": "destructive-gate", "reas')  # the last line is torn
        d = self.serve()
        self.deny("outgoing-copy-gate")
        drained = d.log[1]["body"]
        self.assertEqual([(r["gate"], r.get("trace_id")) for r in drained["denies"]], [("tenant-skill-gate", "sess-ok")])
        self.assertEqual(self.lines(self.spool), [])

    @staticmethod
    def route_like(n, body):
        """The real route's atomic rule for a ts: JSON.parse reads a 310-digit integer as Infinity, which is not Number.isInteger,
        and ONE such row makes the WHOLE batch a 400 (nothing written)."""
        for d in body.get("denies", []):
            try:
                if not isinstance(d["ts"], int) or float(d["ts"]) in (float("inf"), float("-inf")):
                    return 400, {"error": "invalid_value"}, 0
            except OverflowError:
                return 400, {"error": "invalid_value"}, 0
        return 200, {"ok": True, "counts": len(body["counts"]), "denies": len(body["denies"])}, 0

    def test_a_forged_line_with_a_huge_ts_cannot_stop_the_drain_of_the_real_denies(self):
        # valid for a Python int, Infinity for JSON.parse: kept, it would head every batch, every drain would be a 400 and the
        # spool would fill until every real deny is dropped as spool_full (the same file, the same OS user, can forge it)
        good = self.entry("tenant-skill-gate", trace_id="sess-real")
        forged = [self.entry(ts=10 ** 400), self.entry(ts=-1), self.entry(ts=2 ** 53), self.entry(ts=2 ** 53 + 1)]
        self.put(self.spool, forged + [good])
        d = self.serve(self.route_like)
        self.assertTrue(self.deny("destructive-gate"))
        self.assertEqual(len(d.log), 2)
        drained = d.log[1]["body"]
        self.assertEqual([(r["gate"], r.get("trace_id")) for r in drained["denies"]], [("tenant-skill-gate", "sess-real")])
        self.assertEqual(self.lines(self.spool), [])  # delivered AND the forged lines are gone, not put back to head the next batch

    def test_the_ts_range_edges_are_kept(self):
        # 0 and the largest exactly-representable second are valid: the rule is a range, not "positive and small"
        low = {"gate": "tenant-skill-gate", "reason": "denied", "ts": 0, "trace_id": None, "row": True}
        high = {"gate": "secret-read-gate", "reason": "denied", "ts": 2 ** 53 - 1, "trace_id": None, "row": True}
        self.put(self.spool, [low, high])
        d = self.serve(self.route_like)
        self.deny("destructive-gate")
        self.assertEqual(sorted((r["gate"], r["ts"]) for r in d.log[1]["body"]["denies"]),
                         [("secret-read-gate", 2 ** 53 - 1), ("tenant-skill-gate", 0)])
        self.assertEqual(self.lines(self.spool), [])

    def test_the_drain_batch_fits_the_route_caps(self):
        self.put(self.spool, [self.entry(ts=1000 + i) for i in range(120)])
        d = self.serve()
        self.deny()
        self.assertEqual(len(d.log[1]["body"]["denies"]), lib.DRAIN_BATCH)
        self.assertEqual(len(self.lines(self.spool)), 120 - lib.DRAIN_BATCH)
        self.assertEqual(lib.DRAIN_BATCH, 50)

    def test_the_count_keys_of_one_call_never_exceed_the_route_cap(self):
        gates = sorted(lib.GATES)
        reasons = sorted(lib.REASONS)
        self.put(self.spool, [self.entry(g, r) for g in gates for r in reasons])  # 28 distinct keys
        d = self.serve()
        self.deny()
        for call in d.log:
            self.assertLessEqual(len(call["body"]["counts"]), lib.MAX_COUNT_KEYS)
        self.assertGreater(len(self.lines(self.spool)), 0)  # the rest waits for the next call
        for _ in range(4):
            self.deny()
        self.assertEqual(self.lines(self.spool), [])

    def test_a_full_spool_drops_the_new_entry_and_says_so_once(self):
        self.put(self.spool, [self.entry(ts=1000 + i) for i in range(lib.SPOOL_MAX_ENTRIES)])
        self.down()
        buf = io.StringIO()
        with redirect_stderr(buf):
            self.deny("secret-read-gate")
        self.assertEqual(len(self.lines(self.spool)), lib.SPOOL_MAX_ENTRIES)
        self.assertNotIn("secret-read-gate", [e["gate"] for e in self.lines(self.spool)])  # the NEW entry was dropped, append-only
        self.assertEqual(buf.getvalue().count("spool_full"), 1)

    def test_a_stale_claim_of_a_dead_process_is_taken_back_and_a_fresh_one_is_left_alone(self):
        stale = self.spool + ".4242.flushing"
        fresh = self.spool + ".4343.flushing"
        self.put(stale, [self.entry("tenant-skill-gate", trace_id="sess-stale")])
        self.put(fresh, [self.entry("secret-read-gate", trace_id="sess-fresh")])
        old = time.time() - lib.STALE_CLAIM_S - 60
        os.utime(stale, (old, old))
        d = self.serve()
        self.deny()
        sent = [r["gate"] for call in d.log for r in call["body"]["denies"]]
        self.assertIn("tenant-skill-gate", sent)
        self.assertNotIn("secret-read-gate", sent)
        self.assertTrue(os.path.exists(fresh))
        self.assertFalse(os.path.exists(stale))


class TestWho(PgModeCase):
    def test_an_unattributed_process_files_nothing(self):
        os.environ.pop("CLAUDE_CONFIG_DIR")
        d = self.serve()
        self.assertFalse(lib.record("destructive-gate", "deny", "denied", agent_id=None, deny_row=True))
        self.assertFalse(lib.record("destructive-gate", "allow", "", agent_id=None))
        self.assertEqual(d.log, [])
        self.assertFalse(os.path.exists(self.spool_dir))

    def test_audited_presents_the_trusted_agent_not_one_picked_from_the_event(self):
        d = self.serve()

        def gate():
            lib.note_event({"session_id": "sess-1", "cwd": os.path.join(ROOT, "agents", "agent-b")})
            sys.exit(2)

        with self.assertRaises(SystemExit):
            lib.audited("destructive-gate", gate, deny_row=True)
        self.assertEqual(d.log[0]["agent"], "agent-a")
        self.assertEqual(d.log[0]["auth"], "Bearer " + TOKEN)

    def test_a_hostile_agent_id_cannot_leave_the_spool_directory(self):
        self.down()
        lib.record("destructive-gate", "deny", "denied", agent_id="../../escape", deny_row=True)
        files = os.listdir(self.spool_dir)
        self.assertEqual(len(files), 1)
        self.assertNotIn("/", files[0])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "escape.jsonl")))

    def test_the_spool_is_private_to_the_os_user(self):
        self.down()
        self.deny()
        self.assertEqual(stat.S_IMODE(os.stat(self.spool_dir).st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.spool).st_mode) & 0o077, 0)

    def test_the_files_hold_only_the_fixed_fields(self):
        self.down()
        lib.note_event({"session_id": "sess-1", "command": "SENTINEL-must-not-be-stored", "path": "/SENTINEL/path"})
        lib.record("email-approval-gate", "deny", "denied", agent_id="agent-a", deny_row=True, session_id=lib._noted_session)
        lib.record("email-approval-gate", "allow", "", agent_id="agent-a")
        for path in (self.spool, self.counts):
            with open(path) as fh:
                self.assertNotIn("SENTINEL", fh.read())
        for e in self.lines(self.spool):
            self.assertEqual(set(e), {"gate", "reason", "ts", "trace_id", "row"})
        for e in self.lines(self.counts):
            self.assertEqual(set(e), {"gate", "decision", "reason", "n"})


class TestSpoolNameParity(unittest.TestCase):
    """The spool directory name is a literal in three places: SPOOL_DIR_NAME here and the SPOOL_DIR_RE of the two gates. If the
    library renames the directory, both gates would silently stop protecting it while their own tests (written with their own
    literal) stay green. This cell ties them: the path the library builds is matched by BOTH gates' patterns."""

    @staticmethod
    def load(filename, name):
        spec = importlib.util.spec_from_file_location(name, os.path.join(HOOKS, filename))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_both_gates_match_the_directory_the_library_writes(self):
        path = os.path.join("/x", "store", lib.SPOOL_DIR_NAME, "agent-a.jsonl")
        for filename, name in (("destructive-gate.py", "destructive_gate_parity"), ("auth-admin-gate.py", "auth_admin_gate_parity")):
            with self.subTest(gate=filename):
                self.assertIsNotNone(self.load(filename, name).SPOOL_DIR_RE.search(path), "%s does not match %s" % (filename, path))

    def test_a_directory_with_another_name_is_not_matched(self):
        # the cell above is not vacuous: the patterns do discriminate
        other = os.path.join("/x", "store", ".ledger-spool", "agent-a.jsonl")
        for filename, name in (("destructive-gate.py", "destructive_gate_parity2"), ("auth-admin-gate.py", "auth_admin_gate_parity2")):
            with self.subTest(gate=filename):
                self.assertIsNone(self.load(filename, name).SPOOL_DIR_RE.search(other))


class TestMode(PgModeCase):
    def test_an_explicit_db_path_is_the_sqlite_writer_and_makes_no_call(self):
        d = self.serve()
        # no database there: the SQLite writer fails silently, and the point is that nothing went to the dashboard
        self.assertFalse(lib.record("destructive-gate", "deny", "denied", agent_id="agent-a", deny_row=True, db_path=os.path.join(self.tmp, "none.db")))
        self.assertEqual(d.log, [])
        self.assertFalse(os.path.exists(self.spool_dir))

    def test_a_sqlite_install_never_touches_the_route_or_the_spool(self):
        os.environ.pop("MARVEEN_PG_CONFIGURED")
        d = self.serve()
        lib.record("destructive-gate", "deny", "denied", agent_id="agent-a", deny_row=True)
        self.assertEqual(d.log, [])
        self.assertFalse(os.path.exists(self.spool_dir))


if __name__ == "__main__":
    unittest.main()
