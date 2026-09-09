#!/usr/bin/env python3
"""Unit tests for scripts/hooks/context-watchdog.py (context watchdog phases
2+3).

Covers the pure-logic helpers (context_tokens, latest_usage_event,
resolve_tenant, build_handoff) directly, and main()'s exit-code + stdout
contract via subprocess -- always exit 0 (logging-category, fail-open, unlike
post-tool-injection-gate.py), with a `hookSpecificOutput.additionalContext`
HANDOFF only once the context-token estimate crosses CONTEXT_PCT_THRESHOLD.

Every test runs against a temp SQLite DB (LEDGER_DB_PATH override, same seam
ledger_lib.py already exposes) and temp gate-config/compact-state JSON files
(CONTEXT_WATCHDOG_GATE_CONFIG / CONTEXT_WATCHDOG_COMPACT_STATE overrides) --
never the real store/claudeclaw.db or store/context-*.json.

Privacy: only neutral fixture data; no real agent names, tokens, or chat IDs.
"""
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

_HOOKS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")
_HOOK_PATH = os.path.join(_HOOKS_DIR, "context-watchdog.py")
# Mirrors ledger_lib._install_dir(): two levels up from scripts/hooks/.
_INSTALL_DIR = os.path.dirname(os.path.dirname(_HOOKS_DIR))

_spec = importlib.util.spec_from_file_location("context_watchdog", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

MAIN_AGENT = "mainbot-test"


def _make_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent TEXT NOT NULL,
          session_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          content_preview TEXT,
          tool_name TEXT,
          thinking_tokens INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          tenant_id TEXT NOT NULL DEFAULT 'default'
        );
        CREATE UNIQUE INDEX idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);

        CREATE TABLE tenant_agent_availability (
          tenant_id  TEXT NOT NULL,
          agent_id   TEXT NOT NULL,
          enabled    INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (tenant_id, agent_id)
        );

        CREATE TABLE fleet_blackboard (
          id         TEXT PRIMARY KEY,
          agent_id   TEXT NOT NULL UNIQUE,
          task_ref   TEXT,
          status     TEXT NOT NULL DEFAULT 'active',
          summary    TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'planned',
          assignee TEXT,
          updated_at INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER
        );

        CREATE TABLE agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE hook_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          agent_id TEXT,
          hook_type TEXT NOT NULL,
          verdict TEXT NOT NULL,
          tool_name TEXT,
          content_hash TEXT,
          reason TEXT,
          session_id TEXT,
          trigger_source TEXT
        );
        """
    )
    conn.commit()
    return conn


def _write_jsonl(path, events):
    with open(path, "w", encoding="utf-8") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def _usage_event(input_tokens=1000, output_tokens=50, cache_read=0, cache_creation=0,
                  ts="2026-09-08T10:00:00.000Z", text="hello"):
    return {
        "type": "assistant",
        "timestamp": ts,
        "sessionId": "sess-1",
        "message": {
            "id": "msg_1",
            "model": "claude-test-model",
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_creation,
            },
            "content": [{"type": "text", "text": text}],
        },
    }


class TestContextTokens(unittest.TestCase):
    def test_sums_input_and_cache_not_output(self):
        usage = {"input_tokens": 100, "output_tokens": 9999, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 5}
        self.assertEqual(hook.context_tokens(usage), 125)

    def test_missing_fields_default_zero(self):
        self.assertEqual(hook.context_tokens({}), 0)


class TestLatestUsageEvent(unittest.TestCase):
    def test_returns_last_usage_bearing_line(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.jsonl")
            _write_jsonl(path, [
                _usage_event(input_tokens=100, text="first"),
                {"type": "user", "message": {"content": "no usage here"}},
                _usage_event(input_tokens=200, text="last"),
            ])
            ev = hook.latest_usage_event(path)
            self.assertIsNotNone(ev)
            self.assertEqual(ev["message"]["usage"]["input_tokens"], 200)

    def test_skips_malformed_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                f.write("not json at all\n")
                f.write(json.dumps(_usage_event(input_tokens=42)) + "\n")
                f.write("{broken\n")
            ev = hook.latest_usage_event(path)
            self.assertEqual(ev["message"]["usage"]["input_tokens"], 42)

    def test_missing_file_returns_none(self):
        self.assertIsNone(hook.latest_usage_event("/nonexistent/path/x.jsonl"))

    def test_empty_path_returns_none(self):
        self.assertIsNone(hook.latest_usage_event(""))

    def test_no_usage_lines_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.jsonl")
            _write_jsonl(path, [{"type": "user", "message": {"content": "hi"}}])
            self.assertIsNone(hook.latest_usage_event(path))


class TestKnownAgentCwd(unittest.TestCase):
    """Phase-4 gate: recognises the main install root and a sub-agent's own
    agents/<id> dir; rejects everything else (unknown paths AND the
    ephemeral agent-worker.ts pool, whose cwd is outside both shapes)."""

    def test_main_install_root_resolves_to_main_agent_id(self):
        self.assertEqual(hook._known_agent_cwd(_INSTALL_DIR), hook.ledger_lib.main_agent_id())

    def test_subagent_dir_resolves_to_its_own_id(self):
        cwd = os.path.join(_INSTALL_DIR, "agents", "sub-a")
        self.assertEqual(hook._known_agent_cwd(cwd), "sub-a")

    def test_subagent_dir_trailing_slash_still_resolves(self):
        cwd = os.path.join(_INSTALL_DIR, "agents", "sub-a") + "/"
        self.assertEqual(hook._known_agent_cwd(cwd), "sub-a")

    def test_ephemeral_worker_home_is_rejected(self):
        # Matches agent-worker.ts's workerHomeFor(): ~/.{agent}-worker(-fast),
        # outside both the install root and agents/<id>.
        cwd = os.path.expanduser("~/.marveen-worker")
        self.assertIsNone(hook._known_agent_cwd(cwd))

    def test_unrelated_path_is_rejected(self):
        self.assertIsNone(hook._known_agent_cwd("/tmp/some/other/worker/home"))

    def test_empty_cwd_is_rejected(self):
        self.assertIsNone(hook._known_agent_cwd(""))
        self.assertIsNone(hook._known_agent_cwd(None))


class TestResolveTenant(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.conn = _make_db(self.tmp.name)

    def tearDown(self):
        self.conn.close()
        os.unlink(self.tmp.name)

    def test_no_rows_defaults(self):
        self.assertEqual(hook.resolve_tenant(self.conn, "agent-x"), "default")

    def test_single_row(self):
        self.conn.execute("INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES ('acme', 'agent-x', 1)")
        self.conn.commit()
        self.assertEqual(hook.resolve_tenant(self.conn, "agent-x"), "acme")

    def test_multiple_rows(self):
        self.conn.executemany(
            "INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, 'agent-x', 1)",
            [("acme",), ("globex",)],
        )
        self.conn.commit()
        self.assertEqual(hook.resolve_tenant(self.conn, "agent-x"), "_multi_")

    def test_disabled_row_ignored(self):
        self.conn.execute("INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES ('acme', 'agent-x', 0)")
        self.conn.commit()
        self.assertEqual(hook.resolve_tenant(self.conn, "agent-x"), "default")


class TestWriteTokenRow(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.conn = _make_db(self.tmp.name)

    def tearDown(self):
        self.conn.close()
        os.unlink(self.tmp.name)

    def test_inserts_row_with_expected_fields(self):
        ev = _usage_event(input_tokens=111, output_tokens=22, cache_read=3, cache_creation=4, text="preview text")
        ok = hook.write_token_row(self.conn, MAIN_AGENT, "sess-1", ev, "Bash")
        self.assertTrue(ok)
        row = self.conn.execute(
            "SELECT agent, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, "
            "content_preview, tool_name, model FROM token_usage"
        ).fetchone()
        self.assertEqual(row, (MAIN_AGENT, "sess-1", 111, 22, 3, 4, "preview text", "Bash", "claude-test-model"))

    def test_upsert_does_not_duplicate(self):
        ev = _usage_event(input_tokens=111, output_tokens=22)
        hook.write_token_row(self.conn, MAIN_AGENT, "sess-1", ev, "Bash")
        hook.write_token_row(self.conn, MAIN_AGENT, "sess-1", ev, "Bash")
        count = self.conn.execute("SELECT COUNT(*) FROM token_usage").fetchone()[0]
        self.assertEqual(count, 1)

    def test_missing_timestamp_returns_false(self):
        ev = _usage_event()
        ev["timestamp"] = None
        ok = hook.write_token_row(self.conn, MAIN_AGENT, "sess-1", ev, "Bash")
        self.assertFalse(ok)


class TestRecordHandoffAudit(unittest.TestCase):
    """Validation-counter instrumentation (phase-4 gate): every HANDOFF
    firing must land a verdict='handoff' hook_audit_log row."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.conn = _make_db(self.tmp.name)

    def tearDown(self):
        self.conn.close()
        os.unlink(self.tmp.name)

    def test_inserts_expected_row(self):
        hook.record_handoff_audit(self.conn, MAIN_AGENT, "sess-1", "Bash", 0.62, True)
        row = self.conn.execute(
            "SELECT agent_id, hook_type, verdict, tool_name, reason, session_id, trigger_source FROM hook_audit_log"
        ).fetchone()
        self.assertEqual(row, (MAIN_AGENT, "PostToolUse", "handoff", "Bash", "ctx=62%;interlock=yes", "sess-1", "watchdog"))

    def test_interlock_false_is_recorded_in_reason(self):
        hook.record_handoff_audit(self.conn, MAIN_AGENT, "sess-1", "Bash", 0.9, False)
        reason = self.conn.execute("SELECT reason FROM hook_audit_log").fetchone()[0]
        self.assertIn("interlock=no", reason)

    def test_never_raises_on_a_closed_connection(self):
        self.conn.close()
        try:
            hook.record_handoff_audit(self.conn, MAIN_AGENT, "sess-1", "Bash", 0.62, True)
        except Exception as e:  # pragma: no cover -- the point of the test is that this doesn't happen
            self.fail(f"record_handoff_audit raised: {e!r}")
        self.conn = sqlite3.connect(self.tmp.name)  # reopen (schema already on disk) so tearDown's close() is valid


class TestStampCompactInterlock(unittest.TestCase):
    def test_returns_true_and_writes_last_compact_on_success(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "compact.json")
            os.environ["CONTEXT_WATCHDOG_COMPACT_STATE"] = path
            try:
                ok = hook.stamp_compact_interlock(MAIN_AGENT)
                self.assertTrue(ok)
                with open(path) as f:
                    state = json.load(f)
                self.assertIn("last_compact", state[MAIN_AGENT])
            finally:
                del os.environ["CONTEXT_WATCHDOG_COMPACT_STATE"]

    def test_returns_false_when_the_path_is_unwritable(self):
        os.environ["CONTEXT_WATCHDOG_COMPACT_STATE"] = "/nonexistent/dir/x/compact.json"
        try:
            ok = hook.stamp_compact_interlock(MAIN_AGENT)
            self.assertFalse(ok)
        finally:
            del os.environ["CONTEXT_WATCHDOG_COMPACT_STATE"]


class TestBuildHandoff(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.conn = _make_db(self.tmp.name)

    def tearDown(self):
        self.conn.close()
        os.unlink(self.tmp.name)

    def test_includes_blackboard_kanban_and_pct(self):
        self.conn.execute(
            "INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) VALUES "
            "('b1', ?, 'card-1', 'active', 'doing the thing', 100)", (MAIN_AGENT,)
        )
        self.conn.execute(
            "INSERT INTO kanban_cards (id, title, status, assignee, updated_at, archived_at) VALUES "
            "('c1', 'Open task', 'in_progress', ?, 100, NULL)", (MAIN_AGENT,)
        )
        self.conn.execute(
            "INSERT INTO agent_messages (from_agent, to_agent, content, created_at) VALUES (?, 'peer', 'next step text', 200)",
            (MAIN_AGENT,),
        )
        self.conn.commit()
        text = hook.build_handoff(self.conn, MAIN_AGENT, 0.62, 248000, 400000)
        self.assertIn("CONTEXT-WATCHDOG HANDOFF", text)
        self.assertIn("doing the thing", text)
        self.assertIn("Open task", text)
        self.assertIn("next step text", text)
        self.assertIn("62%", text)
        self.assertIn("[/CONTEXT-WATCHDOG HANDOFF]", text)

    def test_truncates_to_max_chars(self):
        long_summary = "x" * 5000
        self.conn.execute(
            "INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) VALUES "
            "('b1', ?, NULL, 'active', ?, 100)", (MAIN_AGENT, long_summary)
        )
        self.conn.commit()
        text = hook.build_handoff(self.conn, MAIN_AGENT, 0.9, 360000, 400000)
        self.assertLessEqual(len(text), hook.MAX_HANDOFF_CHARS + len("\n... [truncated]\n[/CONTEXT-WATCHDOG HANDOFF]"))
        self.assertTrue(text.endswith("[/CONTEXT-WATCHDOG HANDOFF]"))

    def test_empty_db_still_returns_header_and_pct(self):
        text = hook.build_handoff(self.conn, MAIN_AGENT, 0.6, 240000, 400000)
        self.assertIn("CONTEXT-WATCHDOG HANDOFF", text)
        self.assertIn("60%", text)


class TestMainSubprocess(unittest.TestCase):
    """main()'s contract via subprocess: ALWAYS exit 0 (logging-category,
    fail-open -- see module docstring); a HANDOFF is only emitted on stdout
    once the pct threshold is crossed."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "test.db")
        _make_db(self.db_path).close()
        self.gate_config_path = os.path.join(self.tmpdir.name, "gate.json")
        self.compact_state_path = os.path.join(self.tmpdir.name, "compact.json")
        with open(self.gate_config_path, "w") as f:
            json.dump({MAIN_AGENT: {"enabled": True, "thresholdTokens": 400000}}, f)
        self.transcript_path = os.path.join(self.tmpdir.name, "transcript.jsonl")

    def tearDown(self):
        self.tmpdir.cleanup()

    def _env(self):
        env = dict(os.environ)
        env["LEDGER_DB_PATH"] = self.db_path
        env["CONTEXT_WATCHDOG_GATE_CONFIG"] = self.gate_config_path
        env["CONTEXT_WATCHDOG_COMPACT_STATE"] = self.compact_state_path
        env["MAIN_AGENT_ID"] = MAIN_AGENT
        return env

    def _run_hook(self, payload, env=None):
        r = subprocess.run(
            [sys.executable, _HOOK_PATH],
            input=json.dumps(payload) if payload is not None else "",
            capture_output=True,
            text=True,
            timeout=10,
            env=env if env is not None else self._env(),
        )
        return r

    def _payload(self, **overrides):
        base = {
            "session_id": "sess-1",
            "tool_name": "Bash",
            "cwd": _INSTALL_DIR,
            "transcript_path": self.transcript_path,
        }
        base.update(overrides)
        return base

    def test_low_usage_writes_row_no_handoff(self):
        _write_jsonl(self.transcript_path, [_usage_event(input_tokens=1000, output_tokens=10)])
        r = self._run_hook(self._payload())
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")
        conn = sqlite3.connect(self.db_path)
        count = conn.execute("SELECT COUNT(*) FROM token_usage WHERE agent = ?", (MAIN_AGENT,)).fetchone()[0]
        conn.close()
        self.assertEqual(count, 1)
        if os.path.exists(self.compact_state_path):
            with open(self.compact_state_path) as f:
                self.assertNotIn(MAIN_AGENT, json.load(f))

    def test_high_usage_emits_handoff_and_stamps_interlock(self):
        # 65% of the 400000 threshold configured in setUp.
        _write_jsonl(self.transcript_path, [_usage_event(input_tokens=260000, output_tokens=10)])
        r = self._run_hook(self._payload())
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout.strip())
        self.assertIn("CONTEXT-WATCHDOG HANDOFF", out["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        with open(self.compact_state_path) as f:
            state = json.load(f)
        self.assertIn("last_compact", state.get(MAIN_AGENT, {}))
        conn = sqlite3.connect(self.db_path)
        row = conn.execute(
            "SELECT hook_type, verdict, reason FROM hook_audit_log WHERE agent_id = ?", (MAIN_AGENT,)
        ).fetchone()
        conn.close()
        self.assertEqual(row[0], "PostToolUse")
        self.assertEqual(row[1], "handoff")
        self.assertIn("interlock=yes", row[2])

    def test_unknown_agent_cwd_is_noop(self):
        _write_jsonl(self.transcript_path, [_usage_event(input_tokens=260000)])
        r = self._run_hook(self._payload(cwd="/tmp/some/other/worker/home"))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")
        conn = sqlite3.connect(self.db_path)
        count = conn.execute("SELECT COUNT(*) FROM token_usage").fetchone()[0]
        conn.close()
        self.assertEqual(count, 0)

    def test_ephemeral_worker_home_cwd_is_noop(self):
        # agent-worker.ts's actual worker cwd shape: ~/.{agent}-worker(-fast).
        _write_jsonl(self.transcript_path, [_usage_event(input_tokens=260000)])
        r = self._run_hook(self._payload(cwd=os.path.expanduser(f"~/.{MAIN_AGENT}-worker")))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")
        conn = sqlite3.connect(self.db_path)
        count = conn.execute("SELECT COUNT(*) FROM token_usage").fetchone()[0]
        conn.close()
        self.assertEqual(count, 0)

    def test_subagent_cwd_writes_row_and_can_emit_handoff(self):
        # cwd = <install>/agents/<subagent-id> -- the shape a sub-agent's own
        # settings.json runs the hook with (ensureContextWatchdogHook).
        sub_agent = "subagent-x"
        with open(self.gate_config_path, "w") as f:
            json.dump({sub_agent: {"enabled": True, "thresholdTokens": 400000}}, f)
        _write_jsonl(self.transcript_path, [_usage_event(input_tokens=260000, output_tokens=10)])
        cwd = os.path.join(_INSTALL_DIR, "agents", sub_agent)
        r = self._run_hook(self._payload(cwd=cwd))
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout.strip())
        self.assertIn("CONTEXT-WATCHDOG HANDOFF", out["hookSpecificOutput"]["additionalContext"])
        conn = sqlite3.connect(self.db_path)
        row = conn.execute("SELECT agent FROM token_usage").fetchone()
        conn.close()
        self.assertEqual(row[0], sub_agent)

    def test_missing_transcript_path_is_noop(self):
        r = self._run_hook(self._payload(transcript_path=""))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_transcript_with_no_usage_lines_is_noop(self):
        _write_jsonl(self.transcript_path, [{"type": "user", "message": {"content": "hi"}}])
        r = self._run_hook(self._payload())
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_invalid_json_stdin_exits_zero(self):
        r = subprocess.run(
            [sys.executable, _HOOK_PATH],
            input="not-json",
            capture_output=True,
            text=True,
            timeout=10,
            env=self._env(),
        )
        self.assertEqual(r.returncode, 0)

    def test_empty_stdin_exits_zero(self):
        r = self._run_hook(None)
        self.assertEqual(r.returncode, 0)

    def test_unwritable_db_path_still_exits_zero(self):
        _write_jsonl(self.transcript_path, [_usage_event(input_tokens=1000)])
        env = self._env()
        env["LEDGER_DB_PATH"] = os.path.join(self.tmpdir.name, "no", "such", "dir", "x.db")
        r = self._run_hook(self._payload(), env=env)
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
