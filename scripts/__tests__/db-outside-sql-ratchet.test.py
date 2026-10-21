#!/usr/bin/env python3
"""Unit tests for scripts/db-outside-sql-ratchet.py.

The pure helpers are tested directly; scan() and main() run against a throwaway repo tree and baseline
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

_SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "db-outside-sql-ratchet.py",
)
_spec = importlib.util.spec_from_file_location("db_outside_sql_ratchet", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]


def _write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _run(argv, root, baseline_path):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = mod.main(argv, root=root, baseline_path=baseline_path)
    return code, out.getvalue()


class CountTextTest(unittest.TestCase):
    def test_counts_each_construct(self):
        c = mod.count_text("const d = getDb(); d.prepare('SELECT 1').get(); d.transaction(() => 1)()")
        self.assertEqual(c, {"prepare": 1, "getDb": 1, "transaction": 1})

    def test_comments_are_ignored(self):
        text = "/* db.prepare('x') and getDb() */\n// db.transaction(() => 1)\nconst a = 1\n"
        self.assertEqual(mod.count_text(text), {"prepare": 0, "getDb": 0, "transaction": 0})

    def test_a_longer_name_is_not_getDb(self):
        self.assertEqual(mod.count_text("const x = forgetDb()")["getDb"], 0)
        self.assertEqual(mod.count_text("function getDb() {}")["getDb"], 1)

    def test_whitespace_before_the_paren_still_counts(self):
        c = mod.count_text("db\n  .prepare (\n'x')")
        self.assertEqual(c["prepare"], 1)


class IsScannedTest(unittest.TestCase):
    def test_the_db_layer_tests_and_generated_code_are_not_scanned(self):
        for rel in ("src/db/tasks.ts", "src/db/sub/x.ts", "src/db.ts", "src/__tests__/a.ts", "src/a.test.ts",
                    "src/migrations/0001.ts", "src/generated/api.ts", "src/types.d.ts", "scripts/__tests__/b.ts"):
            self.assertFalse(mod.is_scanned(rel), rel)

    def test_production_code_outside_the_layer_is_scanned(self):
        for rel in ("src/intel-store.ts", "src/web/routes/x.ts", "scripts/dashboard-user.ts", "src/db-migrations.ts"):
            self.assertTrue(mod.is_scanned(rel), rel)

    def test_a_directory_that_only_starts_like_the_layer_is_scanned(self):
        # src/db-extra/ is not src/db/
        self.assertTrue(mod.is_scanned("src/db-extra/x.ts"))


class ScanAndMainTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.baseline = os.path.join(self.root, "baseline.json")
        _write(self.root, "src/db/layer.ts", "db.prepare('x'); getDb(); db.transaction(() => 1)")
        _write(self.root, "src/clean.ts", "import { thing } from './db/layer.js'\nthing()\n")
        _write(self.root, "src/legacy.ts", "db.prepare('a'); db.prepare('b')\n")

    def tearDown(self):
        self._tmp.cleanup()

    def test_scan_skips_the_db_layer_and_clean_files(self):
        self.assertEqual(mod.scan(self.root), {"src/legacy.ts": {"prepare": 2}})

    def test_update_then_check_passes(self):
        self.assertEqual(_run(["--update"], self.root, self.baseline)[0], 0)
        code, out = _run([], self.root, self.baseline)
        self.assertEqual(code, 0)
        self.assertIn("OK db-outside-sql ratchet", out)

    def test_a_grown_count_fails(self):
        _run(["--update"], self.root, self.baseline)
        _write(self.root, "src/legacy.ts", "db.prepare('a'); db.prepare('b'); db.prepare('c')\n")
        code, out = _run([], self.root, self.baseline)
        self.assertEqual(code, 1)
        self.assertIn("GREW src/legacy.ts prepare: baseline 2 -> now 3", out)

    def test_a_new_file_with_raw_sql_fails(self):
        _run(["--update"], self.root, self.baseline)
        _write(self.root, "src/fresh.ts", "const d = getDb()\n")
        code, out = _run([], self.root, self.baseline)
        self.assertEqual(code, 1)
        self.assertIn("NEW FILE", out)
        self.assertIn("src/fresh.ts", out)

    def test_a_new_token_kind_in_a_baselined_file_fails(self):
        _run(["--update"], self.root, self.baseline)
        _write(self.root, "src/legacy.ts", "db.prepare('a'); db.prepare('b'); db.transaction(() => 1)()\n")
        code, out = _run([], self.root, self.baseline)
        self.assertEqual(code, 1)
        self.assertIn("transaction", out)

    def test_moving_a_statement_into_the_db_layer_shrinks_and_passes(self):
        _run(["--update"], self.root, self.baseline)
        _write(self.root, "src/legacy.ts", "import { moved } from './db/layer.js'\nmoved()\n")
        code, out = _run([], self.root, self.baseline)
        self.assertEqual(code, 0)
        self.assertIn("shrunk src/legacy.ts prepare: baseline 2 -> now 0", out)

    def test_update_refuses_to_raise_without_the_flag_and_allows_it_with(self):
        _run(["--update"], self.root, self.baseline)
        _write(self.root, "src/fresh.ts", "const d = getDb()\n")
        code, out = _run(["--update"], self.root, self.baseline)
        self.assertEqual(code, 1)
        self.assertIn("REFUSED to add", out)
        self.assertEqual(_run(["--update", "--allow-increase"], self.root, self.baseline)[0], 0)
        self.assertEqual(_run([], self.root, self.baseline)[0], 0)

    def test_a_note_is_stored_and_dropped_with_its_file(self):
        _run(["--update", "--note", "src/legacy.ts=separate connection"], self.root, self.baseline)
        with open(self.baseline, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["notes"], {"src/legacy.ts": "separate connection"})
        _write(self.root, "src/legacy.ts", "const a = 1\n")
        _run(["--update"], self.root, self.baseline)
        with open(self.baseline, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["files"], {})
        self.assertEqual(data["notes"], {})

    def test_a_missing_baseline_is_exit_2(self):
        self.assertEqual(_run([], self.root, os.path.join(self.root, "nope.json"))[0], 2)

    def test_report_lists_the_note(self):
        _run(["--update", "--note", "src/legacy.ts=why it stays"], self.root, self.baseline)
        code, out = _run(["--report"], self.root, self.baseline)
        self.assertEqual(code, 0)
        self.assertIn("why it stays", out)


class RealTreeTest(unittest.TestCase):
    def test_the_committed_baseline_matches_the_real_tree(self):
        files, _ = mod.load_baseline()
        grown, new_files, _ = mod.compare(mod.scan(), files)
        self.assertEqual((grown, new_files), ([], []))

    def test_the_three_moved_files_stay_clean(self):
        files, _ = mod.load_baseline()
        for rel in ("src/skill-sync.ts", "src/otel-signals.ts", "src/agent-tokens.ts"):
            self.assertNotIn(rel, files)


if __name__ == "__main__":
    unittest.main()
