#!/usr/bin/env python3
"""Unit tests for scripts/blackboard-hygiene.py.

Pure helpers (pane_is_active, is_lagging, is_stale_blocked, is_maintenance_active,
nudge_on_hold, is_wake_gap, next_counters) are tested directly;
counter persistence runs against an in-memory stand-in for the dashboard's
agent-state and messages endpoints; main() runs end to end with the dashboard,
tmux and clock mocked, so the nudge / escalation / reset / dry-run / failure contract is
pinned without touching a real fleet.

Privacy: neutral fixture agent names only.
"""
import importlib.util
import io
import os
import re
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
HEARTBEAT = "[memoria-heartbeat] Ideje a periodikus memoria-heartbeatednek."
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


class IsMaintenanceActiveTest(unittest.TestCase):
    def setUp(self):
        p = patch.object(mod, "COORDINATOR", "coord")
        p.start()
        self.addCleanup(p.stop)

    def _msg(self, age, sender="coord", content=HEARTBEAT):
        return {"from_agent": sender, "content": content, "ts": NOW - age}

    def test_recent_coordinator_heartbeat_is_maintenance(self):
        self.assertTrue(mod.is_maintenance_active(self._msg(10 * 60), NOW))

    def test_window_boundary_is_fifteen_minutes(self):
        self.assertTrue(mod.is_maintenance_active(self._msg(14 * 60 + 59), NOW))
        self.assertFalse(mod.is_maintenance_active(self._msg(15 * 60 + 1), NOW))

    def test_hygiene_prefix_counts(self):
        self.assertTrue(mod.is_maintenance_active(self._msg(60, content=mod.NUDGE_TEXT), NOW))

    def test_other_sender_with_the_prefix_does_not_count(self):
        self.assertFalse(mod.is_maintenance_active(self._msg(60, sender="agent-b"), NOW))

    def test_real_task_message_is_not_maintenance(self):
        self.assertFalse(mod.is_maintenance_active(self._msg(60, content="Implementalj egy feladatot"), NOW))

    def test_no_message_is_not_maintenance(self):
        self.assertFalse(mod.is_maintenance_active(None, NOW))


class NudgeOnHoldTest(unittest.TestCase):
    ROW = {"status": "done", "updated_at": NOW - 5 * 86400}

    def test_no_previous_nudge_is_not_on_hold(self):
        self.assertFalse(mod.nudge_on_hold(None, self.ROW, NOW))

    def test_pending_nudge_holds(self):
        self.assertTrue(mod.nudge_on_hold({"status": "pending", "ts": NOW - 3600}, self.ROW, NOW))

    def test_pending_nudge_stops_holding_after_two_hours(self):
        self.assertFalse(mod.nudge_on_hold({"status": "pending", "ts": NOW - 2 * 3600 - 1}, self.ROW, NOW))

    def test_cooldown_boundary_is_thirty_minutes(self):
        self.assertTrue(mod.nudge_on_hold({"status": "delivered", "ts": NOW - 29 * 60}, self.ROW, NOW))
        self.assertFalse(mod.nudge_on_hold({"status": "delivered", "ts": NOW - 31 * 60}, self.ROW, NOW))

    def test_row_updated_after_the_nudge_releases_the_hold(self):
        row = {"status": "done", "updated_at": NOW - 60}
        self.assertFalse(mod.nudge_on_hold({"status": "delivered", "ts": NOW - 600}, row, NOW))

    def test_missing_row_inside_cooldown_holds(self):
        self.assertTrue(mod.nudge_on_hold({"status": "delivered", "ts": NOW - 600}, None, NOW))


class IsWakeGapTest(unittest.TestCase):
    def test_first_ever_sweep_is_not_a_gap(self):
        self.assertFalse(mod.is_wake_gap(None, NOW))

    def test_hourly_tick_is_normal(self):
        # 61 minutes: the monitor's own cadence plus jitter must not look like a sleep.
        self.assertFalse(mod.is_wake_gap(NOW - 61 * 60, NOW))

    def test_boundary_is_seventy_five_minutes(self):
        self.assertFalse(mod.is_wake_gap(NOW - 75 * 60, NOW))
        self.assertTrue(mod.is_wake_gap(NOW - 76 * 60, NOW))


class NextCountersTest(unittest.TestCase):
    def test_held_agent_keeps_its_counter(self):
        self.assertEqual(mod.next_counters({"agent-a": 1}, [], ["agent-a"]), ({"agent-a": 1}, []))

    def test_held_agent_without_counter_stays_absent(self):
        self.assertEqual(mod.next_counters({}, [], ["agent-a"]), ({}, []))

    def test_unheld_missing_agent_is_still_dropped(self):
        self.assertEqual(mod.next_counters({"agent-a": 1}, [], []), ({}, []))

    def test_first_nudge_starts_the_counter(self):
        self.assertEqual(mod.next_counters({}, ["agent-a"]), ({"agent-a": 1}, []))

    def test_second_consecutive_nudge_escalates_and_resets(self):
        self.assertEqual(mod.next_counters({"agent-a": 1}, ["agent-a"]), ({}, ["agent-a"]))

    def test_agent_that_recovered_is_dropped(self):
        self.assertEqual(mod.next_counters({"agent-a": 1, "agent-b": 1}, ["agent-b"]), ({}, ["agent-b"]))

    def test_agents_are_independent(self):
        new, esc = mod.next_counters({"agent-a": 1}, ["agent-a", "agent-b"])
        self.assertEqual((new, esc), ({"agent-b": 1}, ["agent-a"]))


class FakeStore:
    """In-memory stand-in for /api/agent-state and /api/messages.

    Mirrors the real contract: a missing state row is a 404, PUT stores the
    JSON value as sent, and a message listing is newest-first for one agent in
    either direction.
    """

    def __init__(self, coordinator="coord"):
        self.coordinator = coordinator
        self.state = {}
        self.messages = []
        self.puts = []

    def seed(self, nudges=None):
        if nudges is not None:
            self.state[mod.STATE_KEY] = nudges

    def add_msg(self, to, content, age, sender="coord", status="delivered"):
        """Add a message `age` seconds old (delivered at the same moment)."""
        ts = NOW - age
        self.messages.append({
            "id": len(self.messages) + 1, "from_agent": sender, "to_agent": to, "content": content,
            "status": status, "created_at": ts, "delivered_at": ts if status != "pending" else None,
        })

    def api(self, path, payload=None, method=None):
        m = re.match(r"^/api/agent-state/([^/]+)/([^/?]+)$", path)
        if m:
            assert m.group(1) == self.coordinator, path
            key = m.group(2)
            if method == "PUT":
                self.puts.append((key, payload["value"]))
                self.state[key] = payload["value"]
                return {"ok": True}
            if key not in self.state:
                raise urllib.error.HTTPError(path, 404, "not found", {}, io.BytesIO(b""))
            return {"agent_id": self.coordinator, "state_key": key, "value": self.state[key], "updated_at": NOW}
        m = re.match(r"^/api/messages\?agent=([^&]+)&limit=(\d+)$", path)
        if m:
            agent, limit = m.group(1), int(m.group(2))
            rows = [x for x in self.messages if agent in (x["from_agent"], x["to_agent"])]
            rows.sort(key=lambda x: (x["created_at"], x["id"]), reverse=True)
            return rows[:limit]
        raise AssertionError("unexpected path " + path)


class CountersPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        patcher = patch.object(mod, "_api", side_effect=self.store.api)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(mod, "STATE_AGENT_ID", "coord")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_missing_row_reads_as_empty(self):
        self.assertEqual(mod.read_counters(), {})

    def test_corrupt_value_reads_as_empty(self):
        self.store.seed("not json")
        self.assertEqual(mod.read_counters(), {})

    def test_non_dict_value_reads_as_empty(self):
        self.store.seed([1, 2])
        self.assertEqual(mod.read_counters(), {})

    def test_write_then_read_roundtrip_and_overwrite(self):
        mod.write_counters({"agent-a": 1})
        mod.write_counters({"agent-b": 1})
        self.assertEqual(mod.read_counters(), {"agent-b": 1})

    def test_missing_last_sweep_reads_as_none(self):
        self.assertIsNone(mod.read_last_sweep())

    def test_last_sweep_roundtrip_and_legacy_text_value(self):
        mod.write_last_sweep(NOW)
        self.assertEqual(mod.read_last_sweep(), NOW)
        # Rows written by the old SQL path were the bare number as text.
        self.store.state[mod.LAST_SWEEP_KEY] = str(NOW - 5)
        self.assertEqual(mod.read_last_sweep(), NOW - 5)

    def test_unreadable_last_sweep_reads_as_none(self):
        self.store.state[mod.LAST_SWEEP_KEY] = "garbage"
        self.assertIsNone(mod.read_last_sweep())

    def test_server_error_is_not_mistaken_for_an_empty_state(self):
        # An outage must not read as "no counters": the next write would wipe them.
        err = urllib.error.HTTPError("/x", 500, "boom", {}, io.BytesIO(b""))
        with patch.object(mod, "_api", side_effect=err):
            with self.assertRaises(urllib.error.HTTPError):
                mod.read_counters()


class MessageLookupTest(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()

    def test_latest_incoming_is_the_newest_delivered_or_done_message_to_the_agent(self):
        self.store.add_msg("agent-a", "old", 900, status="done")
        self.store.add_msg("agent-a", "new", 100)
        self.store.add_msg("agent-a", "queued", 10, status="pending")
        self.store.add_msg("agent-b", "other", 5)
        self.store.add_msg("someone", "outgoing", 5, sender="agent-a")
        got = mod.latest_incoming(self.store.messages, "agent-a")
        self.assertEqual((got["content"], got["ts"]), ("new", NOW - 100))

    def test_latest_incoming_is_none_without_a_delivered_message(self):
        self.store.add_msg("agent-a", "queued", 10, status="pending")
        self.assertIsNone(mod.latest_incoming(self.store.messages, "agent-a"))

    def test_latest_nudge_ignores_failed_other_senders_and_other_prefixes(self):
        with patch.object(mod, "COORDINATOR", "coord"):
            self.store.add_msg("agent-a", mod.NUDGE_TEXT, 3000, status="done")
            self.store.add_msg("agent-a", mod.NUDGE_TEXT, 100, status="failed")
            self.store.add_msg("agent-a", mod.NUDGE_TEXT, 50, sender="agent-b")
            self.store.add_msg("agent-a", HEARTBEAT, 10)
            got = mod.latest_nudge(self.store.messages, "agent-a")
        self.assertEqual((got["status"], got["ts"]), ("done", NOW - 3000))

    def test_agent_messages_asks_for_the_agent_mailbox_with_the_endpoint_cap(self):
        with patch.object(mod, "_api", return_value=[]) as api:
            self.assertEqual(mod.agent_messages("agent-a"), [])
        self.assertEqual(api.call_args[0][0], "/api/messages?agent=agent-a&limit=200")


class MainTest(unittest.TestCase):
    """main() with dashboard / tmux / clock mocked."""

    def setUp(self):
        self.store = FakeStore()
        self.sent = []
        self.panes = {}
        self.board = []
        self.agents = []
        self.fail_send = False
        self.fail_read = False
        self.fail_state_read = False
        self.fail_state_write = False

        def fake_api(path, payload=None, method=None):
            if self.fail_read and payload is None and path in ("/api/agents", "/api/blackboard"):
                raise urllib.error.URLError("down")
            if path.startswith("/api/agent-state/"):
                if self.fail_state_read and method != "PUT":
                    raise urllib.error.URLError("down")
                if self.fail_state_write and method == "PUT":
                    raise urllib.error.URLError("down")
                return self.store.api(path, payload, method)
            if path.startswith("/api/messages?"):
                return self.store.api(path)
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
            patch.object(mod, "COORDINATOR", "coord"),
            patch.object(mod, "STATE_AGENT_ID", "coord"),
            patch("builtins.print"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

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
        return self.store.state.get(mod.STATE_KEY, {})

    def test_lagging_active_agent_is_nudged_and_counted(self):
        self._fleet()
        self.assertEqual(mod.main([]), 0)
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self.sent[0]["from"], "coord")
        self.assertIn("[blackboard-hygiene]", self.sent[0]["content"])
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_coordinator_idle_and_stopped_agents_are_never_nudged(self):
        self._fleet()
        self.board = []
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_second_consecutive_round_escalates_to_coordinator_and_resets(self):
        self.store.seed({"agent-a": 1})
        self._fleet()
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a", "coord"])
        self.assertTrue(self.sent[1]["content"].startswith("[ESZKALACIO]"))
        self.assertIn("agent-a", self.sent[1]["content"])
        self.assertEqual(self._counters(), {})

    def test_recovered_agent_counter_is_cleared_silently(self):
        self.store.seed({"agent-a": 1})
        self._fleet({"status": "active", "updated_at": NOW - 60})
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_idle_agent_counter_is_cleared(self):
        self.store.seed({"agent-b": 1})
        self._fleet()
        self.board = []
        self.panes["agent-a"] = "> idle"
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_freshly_done_row_is_not_a_lag(self):
        self._fleet({"status": "done", "updated_at": NOW - 120})
        mod.main([])
        self.assertEqual(self.sent, [])

    def _blocked_idle_fleet(self, row=None):
        """agent-a idle with a blocked row (default: 2h old); agent-b idle, no row."""
        self._fleet()
        self.panes["agent-a"] = "> idle"
        self.board = [{"agent_id": "agent-a", **(row or {"status": "blocked", "updated_at": NOW - 2 * 3600})}]

    def test_idle_agent_with_old_blocked_row_is_nudged_and_counted(self):
        self._blocked_idle_fleet()
        self.assertEqual(mod.main([]), 0)
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self.sent[0]["content"], mod.BLOCKED_IDLE_NUDGE_TEXT)
        self.assertNotEqual(self.sent[0]["content"], mod.NUDGE_TEXT)
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_blocked_idle_second_round_escalates_with_blocked_idle_text_and_resets(self):
        self.store.seed({"agent-a": 1})
        self._blocked_idle_fleet()
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a", "coord"])
        self.assertTrue(self.sent[1]["content"].startswith("[ESZKALACIO]"))
        self.assertIn("blocked-idle", self.sent[1]["content"])
        self.assertIn("agent-a", self.sent[1]["content"])
        self.assertEqual(self._counters(), {})

    def test_fresh_blocked_row_on_idle_agent_is_not_nudged(self):
        self._blocked_idle_fleet({"status": "blocked", "updated_at": NOW - 600})
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_idle_agent_with_done_row_is_not_nudged(self):
        self._blocked_idle_fleet({"status": "done", "updated_at": NOW - 5 * 3600})
        mod.main([])
        self.assertEqual(self.sent, [])

    def test_active_blocked_agent_gets_exactly_one_message_from_the_lagging_branch(self):
        self._fleet({"status": "blocked", "updated_at": NOW - 2 * 3600})
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self.sent[0]["content"], mod.NUDGE_TEXT)
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_coordinator_with_old_blocked_row_is_never_nudged(self):
        self._blocked_idle_fleet({"status": "done", "updated_at": NOW - 5 * 3600})
        self.panes["coord"] = "> idle"
        self.board.append({"agent_id": "coord", "status": "blocked", "updated_at": NOW - 5 * 3600})
        mod.main([])
        self.assertEqual(self.sent, [])

    def test_dry_run_does_not_send_or_count_blocked_idle(self):
        self._blocked_idle_fleet()
        self.assertEqual(mod.main(["--dry-run"]), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})
        self.assertIn("blocked_idle=agent-a", print.call_args[0][0])

    def test_dry_run_sends_nothing_and_writes_nothing(self):
        self._fleet()
        self.assertEqual(mod.main(["--dry-run"]), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})
        line = print.call_args[0][0]  # print is patched in setUp
        self.assertIn("DRY", line)
        self.assertIn("lagging=agent-a", line)

    def test_dry_run_issues_no_state_write(self):
        self._fleet()
        self.assertEqual(mod.main(["--dry-run"]), 0)
        self.assertEqual(self.store.puts, [])

    def test_state_read_failure_exits_nonzero_without_side_effects(self):
        # An unreadable state must not look like "no counters": nothing is sent or written.
        self._fleet()
        self.fail_state_read = True
        self.assertEqual(mod.main([]), 1)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.store.puts, [])

    def test_state_write_failure_exits_nonzero(self):
        self._fleet()
        self.fail_state_write = True
        self.assertEqual(mod.main([]), 1)

    def test_dashboard_read_failure_exits_nonzero_without_side_effects(self):
        self._fleet()
        self.fail_read = True
        self.assertEqual(mod.main([]), 1)
        self.assertEqual(self.sent, [])

    def test_message_failure_exits_nonzero_but_still_saves_counters(self):
        self._fleet()
        self.fail_send = True
        self.assertEqual(mod.main([]), 1)
        self.assertEqual(self._counters(), {"agent-a": 1})

    # --- idle-agent false positive guards -----------------------------------

    def _idle_agent_fleet(self):
        """agent-a: pane active, done row five days old (the idle-agent shape)."""
        self._fleet({"status": "done", "updated_at": NOW - 5 * 86400})

    def test_fresh_heartbeat_turn_on_idle_agent_is_not_nudged(self):
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", HEARTBEAT, 5 * 60)
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {})

    def test_same_fixture_with_old_heartbeat_is_nudged(self):
        # Counter-probe: a stall must not slip through behind a stale heartbeat.
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", HEARTBEAT, 20 * 60)
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_real_message_after_the_heartbeat_ends_the_exemption(self):
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", HEARTBEAT, 8 * 60)
        self.store.add_msg("agent-a", "Dolgozz ezen", 3 * 60, sender="someone")
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_heartbeat_from_a_non_coordinator_does_not_silence_the_monitor(self):
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", HEARTBEAT, 5 * 60, sender="agent-b")
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_agent_without_a_row_and_a_fresh_heartbeat_is_not_lagging(self):
        self._fleet()
        self.board = []
        self.store.add_msg("agent-a", HEARTBEAT, 2 * 60)
        mod.main([])
        self.assertEqual(self.sent, [])

    def test_maintenance_exemption_keeps_the_existing_counter(self):
        self.store.seed({"agent-a": 1})
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", mod.NUDGE_TEXT, 4 * 60)
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_pending_nudge_blocks_a_second_one_and_keeps_the_counter(self):
        self.store.seed({"agent-a": 1})
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", mod.NUDGE_TEXT, 40 * 60, status="pending")
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_nudge_inside_cooldown_is_not_repeated_or_counted(self):
        self.store.seed({"agent-a": 1})
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", mod.NUDGE_TEXT, 20 * 60)
        mod.main([])
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {"agent-a": 1})

    def test_nudge_after_cooldown_without_update_is_repeated_and_escalates(self):
        self.store.seed({"agent-a": 1})
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", mod.NUDGE_TEXT, 40 * 60)
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a", "coord"])
        self.assertEqual(self._counters(), {})

    def test_nudge_to_another_agent_does_not_hold_this_one(self):
        self._idle_agent_fleet()
        self.store.add_msg("agent-b", mod.NUDGE_TEXT, 60)
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_dry_run_reports_held_agents(self):
        self._idle_agent_fleet()
        self.store.add_msg("agent-a", HEARTBEAT, 60)
        mod.main(["--dry-run"])
        line = print.call_args[0][0]
        self.assertIn("lagging=-", line)
        self.assertIn("held=agent-a", line)

    def _set_last_sweep(self, ts):
        self.store.state[mod.LAST_SWEEP_KEY] = ts

    def _last_sweep(self):
        return self.store.state.get(mod.LAST_SWEEP_KEY)

    def test_wake_guard_skips_the_round_and_records_the_time(self):
        self.store.seed({"agent-a": 1})
        self._set_last_sweep(NOW - 2 * 3600)
        self._fleet()
        self.assertEqual(mod.main([]), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self._counters(), {"agent-a": 1})
        self.assertEqual(self._last_sweep(), NOW)
        self.assertIn("wake-guard", print.call_args[0][0])

    def test_hourly_cadence_is_not_a_wake_gap(self):
        self._set_last_sweep(NOW - 61 * 60)
        self._fleet()
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_wake_guard_swallows_only_one_round(self):
        self._set_last_sweep(NOW - 2 * 3600)
        self._fleet()
        mod.main([])
        self.assertEqual(self.sent, [])
        mod.main([])
        self.assertEqual([m["to"] for m in self.sent], ["agent-a"])

    def test_every_normal_sweep_records_the_time(self):
        self._fleet()
        mod.main([])
        self.assertEqual(self._last_sweep(), NOW)

    def test_dry_run_does_not_record_the_time(self):
        self._fleet()
        mod.main(["--dry-run"])
        self.assertIsNone(self._last_sweep())

    def test_dry_run_wake_guard_writes_nothing(self):
        self._set_last_sweep(NOW - 2 * 3600)
        self._fleet()
        mod.main(["--dry-run"])
        self.assertEqual(self._last_sweep(), NOW - 2 * 3600)


class SweepContractTest(unittest.TestCase):
    """The maintenance prefixes must match what the coordinator really sends."""

    def test_heartbeat_directive_starts_with_a_maintenance_prefix(self):
        sweep = os.path.join(os.path.dirname(_SCRIPT_PATH), "fleet-heartbeat-sweep.sh")
        with open(sweep, encoding="utf-8") as f:
            lines = f.read().splitlines()
        start = next(i for i, ln in enumerate(lines) if "DIRECTIVE <<'EOF'" in ln)
        first = lines[start + 1].lstrip()
        self.assertTrue(first.startswith(mod.MAINTENANCE_PREFIXES), first[:40])

    def test_own_nudge_texts_start_with_a_maintenance_prefix(self):
        for text in (mod.NUDGE_TEXT, mod.BLOCKED_IDLE_NUDGE_TEXT):
            self.assertTrue(text.startswith(mod.MAINTENANCE_PREFIXES))


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
