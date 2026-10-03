#!/usr/bin/env python3
"""Unit tests for scripts/rbac-shadow-summary.py.

Pure helpers (findings_count, alert_line, full_report) are tested directly;
main() runs end to end with the dashboard fetch mocked, so the exit-code
contract (0 clean / 1 findings / 2 unreadable) and the stdout/stderr split
are pinned without a running dashboard.

Privacy: neutral fixture names only.
"""
import importlib.util
import io
import os
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

_SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "rbac-shadow-summary.py",
)
_spec = importlib.util.spec_from_file_location("rbac_shadow_summary", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]


def summary(would=0, denied=0, permitted=0, top=None, principals=None):
    return {
        "from": 1, "to": None, "total": would + denied + permitted,
        "by_decision": {"would-deny": would, "denied": denied, "permitted": permitted},
        "top_denials": top or [],
        "denied_principals": principals or [],
    }


TOP = {"method": "POST", "route": "/api/kanban/cards", "permission": "kanban:write",
       "role": "viewer", "decision": "would-deny", "count": 3}
PRINCIPAL = {"principal_kind": "session", "principal": "user-a", "role": "viewer", "count": 3}


def run_main(fetch_result=None, fetch_error=None, argv=None):
    out, err = io.StringIO(), io.StringIO()
    with patch.object(mod, "fetch_summary", side_effect=fetch_error) if fetch_error else \
            patch.object(mod, "fetch_summary", return_value=fetch_result):
        with redirect_stdout(out), redirect_stderr(err):
            code = mod.main(argv or [])
    return code, out.getvalue(), err.getvalue()


class FindingsCountTest(unittest.TestCase):
    def test_counts_would_deny_and_denied_but_not_permitted(self):
        self.assertEqual(mod.findings_count(summary(would=2, denied=3, permitted=50)), 5)

    def test_permitted_only_is_zero(self):
        self.assertEqual(mod.findings_count(summary(permitted=9)), 0)

    def test_missing_keys_are_zero(self):
        self.assertEqual(mod.findings_count({}), 0)
        self.assertEqual(mod.findings_count({"by_decision": {}}), 0)


class AlertLineTest(unittest.TestCase):
    def test_names_counts_and_the_top_shape(self):
        line = mod.alert_line(summary(would=3, top=[TOP]), 24)
        self.assertIn("24h", line)
        self.assertIn("3 would-deny", line)
        self.assertIn("0 denied", line)
        self.assertIn("POST /api/kanban/cards viewer x3", line)

    def test_without_a_top_shape_it_still_reports_counts(self):
        self.assertEqual(mod.alert_line(summary(denied=1), 6), "rbac-shadow 6h: 0 would-deny, 1 denied")

    def test_fits_the_command_task_alert_budget(self):
        long_top = dict(TOP, route="/api/" + "x" * 400)
        self.assertLessEqual(len(mod.alert_line(summary(would=1, top=[long_top]), 24)), mod.ALERT_MAX_CHARS)


class FullReportTest(unittest.TestCase):
    def test_empty_window_is_flagged_as_no_evidence(self):
        self.assertIn("EMPTY WINDOW", mod.full_report(summary(), 24))

    def test_non_empty_window_is_not_flagged_empty(self):
        self.assertNotIn("EMPTY WINDOW", mod.full_report(summary(permitted=4), 24))

    def test_lists_denial_shapes_and_callers(self):
        report = mod.full_report(summary(would=3, top=[TOP], principals=[PRINCIPAL]), 24)
        self.assertIn("POST /api/kanban/cards viewer (needs kanban:write) x3 [would-deny]", report)
        self.assertIn("caller session/user-a role=viewer x3", report)

    def test_a_caller_without_a_label_prints_a_dash(self):
        p = dict(PRINCIPAL, principal_kind="token", principal="")
        self.assertIn("caller token/- role=viewer", mod.full_report(summary(would=1, principals=[p]), 24))

    def test_shows_at_most_five_of_each_list(self):
        tops = [dict(TOP, route="/api/r%d" % i) for i in range(9)]
        report = mod.full_report(summary(would=9, top=tops), 24)
        self.assertEqual(report.count("(needs kanban:write)"), mod.TOP_SHOWN)


class FetchSummaryTest(unittest.TestCase):
    def test_requests_the_summary_with_the_window_and_the_bearer_token(self):
        import tempfile
        captured = {}

        class FakeResp:
            def read(self):
                return b'{"total": 0}'

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["auth"] = req.get_header("Authorization")
            return FakeResp()

        with tempfile.NamedTemporaryFile("w", suffix=".token", delete=False) as tf:
            tf.write("token-a\n")
        try:
            with patch.object(mod, "DASHBOARD_TOKEN_FILE", tf.name), \
                    patch.object(mod, "DASHBOARD_BASE", "http://localhost:1234"), \
                    patch.object(mod.urllib.request, "urlopen", fake_urlopen):
                self.assertEqual(mod.fetch_summary(6), {"total": 0})
        finally:
            os.unlink(tf.name)
        self.assertEqual(
            captured["url"],
            "http://localhost:1234/api/v1/rbac/shadow-log?summary=1&since_hours=6",
        )
        self.assertEqual(captured["auth"], "Bearer token-a")


class MainExitContractTest(unittest.TestCase):
    def test_clean_window_exits_zero_and_writes_nothing_to_stderr(self):
        code, out, err = run_main(summary(permitted=7))
        self.assertEqual(code, mod.EXIT_CLEAN)
        self.assertEqual(err, "")
        self.assertIn("7 rows", out)

    def test_would_deny_exits_one_with_the_compact_line_on_stderr(self):
        code, out, err = run_main(summary(would=3, top=[TOP], principals=[PRINCIPAL]))
        self.assertEqual(code, mod.EXIT_FINDINGS)
        self.assertIn("3 would-deny", err)
        self.assertEqual(err.count("\n"), 1)  # a single line: the alert keeps the first 200 chars
        self.assertIn("POST /api/kanban/cards", out)

    def test_denied_alone_also_exits_one(self):
        code, _, err = run_main(summary(denied=2))
        self.assertEqual(code, mod.EXIT_FINDINGS)
        self.assertIn("2 denied", err)

    def test_empty_window_is_clean_but_says_it_proves_nothing(self):
        code, out, err = run_main(summary())
        self.assertEqual(code, mod.EXIT_CLEAN)
        self.assertIn("EMPTY WINDOW", out)
        self.assertEqual(err, "")

    def test_unreadable_summary_exits_two(self):
        code, _, err = run_main(fetch_error=urllib.error.URLError("connection refused"))
        self.assertEqual(code, mod.EXIT_UNREADABLE)
        self.assertIn("cannot read the summary", err)

    def test_missing_token_file_exits_two(self):
        code, _, err = run_main(fetch_error=FileNotFoundError("no token"))
        self.assertEqual(code, mod.EXIT_UNREADABLE)
        self.assertIn("cannot read the summary", err)

    def test_malformed_json_exits_two(self):
        code, _, _ = run_main(fetch_error=ValueError("bad json"))
        self.assertEqual(code, mod.EXIT_UNREADABLE)

    def test_hours_is_passed_through_and_validated(self):
        with patch.object(mod, "fetch_summary", return_value=summary()) as f, \
                redirect_stdout(io.StringIO()):
            mod.main(["--hours", "6"])
        f.assert_called_once_with(6)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            mod.main(["--hours", "0"])


if __name__ == "__main__":
    unittest.main()
