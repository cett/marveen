#!/usr/bin/env python3
"""Unit tests for scripts/send-digest-email.py.

Covers the pure-logic helpers (strip_untrusted_banner, build_raw_mime)
directly, the low-level Gmail/dashboard fetch helpers with a mocked
urllib.request.urlopen, and main()'s full outcome contract (SKIP_NO_DIGEST,
DIGEST_FETCH_FAIL, MISSING_CREDS, DRY-OK, TOKEN_REFRESH_FAIL, SEND_FAIL,
SENT id=...) via mocked module-level functions.

Privacy: only neutral fixture data (example.invalid addresses, fixture
tokens); no real email address, credential, or chat ID.
"""
import base64
import importlib.util
import io
import json
import os
import tempfile
import unittest
from email import message_from_bytes
from email.header import decode_header, make_header
from unittest.mock import MagicMock, patch

_SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "send-digest-email.py",
)

_spec = importlib.util.spec_from_file_location("send_digest_email", _SCRIPT_PATH)
mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(mod)  # type: ignore[union-attr]


def _fake_response(payload_bytes):
    resp = MagicMock()
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    resp.read.return_value = payload_bytes
    return resp


class TestStripUntrustedBanner(unittest.TestCase):
    def test_removes_banner_and_following_blank_line(self):
        content = "<!-- UNTRUSTED-RSS fixture note -->\n\nActual digest text"
        self.assertEqual(mod.strip_untrusted_banner(content), "Actual digest text")

    def test_removes_banner_without_blank_line(self):
        content = "<!-- UNTRUSTED-RSS fixture note -->\nActual digest text"
        self.assertEqual(mod.strip_untrusted_banner(content), "Actual digest text")

    def test_leaves_content_without_banner_unchanged(self):
        content = "Just a normal digest\nwith two lines"
        self.assertEqual(mod.strip_untrusted_banner(content), content)


class TestBuildRawMime(unittest.TestCase):
    def test_produces_valid_base64url_with_correct_recipient(self):
        raw = mod.build_raw_mime("recipient@example.invalid", "Subject line", "Body text")
        decoded = base64.urlsafe_b64decode(raw.encode("ascii"))
        msg = message_from_bytes(decoded)
        self.assertEqual(msg["To"], "recipient@example.invalid")
        self.assertEqual(msg.get_payload(decode=True).decode("utf-8"), "Body text")

    def test_encodes_non_ascii_subject_rfc2047(self):
        raw = mod.build_raw_mime(
            "recipient@example.invalid", "Árvíztűrő tükörfúrógép", "Body"
        )
        decoded = base64.urlsafe_b64decode(raw.encode("ascii"))
        msg = message_from_bytes(decoded)
        subject_header = msg["Subject"]
        self.assertTrue(subject_header.startswith("=?utf-8?"))
        decoded_subject = str(make_header(decode_header(subject_header)))
        self.assertEqual(decoded_subject, "Árvíztűrő tükörfúrógép")


class TestBuildSignature(unittest.TestCase):
    def test_uses_env_vars_over_dotenv_and_default(self):
        with patch.dict(
            os.environ, {"BOT_NAME": "FixtureBot", "OWNER_NAME": "Fixture Owner"}, clear=False
        ):
            self.assertEqual(
                mod.build_signature(), "\n\n--\nFixtureBot, Fixture Owner AI asszisztense"
            )

    def test_falls_back_to_generic_defaults_when_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOT_NAME", None)
            os.environ.pop("OWNER_NAME", None)
            with patch.object(mod, "_load_dotenv", return_value={}):
                self.assertEqual(mod.build_signature(), "\n\n--\nMarveen, Owner AI asszisztense")

    def test_falls_back_to_dotenv_when_env_var_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOT_NAME", None)
            os.environ.pop("OWNER_NAME", None)
            with patch.object(
                mod,
                "_load_dotenv",
                return_value={"BOT_NAME": "DotenvBot", "OWNER_NAME": "Dotenv Owner"},
            ):
                self.assertEqual(
                    mod.build_signature(), "\n\n--\nDotenvBot, Dotenv Owner AI asszisztense"
                )


class TestFetchDigestContent(unittest.TestCase):
    def test_returns_content_of_first_item(self):
        payload = json.dumps({"items": [{"content": "digest body"}]}).encode()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".token") as tok:
            tok.write("fixture-dashboard-token")
            tok.flush()
            with patch.object(mod, "DASHBOARD_TOKEN_FILE", tok.name), patch.object(
                mod.urllib.request, "urlopen", return_value=_fake_response(payload)
            ):
                result = mod.fetch_digest_content("2026-01-01")
        self.assertEqual(result, "digest body")

    def test_returns_none_when_items_empty(self):
        payload = json.dumps({"items": []}).encode()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".token") as tok:
            tok.write("fixture-dashboard-token")
            tok.flush()
            with patch.object(mod, "DASHBOARD_TOKEN_FILE", tok.name), patch.object(
                mod.urllib.request, "urlopen", return_value=_fake_response(payload)
            ):
                result = mod.fetch_digest_content("2026-01-01")
        self.assertIsNone(result)


class TestFetchOwnEmailAddress(unittest.TestCase):
    def test_returns_email_address_from_profile(self):
        payload = json.dumps({"emailAddress": "recipient@example.invalid"}).encode()
        with patch.object(
            mod.urllib.request, "urlopen", return_value=_fake_response(payload)
        ):
            result = mod.fetch_own_email_address("fake-access-token")
        self.assertEqual(result, "recipient@example.invalid")


class TestSendViaGmail(unittest.TestCase):
    def test_returns_parsed_json_response(self):
        payload = json.dumps({"id": "msg-fixture-id"}).encode()
        with patch.object(
            mod.urllib.request, "urlopen", return_value=_fake_response(payload)
        ):
            result = mod.send_via_gmail("fake-access-token", "fixture-raw-mime")
        self.assertEqual(result, {"id": "msg-fixture-id"})


class TestMainBranches(unittest.TestCase):
    def _run_main(self, argv=None):
        argv = argv or []
        with patch("sys.stdout", new_callable=io.StringIO) as out:
            code = mod.main(argv)
        return code, out.getvalue().strip()

    @patch.object(mod, "fetch_digest_content")
    def test_digest_fetch_fail(self, mock_fetch):
        mock_fetch.side_effect = Exception("fixture failure")
        code, output = self._run_main()
        self.assertEqual(code, 1)
        self.assertEqual(output, "DIGEST_FETCH_FAIL")

    @patch.object(mod, "fetch_digest_content", return_value=None)
    def test_skip_no_digest(self, _mock):
        code, output = self._run_main()
        self.assertEqual(code, 0)
        self.assertEqual(output, "SKIP_NO_DIGEST")

    @patch.object(mod, "fetch_digest_content", return_value="Digest body text")
    def test_missing_creds(self, _mock):
        with patch.object(mod, "TOKEN_FILE", "/nonexistent/fixture-token.json"), patch.object(
            mod, "CREDENTIALS_FILE", "/nonexistent/fixture-creds.json"
        ):
            code, output = self._run_main()
        self.assertEqual(code, 1)
        self.assertEqual(output, "MISSING_CREDS")

    @patch.object(mod, "fetch_digest_content", return_value="Digest body text")
    def test_dry_run_ok(self, _mock):
        with tempfile.NamedTemporaryFile() as tok, tempfile.NamedTemporaryFile() as cred:
            with patch.object(mod, "TOKEN_FILE", tok.name), patch.object(
                mod, "CREDENTIALS_FILE", cred.name
            ):
                code, output = self._run_main(["--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(output, "DRY-OK")

    @patch.object(mod, "refresh_access_token")
    @patch.object(mod, "fetch_digest_content", return_value="Digest body text")
    def test_token_refresh_fail(self, _mock_digest, mock_refresh):
        mock_refresh.side_effect = Exception("fixture failure")
        with tempfile.NamedTemporaryFile() as tok, tempfile.NamedTemporaryFile() as cred:
            with patch.object(mod, "TOKEN_FILE", tok.name), patch.object(
                mod, "CREDENTIALS_FILE", cred.name
            ):
                code, output = self._run_main()
        self.assertEqual(code, 1)
        self.assertEqual(output, "TOKEN_REFRESH_FAIL")

    @patch.object(mod, "fetch_own_email_address")
    @patch.object(mod, "refresh_access_token", return_value="fake-access-token")
    @patch.object(mod, "fetch_digest_content", return_value="Digest body text")
    def test_send_fail(self, _mock_digest, _mock_refresh, mock_fetch_email):
        mock_fetch_email.side_effect = Exception("fixture failure")
        with tempfile.NamedTemporaryFile() as tok, tempfile.NamedTemporaryFile() as cred:
            with patch.object(mod, "TOKEN_FILE", tok.name), patch.object(
                mod, "CREDENTIALS_FILE", cred.name
            ):
                code, output = self._run_main()
        self.assertEqual(code, 1)
        self.assertEqual(output, "SEND_FAIL")

    @patch.object(mod, "send_via_gmail", return_value={"id": "msg-fixture-id"})
    @patch.object(mod, "fetch_own_email_address", return_value="recipient@example.invalid")
    @patch.object(mod, "refresh_access_token", return_value="fake-access-token")
    @patch.object(mod, "fetch_digest_content", return_value="Digest body text")
    def test_sent_success(self, _mock_digest, _mock_refresh, _mock_email, _mock_send):
        with tempfile.NamedTemporaryFile() as tok, tempfile.NamedTemporaryFile() as cred:
            with patch.object(mod, "TOKEN_FILE", tok.name), patch.object(
                mod, "CREDENTIALS_FILE", cred.name
            ):
                code, output = self._run_main()
        self.assertEqual(code, 0)
        self.assertEqual(output, "SENT id=msg-fixture-id")


if __name__ == "__main__":
    unittest.main()
