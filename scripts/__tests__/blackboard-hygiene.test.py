#!/usr/bin/env python3
"""Unit tests for scripts/blackboard-hygiene.py.

Pure helpers (pane_is_active, is_lagging, is_stale_blocked, next_counters) are tested directly;
counter persistence runs against a throwaway SQLite file with the real
agent_state shape; main() runs end to end with the dashboard, tmux and clock
mocked, so the nudge / escalation / reset / dry-run / failure contract is
pinned without touching a real fleet.

Privacy: neutral fixture agent names only.
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

_SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "blackboard-hygiene.py",
)
_spec = importlib.util.spec_from_file_location("blackboard_hygiene", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]

NOW = 1_800_000_000
SPINNER_PANE = "output\nFlibbertigibbeting… (32m 37s · esc)\n"


class PaneActiveTest(unittest.TestCase):
    def test_spinner_line_alone_counts(self):
        self.assertTrue(mod.pane_is_active("Flibbertigibbeting… (32m 37s"))

    def test_marker_alone_counts(self):
        self.assertTrue(mod.pane_is_active("... esc to interrupt"))

    def test_idle_prompt_is_not_active(self):
        self.assertFalse(mod.pane_is_active("> \n  ? for shortcuts"))

    def test_empty_capture_is_not_active(self):
        self.assertFalse(mod.pane_is_active(""))


class IsLaggingTest(unittest.TestCase):
    def test_no_row_is_lagging(self):
        self.assertTrue(mod.is_lagging(None, NOW))

    def test_fresh_active_row_is_fine(self):
        self.assertFalse(mod.is_lagging({"status": "active", "updated_at": NOW - 600}, NOW))

    def test_just_finished_done_row_is_fine(self):
        self.assertFalse(mod.is_lagging({"status": "done", "updated_at": NOW - 5 * 60}, NOW))

    def test_old_done_row_is_lagging(self):
        self.assertTrue(mod.is_lagging({"status": "done", "updated_at": NOW - 16 * 60}, NOW))

    def test_old_blocked_row_is_lagging(self):
        self.assertTrue(mod.is_lagging({"status": "blocked", "updated_at": NOW - 20 * 60}, NOW))

    def test_active_row_older_than_two_hours_is_lagging(self):
        self.assertTrue(mod.is_lagging({"status": "active", "updated_at": NOW - 2 * 3600 - 1}, NOW))

    def test_active_row_just_inside_two_hours_is_fine(self):
        self.assertFalse(mod.is_lagging({"status": "active", "updated_at": NOW - 2 * 3600 + 60}, NOW))


class IsStaleBlockedTest(unittest.TestCase):
    def test_exactly_one_hour_is_not_stale(self):
        self.assertFalse(mod.is_stale_blocked({"status": "blocked", "updated_at": NOW - 3600}, NOW))

    def test_one_hour_and_one_second_is_stale(self):
        self.assertTrue(mod.is_stale_blocked({"status": "blocked", "updated_at": NOW - 3601}, NOW))

    def test_fresh_blocked_row_is_not_stale(self):
        self.assertFalse(mod.is_stale_blocked({"status": "blocked", "updated_at": NOW - 600}, NOW))

    def test_old_non_blocked_rows_are_never_stale_blocked(self):
        for status in ("done", "active", "assigned", "stale"):
            self.assertFalse(mod.is_stale_blocked({"status": status, "updated_at": NOW - 10 * 3600}, NOW), status)

    def test_missing_row_is_not_stale_blocked(self):
        self.assertFalse(mod.is_stale_blocked(None, NOW))


class NextCountersTest(unittest.TestCase):
    def test_first_nudge_starts_the_counter(self):
        self.assertEqual(mod.next_counters({}, ["agent-a"]), ({"agent-a": 1}, []))

    def test_second_consecutive_nudge_escalates_and_resets(self):
        self.assertEqual(mod.next_counters({"agent-a": 1}, ["agent-a"]), ({}, ["agent-a"]))

    def test_agent_that_recovered_is_dropped(self):
        self.assertEqual(mod.next_counters({"agent-a": 1, "agent-b": 1}, ["agent-b"]), ({}, ["agent-b"]))

    def test_agents_are_independent(self):
        new, esc = mod.next_counters({"agent-a": 1}, ["agent-a", "agent-b"])
        self.assertEqual((new, esc), ({"agent-b": 1}, ["agent-a"]))


def _make_db(path, initial=None):
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE agent_state (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, "
        "state_key TEXT NOT NULL, state_value TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default', "
        "updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(agent_id, state_key))"
    )
    if initial is not None:
        conn.execute(
            "INSERT INTO agent_state(agent_id,state_key,state_value) VALUES(?,?,?)",
            (mod.STATE_AGENT_ID, mod.STATE_KEY, initial),
        )
    conn.commit()
    conn.close()


class CountersPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "t.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_row_reads_as_empty(self):
        _make_db(self.db)
        conn = sqlite3.connect(self.db)
        self.addCleanup(conn.close)
        self.assertEqual(mod.read_counters(conn), {})

    def test_corrupt_value_reads_as_empty(self):
        _make_db(self.db, "not json")
        conn = sqlite3.connect(self.db)
        self.addCleanup(conn.close)
        self.assertEqual(mod.read_counters(conn), {})

    def test_non_dict_value_reads_as_empty(self):
        _make_db(self.db, "[1,2]")
        conn = sqlite3.connect(self.db)
        self.addCleanup(conn.close)
        self.assertEqual(mod.read_counters(conn), {})

    def test_write_then_read_roundtrip_and_upsert(self):
        _make_db(self.db)
        conn = sqlite3.connect(self.db)
        self.addCleanup(conn.close)
        mod.write_counters(conn, {"agent-a": 1})
        mod.write_counters(conn, {"agent-b": 1})
        self.assertEqual(mod.read_counters(conn), {"agent-b": 1})
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM agent_state").fetchone()[0], 1)


class MainTest(unittest.TestCase):
    """main() with dashboard / tmux / clock mocked."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "t.db")
        self.sent = []
        self.panes = {}
        self.board = []
        self.agents = []
        self.fail_send = False
        self.fail_read = False

        def fake_api(path, payload=None):
            if self.fail_read and payload is None and path in ("/api/agents", "/api/blackboard"):
                raise urllib.error.URLError("down")
            if path == "/api/agents":
                return self.agents
            if path == "/api/blackboard":
                return self.board
            if path.startswith("/api/blackboard/history"):
                return []
            if path == "/api/messages":
                if self.fail_send:
                    raise urllib.error.URLError("down")
                self.sent.append(payload)
                return {"ok": True}
            raise AssertionError("unexpected path " + path)

        self.patches = [
            patch.object(mod, "_api", side_effect=fake_api),
            patch.object(mod, "capture_pane", side_effect=lambda a: self.panes.get(a, "")),
            patch.object(mod.time, "time", return_value=NOW),
            patch.object(mod, "DB_PATH", self.db),
            patch.object(mod, "COORDINATOR", "coord"),
            patch.object(mod, "STATE_AGENT_ID", "coord"),
            patch("builtins.print"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _fleet(self, lagging_row=None):
        self.agents = [
            {"name": "coord", "running": True},
            {"name": "agent-a", "running": True},
            {"name": "agent-b", "running": True},
            {"name": "agent-c", "running": False},
        ]
        self.panes = {"coord": SPINNER_PANE, "agent-a": SPINNER_PANE, "agent-b": "> idle", "agent-c": SPINNER_PANE}
        self.board = [{"agent_id": "agent-a", **(lagging_row or {"status": "done", "updated_at": NOW - 3600})}]

    def _counters(self):
        conn = sqlite3.connect(self.db)
        try:
            return mod.read_counters(conn)
        finally:
            conn.close()

    def test_lagging_active_agent_is_nudged_and_counted(self):
        _make_db(self.db)
        self._fleet()
        self.assertEqual(mod.main([]), 0)
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self.sent[0]["from"], "coord")
        self.assertIn("[blackboard-hygiene]", self.sent[0]["content"])
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_coordinator_idle_and_stopped_agents_are_never_nudged(self):
        _make_db(self.db)
        self._fleet()
        self.board = []
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_second_consecutive_round_escalates_to_coordinator_and_resets(self):
        _make_db(self.db, '{"agent-a": 1}')
        self._fleet()
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a", "coord"])
        self.assertTrue(self.sent[1]["content"].startswith("[ESZKALACIO]"))
        self.assertIn("agent-a", self.sent[1]["content"])
        self.assertEqual(self._counters(), {})

    def test_recovered_agent_counter_is_cleared_silently(self):
        _make_db(self.db, '{"agent-a": 1}')
        self._fleet({"status": "active", "updated_at": NOW - 60})
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_idle_agent_counter_is_cleared(self):
        _make_db(self.db, '{"agent-b": 1}')
        self._fleet()
        self.board = []
        self.panes["agent-a"] = "> idle"
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_freshly_done_row_is_not_a_lag(self):
        _make_db(self.db)
        self._fleet({"status": "done", "updated_at": NOW - 120})
        mod.main([])
        self.assertEqual(self.sent, [])

    def _blocked_idle_fleet(self, row=None):
        """agent-a idle with a blocked row (default: 2h old); agent-b idle, no row."""
        self._fleet()
        self.panes["agent-a"] = "> idle"
        self.board = [{"agent_id": "agent-a", **(row or {"status": "blocked", "updated_at": NOW - 2 * 3600})}]

    def test_idle_agent_with_old_blocked_row_is_nudged_and_counted(self):
        _make_db(self.db)
        self._blocked_idle_fleet()
        self.assertEqual(mod.main([]), 0)
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self.sent[0]["content"], mod.BLOCKED_IDLE_NUDGE_TEXT)
        self.assertNotEqual(self.sent[0]["content"], mod.NUDGE_TEXT)
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_blocked_idle_second_round_escalates_with_blocked_idle_text_and_resets(self):
        _make_db(self.db, '{"agent-a": 1}')
        self._blocked_idle_fleet()
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a", "coord"])
        self.assertTrue(self.sent[1]["content"].startswith("[ESZKALACIO]"))
        self.assertIn("blocked-idle", self.sent[1]["content"])
        self.assertIn("agent-a", self.sent[1]["content"])
        self.assertEqual(self._counters(), {})

    def test_fresh_blocked_row_on_idle_agent_is_not_nudged(self):
        _make_db(self.db)
        self._blocked_idle_fleet({"status": "blocked", "updated_at": NOW - 600})
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_idle_agent_with_done_row_is_not_nudged(self):
        _make_db(self.db)
        self._blocked_idle_fleet({"status": "done", "updated_at": NOW - 5 * 3600})
        mod.main([])
        self.assertEqual(self.sent, [])

    def test_active_blocked_agent_gets_exactly_one_message_from_the_lagging_branch(self):
        _make_db(self.db)
        self._fleet({"status": "blocked", "updated_at": NOW - 2 * 3600})
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self.sent[0]["content"], mod.NUDGE_TEXT)
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_coordinator_with_old_blocked_row_is_never_nudged(self):
        _make_db(self.db)
        self._blocked_idle_fleet({"status": "done", "updated_at": NOW - 5 * 3600})
        self.panes["coord"] = "> idle"
        self.board.append({"agent_id": "coord", "status": "blocked", "updated_at": NOW - 5 * 3600})
        mod.main([])
        self.assertEqual(self.sent, [])

    def test_dry_run_does_not_send_or_count_blocked_idle(self):
        _make_db(self.db)
        self._blocked_idle_fleet()
        self.assertEqual(mod.main(["--dry-run"]), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})
        self.assertIn("blocked_idle=agent-a", print.call_args[0][0])

    def test_dry_run_sends_nothing_and_writes_nothing(self):
        _make_db(self.db)
        self._fleet()
        self.assertEqual(mod.main(["--dry-run"]), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})
        line = print.call_args[0][0]  # print is patched in setUp
        self.assertIn("DRY", line)
        self.assertIn("lagging=agent-a", line)

    def test_dry_run_does_not_create_a_missing_db(self):
        self._fleet()
        with self.assertRaises(sqlite3.OperationalError):
            mod.main(["--dry-run"])
        self.assertFalse(os.path.exists(self.db))

    def test_dashboard_read_failure_exits_nonzero_without_side_effects(self):
        _make_db(self.db)
        self._fleet()
        self.fail_read = True
        self.assertEqual(mod.main([]), 1)
        self.assertEqual(self.sent, [])

    def test_message_failure_exits_nonzero_but_still_saves_counters(self):
        _make_db(self.db)
        self._fleet()
        self.fail_send = True
        self.assertEqual(mod.main([]), 1)
        self.assertEqual(self._counters(), {"agent-a": 1})


class RunningAgentsTest(unittest.TestCase):
    def test_filters_to_running_non_coordinator(self):
        agents = [
            {"name": "coord", "running": True},
            {"name": "agent-a", "running": True},
            {"name": "agent-b", "running": False},
        ]
        with patch.object(mod, "_api", return_value=agents), patch.object(mod, "COORDINATOR", "coord"):
            self.assertEqual(mod.running_agents(), ["agent-a"])


class BlackboardRowTest(unittest.TestCase):
    def test_uses_board_row_when_present(self):
        row = {"agent_id": "agent-a", "status": "active", "updated_at": 5}
        with patch.object(mod, "_api") as api:
            self.assertEqual(mod.blackboard_row("agent-a", [row]), row)
            api.assert_not_called()

    def test_falls_back_to_newest_history_event(self):
        hist = [{"status": "active", "created_at": 42}]
        with patch.object(mod, "_api", return_value=hist) as api:
            self.assertEqual(mod.blackboard_row("agent-a", []), {"status": "active", "updated_at": 42})
            self.assertIn("agent_id=agent-a", api.call_args[0][0])

    def test_no_row_and_no_history_is_none(self):
        with patch.object(mod, "_api", return_value=[]):
            self.assertIsNone(mod.blackboard_row("agent-a", []))

    def test_history_fetch_error_degrades_to_none(self):
        with patch.object(mod, "_api", side_effect=urllib.error.URLError("x")):
            self.assertIsNone(mod.blackboard_row("agent-a", []))


if __name__ == "__main__":
    unittest.main()
