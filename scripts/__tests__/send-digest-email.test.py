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
    def _fetch(self, payload, token_text="fixture-own-token"):
        """Run fetch_digest_content with the coordinator's own token file (the resolver's explicit-file
        seam) and return (result, the urlopen mock)."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".token") as tok:
            tok.write(token_text)
            tok.flush()
            with patch.dict(os.environ, {"MARVEEN_AGENT_TOKEN_FILE": tok.name}), patch.object(
                mod.urllib.request, "urlopen", return_value=_fake_response(payload)
            ) as opened:
                return mod.fetch_digest_content("2026-01-01"), opened

    def test_returns_content_of_first_item(self):
        result, opened = self._fetch(json.dumps({"items": [{"content": "digest body"}]}).encode())
        self.assertEqual(result, "digest body")
        self.assertEqual(opened.call_args[0][0].get_header("Authorization"), "Bearer fixture-own-token")

    def test_returns_none_when_items_empty(self):
        result, _ = self._fetch(json.dumps({"items": []}).encode())
        self.assertIsNone(result)

    def test_a_missing_own_token_raises_the_named_fix_and_makes_no_request(self):
        with tempfile.TemporaryDirectory() as empty, patch.dict(
            os.environ, {"MARVEEN_AGENT_TOKEN_FILE": os.path.join(empty, "absent")}
        ), patch.object(mod.urllib.request, "urlopen") as opened:
            with self.assertRaises(OSError):
                mod.fetch_digest_content("2026-01-01")
        opened.assert_not_called()


class TestFetchOwnEmailAddress(unittest.TestCase):
    def test_returns_email_address_from_profile(self):
        payload = json.dumps({"emailAddress": "recipient@example.invalid"}).encode()
        with patch.object(
            mod.urllib.request, "urlopen", return_value=_fake_response(payload)
        ):
            result = mod.fetch_own_email_address("fake-access-token")
        self.assertEqual(result, "recipient@example.invalid")


OWN = "own-mailbox@example.invalid"
OTHER = "someone-else@example.invalid"


def _b64(raw_bytes):
    return base64.urlsafe_b64encode(raw_bytes).decode("ascii")


def _msg(headers, body="Body text"):
    """A hand-assembled raw message (so a test can write headers build_raw_mime() never would)."""
    head = "".join("%s: %s\r\n" % (k, v) for k, v in headers)
    return _b64((head + "\r\n" + body + "\r\n").encode("utf-8"))


_BASE = [("MIME-Version", "1.0"), ("Content-Type", 'text/plain; charset="utf-8"'), ("Subject", "Digest")]


class _FakeGoogle:
    """urlopen stand-in: the profile answers `own`, the send route records what it was given."""

    def __init__(self, own=OWN, send_id="msg-fixture-id"):
        self.own = own
        self.send_id = send_id
        self.urls = []
        self.sent = []

    def __call__(self, req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        self.urls.append(url)
        if url.endswith("/users/me/profile"):
            return _fake_response(json.dumps({"emailAddress": self.own}).encode())
        if url.endswith("/users/me/messages/send"):
            self.sent.append(json.loads(req.data.decode()))
            return _fake_response(json.dumps({"id": self.send_id}).encode())
        raise AssertionError("unexpected request to " + url)


class TestSelfSendGuard(unittest.TestCase):
    """assert_self_addressed(): the digest sender may mail the account's own mailbox and nothing else."""

    def test_the_built_message_for_the_own_address_passes_and_case_does_not_matter(self):
        mod.assert_self_addressed(mod.build_raw_mime(OWN, "Digest", "Body"), OWN)
        mod.assert_self_addressed(mod.build_raw_mime(OWN.upper(), "Digest", "Body"), OWN)
        mod.assert_self_addressed(mod.build_raw_mime(OWN, "Árvíztűrő", "Body"), OWN)

    def test_another_recipient_is_refused(self):
        with self.assertRaises(mod.SelfSendOnly):
            mod.assert_self_addressed(mod.build_raw_mime(OTHER, "Digest", "Body"), OWN)

    def test_the_own_address_with_anything_around_it_is_refused(self):
        for value in (
            "%s, %s" % (OWN, OTHER),          # a list
            "%s, %s" % (OTHER, OWN),
            "Owner <%s>" % OWN,              # a display name: the reader of a different parser could differ
            "<%s>" % OWN,
            '"%s"' % OWN,
            "%s (%s)" % (OWN, OTHER),        # a comment
            "undisclosed-recipients:;",
            "",
        ):
            with self.subTest(to=value):
                with self.assertRaises(mod.SelfSendOnly):
                    mod.assert_self_addressed(_msg(_BASE + [("To", value)]), OWN)

    def test_a_header_that_adds_a_recipient_is_refused(self):
        for name in ("Cc", "Bcc", "Resent-To", "Resent-Cc", "Resent-Bcc", "Reply-To", "From", "Sender", "X-Forward-To"):
            with self.subTest(header=name):
                with self.assertRaises(mod.SelfSendOnly):
                    mod.assert_self_addressed(_msg(_BASE + [("To", OWN), (name, OTHER)]), OWN)

    def test_a_repeated_to_header_is_refused_whichever_comes_first(self):
        with self.assertRaises(mod.SelfSendOnly):
            mod.assert_self_addressed(_msg(_BASE + [("To", OWN), ("To", OTHER)]), OWN)
        with self.assertRaises(mod.SelfSendOnly):
            mod.assert_self_addressed(_msg(_BASE + [("To", OTHER), ("To", OWN)]), OWN)

    def test_two_identical_to_headers_are_refused_too(self):
        # both equal the own address, but a second To is one more thing Gmail and this parser might read differently
        with self.assertRaises(mod.SelfSendOnly):
            mod.assert_self_addressed(_msg(_BASE + [("To", OWN), ("To", OWN)]), OWN)

    def test_a_malformed_header_block_is_refused(self):
        # a line with no colon in the header block: the parser stops reading headers there, Gmail may not
        raw = _b64(("MIME-Version: 1.0\r\ngarbage line\r\nTo: %s\r\n\r\nBody\r\n" % OWN).encode())
        with self.assertRaises(mod.SelfSendOnly):
            mod.assert_self_addressed(raw, OWN)

    def test_a_message_without_a_recipient_is_refused(self):
        with self.assertRaises(mod.SelfSendOnly):
            mod.assert_self_addressed(_msg(_BASE), OWN)

    def test_a_header_smuggled_through_the_subject_is_refused(self):
        # build_raw_mime() puts the subject in as it is; a line break in it must not become a header
        for subject in ("Digest\r\nBcc: %s" % OTHER, "Digest\nBcc: %s" % OTHER, "Digest\r\nTo: %s" % OTHER):
            with self.subTest(subject=subject):
                try:
                    raw = mod.build_raw_mime(OWN, subject, "Body")
                except Exception:
                    continue   # the builder itself refused: fine
                with self.assertRaises(mod.SelfSendOnly):
                    mod.assert_self_addressed(raw, OWN)

    def test_a_recipient_line_in_the_body_is_only_text(self):
        mod.assert_self_addressed(mod.build_raw_mime(OWN, "Digest", "To: %s\nBcc: %s" % (OTHER, OTHER)), OWN)

    def test_what_is_not_a_message_is_refused(self):
        for raw in ("", "not base64 !!!", "ä", None, 5):
            with self.subTest(raw=raw):
                with self.assertRaises(mod.SelfSendOnly):
                    mod.assert_self_addressed(raw, OWN)

    def test_an_unusable_own_address_refuses_everything(self):
        raw = mod.build_raw_mime(OWN, "Digest", "Body")
        for own in (None, "", "  ", "a@b.invalid, c@d.invalid", "Name <a@b.invalid>", "a@b.invalid\r\n", 5):
            with self.subTest(own=own):
                with self.assertRaises(mod.SelfSendOnly):
                    mod.assert_self_addressed(raw, own)


class TestSendRouteIsGuarded(unittest.TestCase):
    """send_via_gmail() is the only way this module reaches the Gmail send route."""

    def test_the_own_mailbox_is_sent_to_after_the_profile_was_read(self):
        google = _FakeGoogle()
        raw = mod.build_raw_mime(OWN, "Digest", "Body")
        with patch.object(mod.urllib.request, "urlopen", google):
            self.assertEqual(mod.send_via_gmail("fixture-token", raw), {"id": "msg-fixture-id"})
        self.assertEqual(len(google.sent), 1)
        self.assertTrue(google.urls[0].endswith("/users/me/profile"), "the profile is read before anything is sent")

    def test_another_recipient_sends_nothing(self):
        google = _FakeGoogle()
        with patch.object(mod.urllib.request, "urlopen", google):
            with self.assertRaises(mod.SelfSendOnly):
                mod.send_via_gmail("fixture-token", mod.build_raw_mime(OTHER, "Digest", "Body"))
        self.assertEqual(google.sent, [])
        self.assertFalse(any(u.endswith("/messages/send") for u in google.urls))

    def test_the_importlib_pattern_does_not_reach_a_foreign_recipient(self):
        # the pattern some skills describe: load the file and call its functions with any address
        spec = importlib.util.spec_from_file_location("digest_loaded_elsewhere", _SCRIPT_PATH)
        other = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(other)
        google = _FakeGoogle()
        with patch.object(other.urllib.request, "urlopen", google):
            with self.assertRaises(other.SelfSendOnly):
                other.send_via_gmail("fixture-token", other.build_raw_mime(OTHER, "Anything", "An outside letter"))
        self.assertEqual(google.sent, [])

    def test_the_caller_cannot_say_what_the_own_address_is(self):
        import inspect
        self.assertEqual(list(inspect.signature(mod.send_via_gmail).parameters), ["access_token", "raw_mime"])

    def test_a_profile_that_is_not_the_recipient_sends_nothing_even_if_the_message_looks_fine(self):
        google = _FakeGoogle(own=OTHER)
        with patch.object(mod.urllib.request, "urlopen", google):
            with self.assertRaises(mod.SelfSendOnly):
                mod.send_via_gmail("fixture-token", mod.build_raw_mime(OWN, "Digest", "Body"))
        self.assertEqual(google.sent, [])

    def test_a_failing_profile_read_sends_nothing(self):
        def boom(req, timeout=None):
            raise OSError("fixture network failure")
        with patch.object(mod.urllib.request, "urlopen", boom):
            with self.assertRaises(OSError):
                mod.send_via_gmail("fixture-token", mod.build_raw_mime(OWN, "Digest", "Body"))


class TestExceptionStillWorks(unittest.TestCase):
    """The reason for the exception: the morning schedule mails the owner's own mailbox with no approval, and keeps doing so."""

    def _run(self, argv=None, env=None, google=None):
        google = google or _FakeGoogle()
        with tempfile.NamedTemporaryFile() as tok, tempfile.NamedTemporaryFile() as cred:
            with patch.object(mod, "TOKEN_FILE", tok.name), patch.object(mod, "CREDENTIALS_FILE", cred.name), \
                 patch.object(mod, "refresh_access_token", return_value="fixture-token"), \
                 patch.object(mod, "fetch_digest_content", return_value="Digest body text"), \
                 patch.dict(os.environ, env or {}, clear=False), \
                 patch.object(mod.urllib.request, "urlopen", google), \
                 patch("sys.stdout", new_callable=io.StringIO) as out:
                code = mod.main(argv or [])
        return code, out.getvalue().strip(), google

    def test_the_self_send_runs_with_no_approval_and_only_talks_to_google(self):
        code, out, google = self._run()
        self.assertEqual((code, out), (0, "SENT id=msg-fixture-id"))
        self.assertEqual(len(google.sent), 1)
        for url in google.urls:
            self.assertTrue(url.startswith("https://gmail.googleapis.com/"), url)
            self.assertNotIn("/api/approvals", url)

    def test_main_takes_no_recipient_from_argv_or_the_environment(self):
        argv = ["--to", OTHER, "--bcc", OTHER, "--cc=" + OTHER, "--recipient", OTHER, OTHER]
        env = {k: OTHER for k in ("TO", "RECIPIENT", "DIGEST_TO", "DIGEST_RECIPIENT", "MAIL_TO", "GMAIL_TO", "EMAIL_TO", "MARVEEN_DIGEST_TO")}
        code, out, google = self._run(argv, env)
        self.assertEqual((code, out), (0, "SENT id=msg-fixture-id"))
        raw = base64.urlsafe_b64decode(google.sent[0]["raw"].encode("ascii"))
        msg = message_from_bytes(raw)
        self.assertEqual(msg.get_all("To"), [OWN])
        for name in ("Cc", "Bcc", "Resent-To", "Reply-To"):
            self.assertIsNone(msg[name])
        self.assertNotIn(OTHER.encode(), raw)

    def test_if_the_message_ever_stops_being_self_addressed_the_run_refuses_and_sends_nothing(self):
        # the first profile read (main builds the mail for it) says one address, the guard's own read says another
        google = _FakeGoogle()
        with patch.object(mod, "fetch_own_email_address", side_effect=[OTHER, OWN]):
            code, out, google = self._run(google=google)
        self.assertEqual((code, out), (1, "SEND_REFUSED_NOT_SELF"))
        self.assertEqual(google.sent, [])


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
