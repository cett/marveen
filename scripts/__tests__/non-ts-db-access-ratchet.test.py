#!/usr/bin/env python3
"""Unit tests for scripts/non-ts-db-access-ratchet.py.

Pure helpers (is_scanned, strip_comments, count_text, compare, unclassified) are
tested directly; scan() and main() run against a throwaway repo tree and baseline
file, so the real repository never influences the result.

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
    "non-ts-db-access-ratchet.py",
)
_spec = importlib.util.spec_from_file_location("non_ts_db_access_ratchet", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]


def _write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _run_main(root, baseline_path, argv):
    out = io.StringIO()
    with patch.object(mod, "REPO_ROOT", root), patch.object(mod, "BASELINE_PATH", baseline_path):
        with contextlib.redirect_stdout(out):
            code = mod.main(argv)
    return code, out.getvalue()


class IsScannedTest(unittest.TestCase):
    def test_scanned_locations(self):
        for rel in ("scripts/a.py", "scripts/hooks/b.sh", "seed-skills/x/SKILL.md", "templates/CLAUDE.md.template",
                    "scheduled-tasks/t/SKILL.md", "seed-scheduled-tasks/k/pre-check.sh", "update.sh", "scripts/status.ts"):
            self.assertTrue(mod.is_scanned(rel), rel)

    def test_not_scanned_locations(self):
        for rel in ("docs/guide.md", "src/db/x.ts", "README.md", "scripts/__tests__/a.test.py", "scripts/eval/run.ts",
                    "node_modules/p/i.js", "scripts/x.test.ts", "scripts/data.json", "web/app.js"):
            self.assertFalse(mod.is_scanned(rel), rel)

    def test_root_markdown_is_not_scanned_but_root_shell_is(self):
        self.assertFalse(mod.is_scanned("NOTES.md"))
        self.assertTrue(mod.is_scanned("install-linux.sh"))

    def test_the_ratchets_do_not_scan_themselves(self):
        self.assertFalse(mod.is_scanned("scripts/non-ts-db-access-ratchet.py"))
        self.assertFalse(mod.is_scanned("scripts/sqlite-dialect-ratchet.py"))


class StripCommentsTest(unittest.TestCase):
    def test_python_and_shell_hash_lines_dropped_shebang_kept(self):
        text = "#!/usr/bin/env python3\n# import sqlite3\nimport os\n"
        out = mod.strip_comments(text, "scripts/a.py")
        self.assertIn("#!/usr/bin/env python3", out)
        self.assertNotIn("import sqlite3", out)

    def test_trailing_hash_is_kept(self):
        self.assertIn("claudeclaw.db", mod.strip_comments('x = "claudeclaw.db"  # note\n', "scripts/a.py"))

    def test_markdown_is_never_stripped(self):
        text = "# Heading\nsqlite3 store/claudeclaw.db 'SELECT 1'\n"
        self.assertEqual(mod.strip_comments(text, "seed-skills/s/SKILL.md"), text)

    def test_js_comments_dropped(self):
        text = "/* better-sqlite3 */\n// better-sqlite3\nconst a = 1\n"
        self.assertNotIn("better-sqlite3", mod.strip_comments(text, "scripts/a.mjs"))


class CountTextTest(unittest.TestCase):
    def test_python_module_use(self):
        direct, _ = mod.count_text("import sqlite3\ncon = sqlite3.connect(p)\n", "scripts/a.py")
        self.assertEqual(direct, {"python sqlite3": 1, "sqlite3.connect": 1})

    def test_from_import_counts(self):
        direct, _ = mod.count_text("from sqlite3 import Row\n", "scripts/a.py")
        self.assertEqual(direct.get("python sqlite3"), 1)

    def test_cli_with_quote_variable_placeholder_and_path(self):
        text = (
            'sqlite3 "$DB" "SELECT 1"\n'
            "sqlite3 $DB 'x'\n"
            "sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db \"SELECT 2\"\n"
            "sqlite3 -readonly ./x.db 'y'\n"
            "sqlite3 store/claudeclaw.db '.tables'\n"
        )
        direct, _ = mod.count_text(text, "scripts/a.sh")
        self.assertEqual(direct["sqlite3 CLI"], 5)

    def test_prose_and_presence_checks_are_not_cli_calls(self):
        text = (
            "command -v sqlite3 >/dev/null 2>&1 || exit 1\n"
            "the sqlite3 CLI is optional\n"
            "Tolerate a missing sqlite3 binary\n"
        )
        direct, _ = mod.count_text(text, "scripts/a.sh")
        self.assertNotIn("sqlite3 CLI", direct)

    def test_db_paths_and_binding(self):
        direct, _ = mod.count_text("A=store/claudeclaw.db B=store/intel.db npm rebuild better-sqlite3\n", "update.sh")
        self.assertEqual(direct, {"claudeclaw.db": 1, "intel.db": 1, "better-sqlite3": 1})

    def test_no_direct_access_means_no_dialect_counts(self):
        direct, dialect = mod.count_text("print(time.strftime('%Y'))  # unixepoch()\nx = 'INSERT OR IGNORE'\n", "scripts/a.py")
        self.assertEqual((direct, dialect), ({}, {}))

    def test_dialect_counted_only_with_direct_access(self):
        text = "import sqlite3\nq = 'INSERT OR IGNORE INTO t VALUES (unixepoch())'\nPRAGMA foreign_keys\n"
        direct, dialect = mod.count_text(text, "scripts/a.py")
        self.assertTrue(direct)
        self.assertEqual(dialect["INSERT OR IGNORE"], 1)
        self.assertEqual(dialect["unixepoch()"], 1)
        self.assertEqual(dialect["PRAGMA"], 1)

    def test_python_time_strftime_is_not_sql(self):
        _, dialect = mod.count_text("import sqlite3\nx = time.strftime('%Y')\ny = dt.strftime('%m')\n", "scripts/a.py")
        self.assertNotIn("strftime()", dialect)

    def test_sql_strftime_is_counted(self):
        _, dialect = mod.count_text("import sqlite3\nq = \"SELECT strftime('%s','now')\"\n", "scripts/a.py")
        self.assertEqual(dialect["strftime()"], 1)


class ScanTest(unittest.TestCase):
    def test_scan_collects_only_files_with_direct_access(self):
        with tempfile.TemporaryDirectory() as root:
            _write(root, "scripts/a.py", "import sqlite3\n")
            _write(root, "scripts/clean.py", "import os\n")
            _write(root, "scripts/__tests__/helper.py", "import sqlite3\n")
            _write(root, "docs/x.md", "sqlite3 store/claudeclaw.db\n")
            _write(root, "update.sh", "npm rebuild better-sqlite3\n")
            got = mod.scan(root)
        self.assertEqual(sorted(got), ["scripts/a.py", "update.sh"])
        self.assertEqual(got["scripts/a.py"]["direct"], {"python sqlite3": 1})


class CompareTest(unittest.TestCase):
    def test_growth_shrink_new_and_gone(self):
        base = {
            "a.sh": {"direct": {"sqlite3 CLI": 2}, "dialect": {}},
            "b.sh": {"direct": {"sqlite3 CLI": 3}, "dialect": {"PRAGMA": 1}},
            "gone.sh": {"direct": {"sqlite3 CLI": 1}, "dialect": {}},
        }
        cur = {
            "a.sh": {"direct": {"sqlite3 CLI": 3}, "dialect": {}},
            "b.sh": {"direct": {"sqlite3 CLI": 1}, "dialect": {}},
            "new.sh": {"direct": {"sqlite3 CLI": 1}, "dialect": {}},
        }
        grown, shrunk, new_files, gone_files = mod.compare(cur, base)
        self.assertEqual(grown, [("a.sh", "direct", "sqlite3 CLI", 2, 3)])
        self.assertIn(("b.sh", "direct", "sqlite3 CLI", 3, 1), shrunk)
        self.assertIn(("b.sh", "dialect", "PRAGMA", 1, 0), shrunk)
        self.assertIn(("gone.sh", "direct", "sqlite3 CLI", 1, 0), shrunk)
        self.assertEqual(new_files, ["new.sh"])
        self.assertEqual(gone_files, ["gone.sh"])

    def test_new_token_kind_in_known_file_is_growth(self):
        base = {"a.py": {"direct": {"python sqlite3": 1}, "dialect": {}}}
        cur = {"a.py": {"direct": {"python sqlite3": 1, "sqlite3.connect": 1}, "dialect": {}}}
        grown, _, new_files, _ = mod.compare(cur, base)
        self.assertEqual(grown, [("a.py", "direct", "sqlite3.connect", 0, 1)])
        self.assertEqual(new_files, [])

    def test_dialect_growth_is_detected(self):
        base = {"a.py": {"direct": {"python sqlite3": 1}, "dialect": {"PRAGMA": 1}}}
        cur = {"a.py": {"direct": {"python sqlite3": 1}, "dialect": {"PRAGMA": 2}}}
        grown, _, _, _ = mod.compare(cur, base)
        self.assertEqual(grown, [("a.py", "dialect", "PRAGMA", 1, 2)])

    def test_unclassified(self):
        cur = {"a": {}, "b": {}, "c": {}}
        self.assertEqual(mod.unclassified(cur, {"a": "B", "b": "Z"}), ["b", "c"])


class MainTest(unittest.TestCase):
    def _tree(self, root):
        _write(root, "scripts/a.py", "import sqlite3\ncon = sqlite3.connect(p)\n")
        _write(root, "scripts/b.sh", 'sqlite3 "$DB" "SELECT 1"\n')

    def test_update_requires_a_disposition_for_every_file(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            code, out = _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B"])
            self.assertEqual(code, 1)
            self.assertIn("scripts/b.sh has no disposition", out)
            self.assertFalse(os.path.exists(bl))

    def test_update_then_check_passes(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            code, _ = _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            self.assertEqual(code, 0)
            code, out = _run_main(root, bl, [])
            self.assertEqual(code, 0, out)
            self.assertIn("B=1", out)
            self.assertIn("C=1", out)

    def test_growth_in_a_known_file_fails(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            _write(root, "scripts/b.sh", 'sqlite3 "$DB" "SELECT 1"\nsqlite3 "$DB" "SELECT 2"\n')
            code, out = _run_main(root, bl, [])
            self.assertEqual(code, 1)
            self.assertIn("GREW scripts/b.sh", out)

    def test_new_accessor_file_fails_even_when_another_shrinks(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            os.remove(os.path.join(root, "scripts/b.sh"))
            _write(root, "scripts/c.sh", 'sqlite3 "$DB" "SELECT 1"\n')
            code, out = _run_main(root, bl, [])
            self.assertEqual(code, 1)
            self.assertIn("NEW direct DB access file: scripts/c.sh", out)

    def test_classified_but_not_baselined_file_is_still_a_new_file(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            _write(root, "scripts/c.sh", 'sqlite3 "$DB" "SELECT 1"\n')
            with open(bl, encoding="utf-8") as f:
                data = json.load(f)
            data["dispositions"]["scripts/c.sh"] = "C"  # classified, but never baselined
            with open(bl, "w", encoding="utf-8") as f:
                json.dump(data, f)
            code, out = _run_main(root, bl, [])
            self.assertEqual(code, 1)
            self.assertIn("NEW direct DB access file: scripts/c.sh", out)
            self.assertNotIn("UNCLASSIFIED", out)

    def test_shrink_passes_and_update_locks_it_in(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            os.remove(os.path.join(root, "scripts/b.sh"))
            code, out = _run_main(root, bl, [])
            self.assertEqual(code, 0)
            self.assertIn("shrunk scripts/b.sh", out)
            code, _ = _run_main(root, bl, ["--update"])
            self.assertEqual(code, 0)
            with open(bl, encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(sorted(data["files"]), ["scripts/a.py"])
            self.assertEqual(sorted(data["dispositions"]), ["scripts/a.py"])

    def test_unclassified_baseline_entry_fails_the_check(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            with open(bl, encoding="utf-8") as f:
                data = json.load(f)
            del data["dispositions"]["scripts/b.sh"]
            with open(bl, "w", encoding="utf-8") as f:
                json.dump(data, f)
            code, out = _run_main(root, bl, [])
            self.assertEqual(code, 1)
            self.assertIn("UNCLASSIFIED scripts/b.sh", out)

    def test_update_refuses_growth_without_allow_increase(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            bl = os.path.join(root, "baseline.json")
            _run_main(root, bl, ["--update", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            _write(root, "scripts/new.py", "import sqlite3\n")
            code, out = _run_main(root, bl, ["--update", "--classify", "scripts/new.py=B"])
            self.assertEqual(code, 1)
            self.assertIn("REFUSED to add new direct-access file scripts/new.py", out)
            code, _ = _run_main(root, bl, ["--update", "--allow-increase", "--classify", "scripts/new.py=B"])
            self.assertEqual(code, 0)

    def test_bad_classify_value_is_a_usage_error(self):
        with tempfile.TemporaryDirectory() as root:
            code, out = _run_main(root, os.path.join(root, "b.json"), ["--update", "--classify", "scripts/a.py=Q"])
            self.assertEqual(code, 2)
            self.assertIn("bad --classify", out)

    def test_missing_baseline_is_exit_2(self):
        with tempfile.TemporaryDirectory() as root:
            code, out = _run_main(root, os.path.join(root, "missing.json"), [])
            self.assertEqual(code, 2)
            self.assertIn("cannot read baseline", out)

    def test_report_lists_progress_by_disposition(self):
        with tempfile.TemporaryDirectory() as root:
            self._tree(root)
            code, out = _run_main(root, os.path.join(root, "none.json"),
                                  ["--report", "--classify", "scripts/a.py=B", "--classify", "scripts/b.sh=C"])
            self.assertEqual(code, 0)
            self.assertIn("disposition B", out)
            self.assertIn("disposition C", out)


class RealRepoBaselineTest(unittest.TestCase):
    def test_committed_baseline_is_consistent_with_the_tree(self):
        code = mod.main([])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
