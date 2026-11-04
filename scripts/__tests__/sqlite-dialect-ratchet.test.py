#!/usr/bin/env python3
"""Unit tests for scripts/sqlite-dialect-ratchet.py.

Pure helpers (strip_comments, count_text, is_production_ts, compare) are tested
directly; scan() and main() run against a throwaway source tree and baseline
file, so the real src/ never influences the result.

Privacy: neutral fixture names only.
"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

_SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "sqlite-dialect-ratchet.py",
)
_spec = importlib.util.spec_from_file_location("sqlite_dialect_ratchet", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]


def _write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class CountTextTest(unittest.TestCase):
    def test_counts_each_construct(self):
        sql = "db.prepare('INSERT OR IGNORE INTO t(a) VALUES (unixepoch())').run(); x.lastInsertRowid"
        c = mod.count_text(sql)
        self.assertEqual(c["INSERT OR IGNORE"], 1)
        self.assertEqual(c["unixepoch()"], 1)
        self.assertEqual(c["lastInsertRowid"], 1)

    def test_block_and_line_comments_are_ignored(self):
        text = "/* INSERT OR REPLACE and rowid */\n// PRAGMA foreign_keys\nconst a = 1\n"
        self.assertEqual({k: v for k, v in mod.count_text(text).items() if v}, {})

    def test_trailing_slashes_in_a_string_do_not_hide_a_real_use(self):
        text = "const q = 'http://x'; db.prepare('SELECT rowid FROM t')\n"
        self.assertEqual(mod.count_text(text)["rowid"], 1)

    def test_match_needs_a_placeholder(self):
        self.assertEqual(mod.count_text("WHERE f MATCH ?")["FTS5 MATCH"], 1)
        self.assertEqual(mod.count_text("str.match(/x/)")["FTS5 MATCH"], 0)

    def test_untyped_parameter_shapes_are_counted(self):
        text = (
            "WHERE (? IS NULL OR t = ?) AND (@agent IS NULL OR a = @agent) AND x IS NOT ? AND y IS @v\n"
            "SET d = CASE WHEN ? THEN NULL ELSE d END, e = CASE WHEN ? THEN 1 ELSE 2 END"
        )
        c = mod.count_text(text)
        self.assertEqual(c["param IS [NOT] NULL"], 2)
        self.assertEqual(c["IS [NOT] <param>"], 2)
        self.assertEqual(c["CASE WHEN ? THEN"], 2)

    def test_typed_forms_are_not_counted(self):
        text = (
            "WHERE col IS NULL AND col IS NOT NULL AND (a IS NULL OR b = ?) AND c IS NOT DISTINCT FROM ?\n"
            "SET d = CASE WHEN col = ? THEN 1 ELSE 2 END, e = CASE WHEN x IS NULL THEN 1 END, "
            "f = COALESCE(?, f), g = CASE WHEN ? = 'ok' THEN 1 END"
        )
        c = mod.count_text(text)
        self.assertEqual(c["param IS [NOT] NULL"], 0)
        self.assertEqual(c["IS [NOT] <param>"], 0)
        self.assertEqual(c["CASE WHEN ? THEN"], 0)

    def test_replace_into_counts_as_or_replace(self):
        self.assertEqual(mod.count_text("REPLACE INTO t VALUES (1)")["INSERT OR REPLACE"], 1)

    def test_rowid_is_case_sensitive_so_a_variable_name_alone_is_not_enough(self):
        # lastInsertRowid is its own token and must not double-count as rowid.
        c = mod.count_text("r.lastInsertRowid")
        self.assertEqual(c["rowid"], 0)
        self.assertEqual(c["lastInsertRowid"], 1)


class ProductionFilterTest(unittest.TestCase):
    def test_filter(self):
        self.assertTrue(mod.is_production_ts("db/kanban.ts"))
        self.assertFalse(mod.is_production_ts(os.path.join("__tests__", "a.test.ts")))
        self.assertFalse(mod.is_production_ts("web/a.test.ts"))
        self.assertFalse(mod.is_production_ts(os.path.join("migrations", "x.ts")))
        self.assertFalse(mod.is_production_ts(os.path.join("generated", "api.ts")))
        self.assertFalse(mod.is_production_ts("types.d.ts"))
        self.assertFalse(mod.is_production_ts("a.sql"))


class CompareTest(unittest.TestCase):
    def test_growth_and_shrink(self):
        grown, shrunk = mod.compare({"a": 3, "b": 1, "c": 2}, {"a": 2, "b": 4, "c": 2})
        self.assertEqual(grown, {"a": (2, 3)})
        self.assertEqual(shrunk, {"b": (4, 1)})

    def test_new_token_with_hits_counts_as_growth(self):
        grown, _ = mod.compare({"new": 2}, {})
        self.assertEqual(grown, {"new": (0, 2)})

    def test_equal_is_neither(self):
        self.assertEqual(mod.compare({"a": 1}, {"a": 1}), ({}, {}))


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = os.path.join(self.tmp.name, "src")
        self.baseline = os.path.join(self.tmp.name, "baseline.json")
        _write(self.src, "db/a.ts", "db.prepare('SELECT rowid FROM t')\n")
        _write(self.src, "db/a.test.ts", "db.prepare('SELECT rowid, rowid FROM t')\n")
        _write(self.src, "migrations/m.ts", "rowid rowid rowid\n")
        patcher = patch.multiple(mod, SRC_DIR=self.src, BASELINE_PATH=self.baseline)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mod.main(list(argv))
        return rc, buf.getvalue()

    def _set_baseline(self, **counts):
        base = {name: 0 for name in mod.TOKENS}
        base.update(counts)
        with open(self.baseline, "w", encoding="utf-8") as f:
            json.dump({"counts": base}, f)

    def test_scan_skips_tests_and_migrations(self):
        totals, per_file = mod.scan()
        self.assertEqual(totals["rowid"], 1)
        self.assertEqual(list(per_file), [os.path.join("db", "a.ts")])

    def test_check_passes_at_baseline(self):
        self._set_baseline(rowid=1)
        rc, out = self._run()
        self.assertEqual(rc, 0, out)
        self.assertIn("OK", out)

    def test_check_fails_when_a_count_grows(self):
        self._set_baseline(rowid=0)
        rc, out = self._run()
        self.assertEqual(rc, 1)
        self.assertIn("GREW rowid", out)

    def test_check_passes_and_hints_when_a_count_shrinks(self):
        self._set_baseline(rowid=5)
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("shrunk rowid", out)

    def test_missing_baseline_is_a_hard_failure(self):
        rc, out = self._run()
        self.assertEqual(rc, 2)
        self.assertIn("FAIL", out)

    def test_update_refuses_to_raise_without_the_flag(self):
        self._set_baseline(rowid=0)
        rc, out = self._run("--update")
        self.assertEqual(rc, 1)
        self.assertIn("REFUSED", out)
        with open(self.baseline, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["counts"]["rowid"], 0)

    def test_update_lowers_the_baseline(self):
        self._set_baseline(rowid=5)
        rc, _ = self._run("--update")
        self.assertEqual(rc, 0)
        with open(self.baseline, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["counts"]["rowid"], 1)

    def test_update_with_allow_increase_raises(self):
        self._set_baseline(rowid=0)
        rc, _ = self._run("--update", "--allow-increase")
        self.assertEqual(rc, 0)
        with open(self.baseline, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["counts"]["rowid"], 1)

    def test_first_update_without_a_baseline_creates_it(self):
        rc, _ = self._run("--update")
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(self.baseline))

    def test_report_lists_files(self):
        rc, out = self._run("--report")
        self.assertEqual(rc, 0)
        self.assertIn("a.ts", out)


class UntypedCaseParamLockInTest(unittest.TestCase):
    """The committed baseline holds `CASE WHEN ? THEN` at 0: PostgreSQL cannot type the
    bare parameter, so the shape must not come back. These tests use the REAL committed
    baseline (only the scanned source tree is a throwaway), so raising the committed
    number again, or dropping the token, fails here."""

    TOKEN = "CASE WHEN ? THEN"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = os.path.join(self.tmp.name, "src")
        # the committed baseline, resolved from the script location (not the patched path)
        self.committed = os.path.join(os.path.dirname(_SCRIPT_PATH), "sqlite-dialect-baseline.json")
        patcher = patch.multiple(mod, SRC_DIR=self.src, BASELINE_PATH=self.committed)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = mod.main([])
        return rc, buf.getvalue()

    def test_committed_baseline_holds_the_token_at_zero(self):
        counts = mod.load_baseline(self.committed)
        self.assertIn(self.TOKEN, counts)
        self.assertEqual(counts[self.TOKEN], 0)

    def test_a_reintroduced_untyped_case_parameter_fails_the_check(self):
        _write(self.src, "db/q.ts", "db.prepare('UPDATE t SET d = CASE WHEN ? THEN NULL ELSE d END')\n")
        rc, out = self._run()
        self.assertEqual(rc, 1, out)
        self.assertIn("GREW " + self.TOKEN, out)

    def test_a_typed_form_does_not_trip_the_lock_in(self):
        _write(self.src, "db/q.ts", "db.prepare('UPDATE t SET d = CASE WHEN col = ? THEN NULL ELSE d END')\n")
        rc, out = self._run()
        self.assertEqual(rc, 0, out)
        self.assertNotIn("GREW", out)

    def test_the_real_source_tree_has_none(self):
        totals, per_file = mod.scan(os.path.join(os.path.dirname(os.path.dirname(_SCRIPT_PATH)), "src"))
        self.assertEqual(totals[self.TOKEN], 0, per_file)


if __name__ == "__main__":
    unittest.main()
