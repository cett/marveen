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
    # The script lives in a shipped seed-skill directory: leave no __pycache__ there.
    sys.dont_write_bytecode = True
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


class FleetDreamData(unittest.TestCase):
    """The dream-engine reads and the cold-tier move go through the API only."""

    def setUp(self):
        self.fleet = load()
        self.calls = []
        now = int(time.time())
        self.now = now
        self.memories = {
            ("a1", "hot"): [
                {"id": 1, "agent_id": "a1", "content": "old", "created_at": now - 20 * 86400, "accessed_at": now - 9 * 86400},
                {"id": 2, "agent_id": "a1", "content": "touched", "created_at": now - 20 * 86400, "accessed_at": now - 3600},
                {"id": 3, "agent_id": "a1", "content": "never touched", "created_at": now - 8 * 86400, "accessed_at": None},
                {"id": 9, "agent_id": "other", "content": "shared from another agent", "created_at": 1, "accessed_at": 1},
            ],
            ("a1", "warm"): [
                {"id": 4, "agent_id": "a1", "content": "fresh", "created_at": now - 600, "accessed_at": now - 600, "keywords": "k"},
            ],
        }
        self.ideas = [
            {"id": "i1", "title": "x", "category": "c", "impact": 5, "effort": 4},
            {"id": "i2", "title": "y", "category": "c", "impact": 4, "effort": 1},
            {"id": "i3", "title": "z", "category": "c", "impact": None, "effort": 1},
        ]

        def fake_api(method, path, payload=None, timeout=20):
            self.calls.append((method, path, payload))
            if path == "/api/memories/stats":
                return {"byAgent": {"a1": 4}, "total": 4, "withEmbedding": 3}
            if path.startswith("/api/memories?agent=a1&category="):
                return self.memories.get(("a1", path.split("category=")[1].split("&")[0]), [])
            if path.startswith("/api/ideas"):
                return {"ideas": self.ideas if "status=new" in path else [], "total": len(self.ideas) if "status=new" in path else 0}
            if path.startswith("/api/memories/") and method == "PUT":
                return {"ok": True}
            if path == "/api/skill-usage/summary":
                return [{"skill_name": "a", "count_30d": 2, "last_used_at": 5},
                        {"skill_name": "unused", "count_30d": 0, "last_used_at": 1},
                        {"skill_name": "b", "count_30d": 9, "last_used_at": 7}]
            if path == "/api/kanban":
                return [card("p2", status="planned", project="zeta", priority="low"),
                        card("p1", status="waiting", project="alpha", priority="urgent"),
                        card("p1b", status="planned", project="alpha", priority="low"),
                        card("closed", status="done", project="alpha")]
            raise AssertionError("unexpected call " + path)

        self.fleet.api = fake_api

    def test_stale_hot_uses_access_time_then_creation_time_and_skips_foreign_rows(self):
        self.assertEqual([m["id"] for m in self.fleet.memories_stale_hot(7)], [1, 3])

    def test_recent_memories_cover_hot_and_warm_created_in_the_window(self):
        rows = self.fleet.memories_recent(24)
        self.assertEqual([r["content"] for r in rows], ["fresh"])
        self.assertEqual(set(rows[0]), {"agent_id", "content", "keywords"})

    def test_move_to_cold_puts_each_found_id_and_reports_the_missing_ones(self):
        out = self.fleet.memories_to_cold(["1", "4", "77"])
        puts = [(p, b) for m, p, b in self.calls if m == "PUT"]
        self.assertEqual(puts, [("/api/memories/1", {"content": "old", "category": "cold"}),
                                ("/api/memories/4", {"content": "fresh", "category": "cold"})])
        self.assertEqual(out, {"moved": [1, 4], "not_found": [77]})

    def test_health_ideas_usage_and_open_kanban_shapes(self):
        self.assertEqual(self.fleet.memory_health(), {"total": 4, "with_emb": 3})
        self.assertEqual([i["id"] for i in self.fleet.ideas_top(5)], ["i2", "i1"])
        self.assertEqual([r["skill_name"] for r in self.fleet.skill_usage_30d()], ["b", "a"])
        self.assertEqual([c["id"] for c in self.fleet.kanban_open()], ["p1", "p1b", "p2"])


class FleetAuthHeaders(unittest.TestCase):
    """The helper signs with the calling agent's own token, resolved by the install's agent_token
    module; that module is loaded only from a file the current user owns and nobody else can write."""

    def setUp(self):
        import shutil
        import tempfile
        self.fleet = load()
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        hooks = os.path.join(self.tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.makedirs(os.path.join(self.tmp, "store"))
        os.makedirs(os.path.join(self.tmp, "agents", "alpha"))
        self.module_path = os.path.join(hooks, "agent_token.py")
        shutil.copy(os.path.join(ROOT, "scripts", "hooks", "agent_token.py"), self.module_path)
        os.chmod(self.module_path, 0o644)
        for rel, tok in ((os.path.join("store", ".dashboard-token"), "shared-tok"),
                         (os.path.join("agents", "alpha", ".agent-token"), "own-tok")):
            with open(os.path.join(self.tmp, rel), "w") as f:
                f.write(tok + "\n")
        self.prev_cwd = os.getcwd()
        self.addCleanup(os.chdir, self.prev_cwd)
        os.chdir(os.path.join(self.tmp, "agents", "alpha"))
        self.prev_env = {k: os.environ.pop(k, None) for k in ("CLAW_DIR", "MARVEEN_AGENT_TOKEN_FILE", "MAIN_AGENT_ID")}
        self.addCleanup(lambda: [os.environ.__setitem__(k, v) for k, v in self.prev_env.items() if v is not None])
        os.environ["CLAW_DIR"] = self.tmp

    def test_uses_the_agents_own_token_and_names_it(self):
        h = self.fleet.auth_headers()
        self.assertEqual(h["Authorization"], "Bearer own-tok")
        self.assertEqual(h["X-Agent-Id"], "alpha")

    def test_falls_back_to_the_shared_token_when_the_own_file_is_missing(self):
        os.remove(os.path.join(self.tmp, "agents", "alpha", ".agent-token"))
        h = self.fleet.auth_headers()
        self.assertEqual(h["Authorization"], "Bearer shared-tok")
        self.assertEqual(h["X-Agent-Id"], "alpha")

    def test_refuses_to_run_a_resolver_that_others_can_write(self):
        marker = os.path.join(self.tmp, "ran")
        with open(self.module_path, "a") as f:
            f.write("\nopen(%r, 'w').close()\n" % marker)
        os.chmod(self.module_path, 0o666)
        h = self.fleet.auth_headers()
        self.assertFalse(os.path.exists(marker), "a group/world-writable resolver was executed")
        self.assertEqual(h, {"Authorization": "Bearer shared-tok"})


if __name__ == "__main__":
    unittest.main()
