#!/usr/bin/env python3
"""Unit tests for scripts/token-shadow-gate.py.

The decision (evaluate) is pure and tested on fixtures: every exception, the wrong-side cases that
LOOK like an exception, the "zero rows but the counter is dead" trap, the row-limit case, the
schedule coverage rules and the exit codes. main() runs end to end with the dashboard calls
replaced, so the exit-code contract and the refusal to read through the shared token are pinned
without a running dashboard.

Privacy: neutral fixture names only.
"""
import datetime
import importlib.util
import io
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

_SCRIPT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "token-shadow-gate.py")
_spec = importlib.util.spec_from_file_location("token_shadow_gate", _SCRIPT_PATH)
gate = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(gate)  # type: ignore[union-attr]

TODAY = datetime.date(2026, 10, 21)
START = datetime.date(2026, 10, 14)  # 8 days: 7 full days + today
MAIN = "main-agent"
SINCE_MS = int(datetime.datetime(2026, 10, 14, tzinfo=datetime.timezone.utc).timestamp() * 1000)


def row(category="shared_token_use", caller="", source="none", client="curl", route="/api/agents", count=1,
        day="2026-10-20", last_ts=1_792_000_000, method="GET", target=""):
    return {"day": day, "category": category, "method": method, "route": route, "caller": caller,
            "caller_source": source, "client": client, "target": target, "count": count, "last_ts": last_ts}


def args(**over):
    base = {"window_start": START, "manual_run": [], "dry_run_clean": [], "uptime_confirmed": True}
    base.update(over)
    return base


def sched(name, cron="0 7 * * *", enabled=True, last_run_ms=SINCE_MS + 3600_000):
    return {"name": name, "schedule": cron, "enabled": enabled, "lastRunAt": last_run_ms}


# one schedule of each class, all satisfied: the baseline against which a single change is tested
GOOD_SCHEDULES = [
    sched("daily"),
    sched("weekly", "0 8 * * 1"),
    sched("monthly", "0 8 1 * *", last_run_ms=SINCE_MS + 7200_000),
    sched("yearly-off", "0 0 1 1 *", enabled=False, last_run_ms=None),
]
GOOD_ARGS = args(dry_run_clean=["monthly", "yearly-off"])


def decide(rows=None, truncated=(), canary=True, schedules=None, a=None, today=TODAY, main=MAIN):
    by_cat = {}
    for r in rows or []:
        by_cat.setdefault(r["category"], []).append(r)
    return gate.evaluate(by_cat, set(truncated), canary, GOOD_SCHEDULES if schedules is None else schedules,
                         a or GOOD_ARGS, today, main)


class Exceptions(unittest.TestCase):
    def test_empty_counter_with_a_live_canary_and_full_coverage_is_a_pass(self):
        r = decide([row(caller=gate.CANARY, source="self_declared")])
        self.assertEqual((r["state"], r["exit_code"]), ("PASS", 0))
        self.assertEqual(len(r["excused"]["E3"]), 1)
        self.assertEqual(r["blocking"], [])

    def test_E1_the_main_agent_self_declared_is_excused(self):
        r = decide([row(caller=MAIN, source="self_declared")])
        self.assertEqual(r["state"], "PASS")
        self.assertEqual(len(r["excused"]["E1"]), 1)

    def test_E2_a_browser_with_no_caller_is_excused(self):
        r = decide([row(client="browser", caller="")])
        self.assertEqual(r["state"], "PASS")
        self.assertEqual(len(r["excused"]["E2"]), 1)

    def test_a_non_main_agent_self_declared_is_blocking_even_though_it_looks_like_E1(self):
        r = decide([row(caller="alpha", source="self_declared")])
        self.assertEqual((r["state"], r["exit_code"]), ("FAIL", 1))
        self.assertEqual(r["excused"], {})

    def test_the_main_agent_name_with_no_declared_source_is_blocking(self):
        self.assertEqual(decide([row(caller=MAIN, source="none")])["state"], "FAIL")
        self.assertEqual(decide([row(caller=MAIN, source="token")])["state"], "FAIL")

    def test_E1_needs_a_known_main_agent(self):
        self.assertEqual(decide([row(caller="", source="self_declared")], main="")["state"], "FAIL")

    def test_a_curl_with_no_caller_is_blocking_even_though_it_looks_like_E2(self):
        # the watchdog replay of the messages list is exactly this shape
        for client in ("curl", "python", "node", "other", "none"):
            r = decide([row(client=client, caller="")])
            self.assertEqual(r["state"], "FAIL", client)

    def test_a_browser_that_names_a_caller_is_not_E2(self):
        self.assertEqual(decide([row(client="browser", caller="alpha", source="self_declared")])["state"], "FAIL")

    def test_overflow_and_invalid_shapes_are_blocking(self):
        overflow = row(route="_overflow", caller="_overflow", client="other")
        invalid = row(caller="_invalid", source="self_declared", client="curl")
        self.assertEqual(decide([overflow])["state"], "FAIL")
        self.assertEqual(decide([invalid])["state"], "FAIL")

    def test_each_exception_has_a_reason_and_an_expiry(self):
        for exc in gate.EXCEPTIONS:
            self.assertTrue(exc["reason"])
            self.assertTrue(exc["expires"])


class Categories(unittest.TestCase):
    def test_identity_categories_block_with_no_exception_even_for_the_main_agent(self):
        for cat in gate.BLOCKING_ALWAYS:
            r = decide([row(category=cat, caller=MAIN, source="self_declared")])
            self.assertEqual(r["state"], "FAIL", cat)

    def test_fleet_skill_write_denied_is_reported_not_blocking(self):
        r = decide([row(category="fleet_skill_write_denied", caller="alpha", source="token")])
        self.assertEqual(r["state"], "PASS")
        self.assertEqual(len(r["explain"]), 1)

    def test_unscoped_read_is_informational(self):
        r = decide([row(category="unscoped_read", caller="alpha", source="token", target="*")])
        self.assertEqual(r["state"], "PASS")
        self.assertEqual(len(r["info"]), 1)


class Conclusiveness(unittest.TestCase):
    def test_zero_rows_but_the_canary_did_not_grow_is_inconclusive_not_a_pass(self):
        r = decide([], canary=False)
        self.assertEqual((r["state"], r["exit_code"]), ("INCONCLUSIVE", 2))
        self.assertTrue(any(x.startswith("C3") for x in r["reasons"]))

    def test_a_canary_that_could_not_be_made_is_inconclusive(self):
        r = decide([], canary=None)
        self.assertEqual(r["exit_code"], 2)
        self.assertTrue(any(x.startswith("C3") for x in r["reasons"]))

    def test_a_query_that_reached_the_row_limit_is_inconclusive(self):
        r = decide([], truncated=["shared_token_use"])
        self.assertEqual(r["exit_code"], 2)
        self.assertTrue(any(x.startswith("G5") and "row limit" in x for x in r["reasons"]))

    def test_a_marker_row_in_any_category_makes_the_window_inconclusive(self):
        r = decide([row(category="unscoped_read", route="_overflow", caller="_overflow")])
        self.assertEqual(r["exit_code"], 2)
        self.assertTrue(any("_overflow" in x for x in r["reasons"]))

    def test_a_window_shorter_than_seven_full_days_plus_today_is_inconclusive(self):
        r = decide([], a=args(window_start=datetime.date(2026, 10, 15), dry_run_clean=["monthly", "yearly-off"]))
        self.assertEqual(r["exit_code"], 2)
        self.assertTrue(any(x.startswith("W:") for x in r["reasons"]))
        self.assertEqual(decide([])["days"], 8)

    def test_unconfirmed_uptime_is_inconclusive(self):
        r = decide([], a=args(uptime_confirmed=False, dry_run_clean=["monthly", "yearly-off"]))
        self.assertTrue(any(x.startswith("C2c") for x in r["reasons"]))
        self.assertEqual(r["exit_code"], 2)

    def test_a_blocking_row_wins_over_an_inconclusive_window(self):
        r = decide([row(caller="alpha", source="self_declared")], canary=False)
        self.assertEqual(r["state"], "FAIL")
        self.assertTrue(r["reasons"])  # still reported


class ScheduleCoverage(unittest.TestCase):
    def test_a_frequent_schedule_that_has_not_run_since_the_window_started(self):
        r = decide([], schedules=GOOD_SCHEDULES + [sched("stalled", last_run_ms=SINCE_MS - 1000)])
        self.assertTrue(any(x.startswith("C2a") and "stalled" in x for x in r["reasons"]))
        self.assertEqual(r["exit_code"], 2)

    def test_a_frequent_schedule_that_never_ran(self):
        r = decide([], schedules=GOOD_SCHEDULES + [sched("never", last_run_ms=None)])
        self.assertTrue(any("never" in x for x in r["reasons"]))

    def test_a_disabled_frequent_schedule_is_not_a_caller(self):
        r = decide([], schedules=GOOD_SCHEDULES + [sched("off", enabled=False, last_run_ms=None)])
        self.assertEqual(r["state"], "PASS")

    def test_a_monthly_schedule_needs_a_manual_run_inside_the_window(self):
        stale = [s if s["name"] != "monthly" else sched("monthly", "0 8 1 * *", last_run_ms=SINCE_MS - 1000) for s in GOOD_SCHEDULES]
        r = decide([], schedules=stale)
        self.assertTrue(any("monthly" in x and "manual run" in x for x in r["reasons"]))
        self.assertEqual(r["exit_code"], 2)

    def test_a_manual_run_can_be_attested_when_last_run_does_not_show_it(self):
        stale = [s if s["name"] != "monthly" else sched("monthly", "0 8 1 * *", last_run_ms=SINCE_MS - 1000) for s in GOOD_SCHEDULES]
        r = decide([], schedules=stale, a=args(manual_run=["monthly"], dry_run_clean=["monthly", "yearly-off"]))
        self.assertEqual(r["state"], "PASS")

    def test_a_monthly_schedule_also_needs_its_dry_run_attested(self):
        r = decide([], a=args(dry_run_clean=["yearly-off"]))
        self.assertTrue(any("monthly" in x and "dry-run" in x for x in r["reasons"]))

    def test_a_disabled_rare_schedule_needs_only_the_dry_run(self):
        r = decide([], a=args(dry_run_clean=["monthly"]))
        self.assertTrue(any("yearly-off" in x and "dry-run" in x for x in r["reasons"]))
        self.assertFalse(any("yearly-off" in x and "manual run" in x for x in r["reasons"]))

    def test_cron_classification(self):
        for expr, rare in (("0 7 * * *", False), ("*/30 * * * *", False), ("0 8 * * 1", False),
                           ("0 8 1 * *", True), ("0 0 1 1 *", True), ("0 8 1,15 * *", True), ("", True)):
            self.assertEqual(gate.cron_is_rare(expr), rare, expr)


class Output(unittest.TestCase):
    def test_restart_hint_names_the_day_after_the_latest_blocking_hit(self):
        ts = int(datetime.datetime(2026, 10, 18, 13, 5, tzinfo=datetime.timezone.utc).timestamp())
        hint = gate.restart_hint([row(last_ts=ts - 5000), row(last_ts=ts)])
        self.assertIn("--window-start 2026-10-19", hint)
        self.assertIn("2026-10-18 13:05:00Z", hint)

    def test_the_text_report_lists_blocking_rows_excused_rows_and_reasons(self):
        r = decide([row(caller="alpha", source="self_declared", route="/api/memories"),
                    row(caller=gate.CANARY, source="self_declared")], canary=False)
        text = gate.render(r)
        self.assertIn("FAIL", text)
        self.assertIn("BLOCKING rows (1)", text)
        self.assertIn("alpha", text)
        self.assertIn("E3 excused 1 row(s)", text)
        self.assertIn("NOT CONCLUSIVE because", text)


class Main(unittest.TestCase):
    def run_main(self, argv, rows=None, canary=True, schedules=None, reader_error=None, today=TODAY):
        by_cat = {}
        for r in rows or []:
            by_cat.setdefault(r["category"], []).append(r)

        def fake_reader():
            if reader_error:
                raise reader_error
            return {"Authorization": "Bearer test"}

        fixed = datetime.datetime(today.year, today.month, today.day, 12, tzinfo=datetime.timezone.utc)

        class FakeDT(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return fixed

        out, err = io.StringIO(), io.StringIO()
        with patch.object(gate, "reader_headers", fake_reader), \
             patch.object(gate, "run_canary", lambda h, t: canary), \
             patch.object(gate, "gather", lambda h, ws, t: (by_cat, set())), \
             patch.object(gate, "_get", lambda path, h: GOOD_SCHEDULES if schedules is None else schedules), \
             patch.object(gate.datetime, "datetime", FakeDT), \
             patch.object(gate.agent_token, "main_agent_id", lambda install=None: MAIN), \
             redirect_stdout(out), redirect_stderr(err):
            code = gate.main(argv)
        return code, out.getvalue(), err.getvalue()

    BASE = ["--window-start", "2026-10-14", "--uptime-confirmed", "--dry-run-clean", "monthly", "--dry-run-clean", "yearly-off"]

    def test_pass(self):
        code, out, _ = self.run_main(self.BASE)
        self.assertEqual(code, 0)
        self.assertIn("PASS", out)

    def test_fail_exit_code_and_listing(self):
        code, out, _ = self.run_main(self.BASE, rows=[row(caller="alpha", source="self_declared")])
        self.assertEqual(code, 1)
        self.assertIn("BLOCKING", out)

    def test_inconclusive_when_the_canary_did_not_move(self):
        code, out, _ = self.run_main(self.BASE, canary=False)
        self.assertEqual(code, 2)
        self.assertIn("INCONCLUSIVE", out)

    def test_json_output_carries_the_state_and_exit_code(self):
        import json
        code, out, _ = self.run_main(self.BASE + ["--json"], rows=[row(caller=gate.CANARY, source="self_declared")])
        data = json.loads(out)
        self.assertEqual((code, data["state"], data["exit_code"]), (0, "PASS", 0))
        self.assertEqual(len(data["excused"]["E3"]), 1)

    def test_no_own_admin_token_is_inconclusive_not_a_read_through_the_shared_token(self):
        code, _, err = self.run_main(self.BASE, reader_error=OSError("no own admin token"))
        self.assertEqual(code, 2)
        self.assertIn("could not read the dashboard", err)

    def test_the_reader_refuses_a_token_that_is_not_an_own_admin_token(self):
        for source in (gate.agent_token.SOURCE_NONE, "shared-canary"):
            with self.subTest(source=source):
                other = gate.agent_token.Resolved("tok", source, "x")
                with patch.object(gate.agent_token, "resolve", lambda **kw: other):
                    with self.assertRaises(OSError):
                        gate.reader_headers()

    def test_the_reader_takes_the_operator_token(self):
        own = gate.agent_token.Resolved("tok", gate.agent_token.SOURCE_OPERATOR, None)
        with patch.object(gate.agent_token, "resolve", lambda **kw: own):
            self.assertEqual(gate.reader_headers()["Authorization"], "Bearer tok")

    def test_a_future_window_start_is_rejected(self):
        with self.assertRaises(SystemExit):
            with redirect_stderr(io.StringIO()):
                self.run_main(["--window-start", "2026-12-01"])


class Gather(unittest.TestCase):
    def fetch(self, per_category):
        return lambda h, cat, days, caller=None: {"rows": per_category.get(cat, [])}

    def test_a_category_that_fills_the_row_limit_is_reported_as_truncated(self):
        full = [row(day="2026-10-20", caller="c%d" % i) for i in range(gate.ROW_LIMIT)]
        with patch.object(gate, "fetch_category", self.fetch({"shared_token_use": full})):
            rows, truncated = gate.gather({}, START, TODAY)
        self.assertEqual(truncated, {"shared_token_use"})
        self.assertEqual(len(rows["shared_token_use"]), gate.ROW_LIMIT)

    def test_a_category_below_the_limit_is_not_truncated(self):
        with patch.object(gate, "fetch_category", self.fetch({"shared_token_use": [row()]})):
            _, truncated = gate.gather({}, START, TODAY)
        self.assertEqual(truncated, set())

    def test_rows_of_days_before_the_window_start_are_dropped(self):
        old, inside = row(day="2026-10-13", caller="old"), row(day="2026-10-14", caller="inside")
        with patch.object(gate, "fetch_category", self.fetch({"shared_token_use": [old, inside]})):
            rows, _ = gate.gather({}, START, TODAY)
        self.assertEqual([r["caller"] for r in rows["shared_token_use"]], ["inside"])

    def test_every_category_is_queried(self):
        asked = []
        with patch.object(gate, "fetch_category", lambda h, cat, days, caller=None: asked.append(cat) or {"rows": []}):
            gate.gather({}, START, TODAY)
        self.assertEqual(tuple(asked), gate.CATEGORIES)


class Canary(unittest.TestCase):
    def test_the_canary_is_made_as_the_gate_canary_caller_through_the_shared_token(self):
        # the shared token reaches the canary through its one dedicated reader, never through resolve()
        def no_resolve(**kw):
            raise AssertionError("resolve() must not be the way to the shared token")

        with patch.object(gate.agent_token, "canary_shared_token", lambda **kw: "shared-tok"), \
             patch.object(gate.agent_token, "resolve", no_resolve):
            headers = gate.canary_headers()
        self.assertEqual(headers["Authorization"], "Bearer shared-tok")
        self.assertEqual(headers["X-Agent-Id"], gate.CANARY)

    def test_there_is_no_canary_when_the_shared_token_is_gone_after_a_rotation(self):
        with patch.object(gate.agent_token, "canary_shared_token", lambda **kw: ""):
            self.assertIsNone(gate.canary_headers())

    def test_run_canary_is_true_only_when_the_counter_moved(self):
        totals = iter([3, 3, 4])  # before, one poll with no change, one poll after the bump
        with patch.object(gate, "canary_headers", lambda: {"Authorization": "Bearer s", "X-Agent-Id": gate.CANARY}), \
             patch.object(gate, "canary_total", lambda h, t: next(totals)), \
             patch.object(gate, "_get", lambda p, h: {}), \
             patch.object(gate.time, "sleep", lambda s: None):
            self.assertTrue(gate.run_canary({}, TODAY))

    def test_run_canary_is_false_when_the_counter_stays_put(self):
        clock = iter([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        with patch.object(gate, "canary_headers", lambda: {"Authorization": "Bearer s"}), \
             patch.object(gate, "canary_total", lambda h, t: 7), \
             patch.object(gate, "_get", lambda p, h: {}), \
             patch.object(gate.time, "time", lambda: next(clock)), \
             patch.object(gate.time, "sleep", lambda s: None):
            self.assertFalse(gate.run_canary({}, TODAY, wait_s=3))

    def test_run_canary_is_none_without_a_shared_token_file(self):
        with patch.object(gate, "canary_headers", lambda: None):
            self.assertIsNone(gate.run_canary({}, TODAY))


if __name__ == "__main__":
    unittest.main()
