#!/usr/bin/env python3
"""fleet-helper kanban reads go through GET /api/kanban and filter/sort locally.

Run: python3 scripts/__tests__/fleet-helper-kanban.test.py
"""
import importlib.util
import os
import sys
import time
import unittest
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FLEET = os.path.join(ROOT, "seed-skills", "fleet-helper", "scripts", "fleet.py")


def load():
    spec = importlib.util.spec_from_file_location("fleet_helper_under_test", FLEET)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def card(cid, **kw):
    base = {"id": cid, "title": cid, "status": "planned", "assignee": None, "priority": "normal",
            "project": None, "due_date": None, "updated_at": 1000, "extra": "dropped"}
    base.update(kw)
    return base


class FleetKanban(unittest.TestCase):
    def setUp(self):
        self.fleet = load()
        self.calls = []
        self.cards = []

        def fake_api(method, path, payload=None, timeout=20):
            self.calls.append((method, path))
            return self.cards

        self.fleet.api = fake_api

    def test_no_direct_database_access(self):
        with open(FLEET, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("import sqlite3", src)
        self.assertNotIn("claudeclaw.db", src)

    def test_rows_carry_only_the_documented_fields(self):
        self.cards = [card("a", status="waiting")]
        rows = self.fleet.kanban_by_status("waiting")
        self.assertEqual(self.calls, [("GET", "/api/kanban")])
        self.assertEqual(set(rows[0]), set(self.fleet._KANBAN_FIELDS))

    def test_by_status_filters_and_orders_priority_then_recency_descending(self):
        self.cards = [
            card("low-new", status="waiting", priority="low", updated_at=9),
            card("urgent-old", status="waiting", priority="urgent", updated_at=1),
            card("urgent-new", status="waiting", priority="urgent", updated_at=5),
            card("other", status="done", priority="urgent"),
        ]
        self.assertEqual([r["id"] for r in self.fleet.kanban_by_status("waiting")],
                         ["urgent-new", "urgent-old", "low-new"])

    def test_stuck_needs_in_progress_and_an_old_enough_update(self):
        now = int(time.time())
        self.cards = [
            card("fresh", status="in_progress", updated_at=now - 60),
            card("old", status="in_progress", updated_at=now - 20000),
            card("older", status="in_progress", updated_at=now - 30000),
            card("old-but-waiting", status="waiting", updated_at=now - 99999),
        ]
        self.assertEqual([r["id"] for r in self.fleet.kanban_stuck()], ["older", "old"])
        self.assertEqual([r["id"] for r in self.fleet.kanban_stuck(10)], ["older", "old", "fresh"])

    def test_due_today_includes_overdue_skips_done_and_undated_orders_by_due(self):
        today = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)
        ts = lambda d: int(d.timestamp())
        self.cards = [
            card("today", status="planned", due_date=ts(today)),
            card("overdue", status="in_progress", due_date=ts(today - timedelta(days=3))),
            card("tomorrow", status="planned", due_date=ts(today + timedelta(days=1))),
            card("done", status="done", due_date=ts(today - timedelta(days=1))),
            card("undated", status="planned"),
        ]
        self.assertEqual([r["id"] for r in self.fleet.kanban_due_today()], ["overdue", "today"])


if __name__ == "__main__":
    unittest.main()
