#!/usr/bin/env python3
"""Tests for scripts/gmail-send-route-ratchet.py: a third file naming a Gmail REST send route fails.

Temp trees only (no git), neutral fixture content. Run: python3 <thisfile>
"""
import importlib.util
import io
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "gmail-send-route-ratchet.py")
_spec = importlib.util.spec_from_file_location("gmail_send_route_ratchet", SCRIPT)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

ROUTE_LINE = 'URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"\n'


class Tree(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="route-ratchet-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def put(self, rel, text="", binary=None):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(binary if binary is not None else text.encode("utf-8"))

    def run_main(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = mod.main(["--root", self.root])
        return code, out.getvalue()

    def allowed_only(self):
        for rel in mod.ALLOWED:
            self.put(rel, ROUTE_LINE)


class TheRepository(unittest.TestCase):
    def test_the_repository_itself_passes(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = mod.main([])
        self.assertEqual(code, 0, out.getvalue())

    def test_the_allowed_list_is_the_two_senders_and_the_recognition_only(self):
        self.assertEqual(sorted(mod.ALLOWED), ["scripts/gmail-send.py", "scripts/lib/email_extract.py", "scripts/send-digest-email.py"])
        for reason in mod.ALLOWED.values():
            self.assertTrue(reason.strip())


class TheCheck(Tree):
    def test_the_allowed_files_alone_pass(self):
        self.allowed_only()
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("OK", out)

    def test_a_third_sender_fails_whatever_it_is_written_in(self):
        self.allowed_only()
        for rel, text in [
            ("scripts/new-sender.py", ROUTE_LINE),
            ("scripts/new-sender.sh", "curl -s -X POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send -d @r.json\n"),
            ("src/mail.ts", "const u = '/gmail/v1/users/me/messages/send'\n"),
            ("seed-skills/mail/SKILL.md", "Send it with curl to /gmail/v1/users/me/messages/send directly.\n"),
            ("templates/x.template", "POST /gmail/v1/users/me/drafts/send\n"),
            ("scripts/upload.py", "u = 'https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media'\n"),
        ]:
            with self.subTest(rel=rel):
                self.put(rel, text)
                code, out = self.run_main()
                self.assertEqual(code, 1, out)
                self.assertIn("FAIL: %s " % rel, out)
                os.remove(os.path.join(self.root, rel))

    def test_a_file_that_is_allowed_only_by_a_look_alike_name_fails(self):
        self.allowed_only()
        for rel in ("scripts/gmail-send.py.bak", "scripts/gmail-send2.py", "scripts/lib/email_extract2.py", "other/scripts/send-digest-email.py"):
            with self.subTest(rel=rel):
                self.put(rel, ROUTE_LINE)
                code, out = self.run_main()
                self.assertEqual(code, 1, out)
                os.remove(os.path.join(self.root, rel))

    def test_documentation_and_tests_may_name_the_route(self):
        self.allowed_only()
        for rel in ("CHANGELOG.md", "SECURITY.md", "README.md", "docs/openapi.yaml", "docs/fork-guide/en/x.md",
                    "scripts/__tests__/some.test.py", "src/__tests__/some.test.ts", "node_modules/pkg/index.js", "dist/x.js", "store/x.txt"):
            self.put(rel, ROUTE_LINE)
        code, out = self.run_main()
        self.assertEqual(code, 0, out)

    def test_a_binary_file_is_not_read_as_text(self):
        self.allowed_only()
        self.put("assets/blob.bin", binary=b"\0\1\2" + ROUTE_LINE.encode())
        code, out = self.run_main()
        self.assertEqual(code, 0, out)

    def test_an_allowed_entry_that_no_longer_names_a_route_is_reported_not_failed(self):
        self.allowed_only()
        self.put("scripts/send-digest-email.py", "print('no route here')\n")
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("note: scripts/send-digest-email.py", out)

    def test_two_offenders_are_both_named(self):
        self.allowed_only()
        self.put("scripts/a.py", ROUTE_LINE)
        self.put("scripts/b.py", ROUTE_LINE)
        code, out = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("FAIL: scripts/a.py", out)
        self.assertIn("FAIL: scripts/b.py", out)

    def test_bad_usage_and_a_missing_root_are_exit_2(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(mod.main(["--bogus"]), 2)
            self.assertEqual(mod.main(["--root", os.path.join(self.root, "nope")]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
