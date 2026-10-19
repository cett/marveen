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


NOTIFY = "notify-recipient@example.invalid"   # fixture stand-in for the pinned address (the pin is patched to its hash)


def _redirect_done_log(case):
    """Point the done-notice log at a temp file for one test case (never the repository's store/)."""
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    case.log_path = os.path.join(tmp.name, "done-notice.log")
    patcher = patch.object(mod, "DONE_NOTICE_LOG", case.log_path)
    patcher.start()
    case.addCleanup(patcher.stop)


def _pin(address):
    import hashlib
    return patch.object(mod, "_DONE_NOTIFY_RECIPIENT_SHA256", hashlib.sha256(address.strip().casefold().encode()).hexdigest())


class TestDoneNotificationEntryPoint(unittest.TestCase):
    """send_done_notification(): the one named exception for an outside recipient, pinned by hash, same strict header check."""

    def setUp(self):
        _redirect_done_log(self)

    def _send(self, recipient, subject="Done card", body="Fixture body", google=None):
        google = google or _FakeGoogle()
        with _pin(NOTIFY), patch.object(mod.urllib.request, "urlopen", google):
            try:
                result = mod.send_done_notification("fixture-token", recipient, subject, body)
            except mod.SelfSendOnly as exc:
                return exc, google
        return result, google

    def test_the_pinned_address_goes_through_as_a_single_strict_message(self):
        result, google = self._send(NOTIFY)
        self.assertEqual(result, {"id": "msg-fixture-id"})
        self.assertEqual(len(google.sent), 1)
        raw = base64.urlsafe_b64decode(google.sent[0]["raw"].encode("ascii"))
        msg = message_from_bytes(raw)
        self.assertEqual(msg.get_all("To"), [NOTIFY])
        for name in ("Cc", "Bcc", "Resent-To", "Reply-To", "From"):
            self.assertIsNone(msg[name])

    def test_spelling_variants_of_the_pinned_address_still_mail_only_that_address(self):
        for variant in (NOTIFY.upper(), "  " + NOTIFY + "  "):
            with self.subTest(variant=variant):
                result, google = self._send(variant)
                self.assertEqual(result, {"id": "msg-fixture-id"})
                raw = base64.urlsafe_b64decode(google.sent[0]["raw"].encode("ascii"))
                self.assertEqual(message_from_bytes(raw).get_all("To"), [NOTIFY.casefold()])

    def test_every_other_address_is_refused_and_nothing_is_sent(self):
        for other in (OTHER, OWN, "x" + NOTIFY, NOTIFY + "x", "%s, %s" % (NOTIFY, OTHER), "%s,%s" % (OTHER, NOTIFY),
                      "Name <%s>" % NOTIFY, "<%s>" % NOTIFY, "", " ", None, 5, [NOTIFY], b"notify"):
            with self.subTest(other=other):
                result, google = self._send(other)
                self.assertIsInstance(result, mod.SelfSendOnly)
                self.assertEqual(google.sent, [])
                self.assertEqual(google.urls, [], "refused before any request")

    def test_a_smuggled_header_in_the_subject_is_refused(self):
        for subject in ("Done\r\nBcc: %s" % OTHER, "Done\nCc: %s" % OTHER, "Done\r\nTo: %s" % OTHER):
            with self.subTest(subject=subject):
                try:
                    result, google = self._send(NOTIFY, subject=subject)
                except Exception:
                    continue   # the builder itself refused: fine
                self.assertIsInstance(result, mod.SelfSendOnly)
                self.assertEqual(google.sent, [])

    def test_the_pinned_address_does_not_become_an_address_the_self_send_accepts(self):
        # send_via_gmail stays self-only: a message to the pinned outside address is not "own" unless the profile says so
        google = _FakeGoogle(own=OWN)
        with _pin(NOTIFY), patch.object(mod.urllib.request, "urlopen", google):
            with self.assertRaises(mod.SelfSendOnly):
                mod.send_via_gmail("fixture-token", mod.build_raw_mime(NOTIFY, "Done card", "Body"))
        self.assertEqual(google.sent, [])

    def test_the_pin_is_a_sha256_constant_and_no_address(self):
        import re
        pin = mod._DONE_NOTIFY_RECIPIENT_SHA256
        self.assertRegex(pin, r"^[0-9a-f]{64}$")
        with open(_SCRIPT_PATH, encoding="utf-8") as fh:
            source = fh.read()
        self.assertEqual(len(re.findall(r"[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}", source)), 0,
                         "the public file names no personal address")

    def test_nothing_outside_the_code_moves_the_pin(self):
        import inspect
        self.assertEqual(list(inspect.signature(mod.send_done_notification).parameters), ["access_token", "recipient", "subject", "body"])
        keys = ("DONE_NOTIFY_RECIPIENT", "DONE_NOTIFY_TO", "NOTIFY_RECIPIENT", "RECIPIENT", "DIGEST_TO", "MARVEEN_NOTIFY_TO")
        before = mod._DONE_NOTIFY_RECIPIENT_SHA256
        google = _FakeGoogle()
        with patch.dict(os.environ, {k: OTHER for k in keys}, clear=False), patch.object(mod.urllib.request, "urlopen", google), \
             patch.object(mod.sys, "argv", ["send-digest-email.py", "--recipient", OTHER, OTHER]):
            with self.assertRaises(mod.SelfSendOnly):
                mod.send_done_notification("fixture-token", OTHER, "Done card", "Body")
        self.assertEqual(mod._DONE_NOTIFY_RECIPIENT_SHA256, before)
        self.assertEqual(google.sent, [])

    def test_main_does_not_use_the_exception(self):
        # the scheduled digest still mails only the own mailbox, whatever it is told
        google = _FakeGoogle()
        with tempfile.NamedTemporaryFile() as tok, tempfile.NamedTemporaryFile() as cred:
            with patch.object(mod, "TOKEN_FILE", tok.name), patch.object(mod, "CREDENTIALS_FILE", cred.name), \
                 patch.object(mod, "refresh_access_token", return_value="fixture-token"), \
                 patch.object(mod, "fetch_digest_content", return_value="Digest body text"), \
                 _pin(NOTIFY), patch.object(mod.urllib.request, "urlopen", google), patch("sys.stdout", new_callable=io.StringIO):
                code = mod.main(["--to", NOTIFY])
        self.assertEqual(code, 0)
        raw = base64.urlsafe_b64decode(google.sent[0]["raw"].encode("ascii"))
        self.assertEqual(message_from_bytes(raw).get_all("To"), [OWN])


class TestDoneNoticeLimits(unittest.TestCase):
    """What the fixed recipient still lets through: size-capped, plain text, and one log line per send."""

    def setUp(self):
        _redirect_done_log(self)

    def _send(self, subject="Done card", body="Fixture body", build=None):
        google = _FakeGoogle()
        patches = [_pin(NOTIFY), patch.object(mod.urllib.request, "urlopen", google)]
        if build is not None:
            patches.append(patch.object(mod, "build_raw_mime", return_value=build))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        try:
            return mod.send_done_notification("fixture-token", NOTIFY, subject, body), google
        except mod.SelfSendOnly as exc:
            return exc, google

    def _log_lines(self):
        if not os.path.exists(self.log_path):
            return []
        with open(self.log_path, encoding="utf-8") as fh:
            return fh.read().splitlines()

    def test_the_body_cap_is_4096_bytes_and_the_edge_passes(self):
        result, google = self._send(body="a" * 4096)
        self.assertEqual(result, {"id": "msg-fixture-id"})
        self.assertEqual(len(google.sent), 1)

    def test_one_byte_more_is_refused_and_nothing_is_sent_or_logged(self):
        result, google = self._send(body="a" * 4097)
        self.assertIsInstance(result, mod.SelfSendOnly)
        self.assertEqual(google.sent, [])
        self.assertEqual(google.urls, [], "refused before any request")
        self.assertEqual(self._log_lines(), [])

    def test_the_body_cap_counts_bytes_not_characters(self):
        # 2049 two-byte characters are 4098 bytes: under 4096 characters, over 4096 bytes
        result, google = self._send(body="\u00e9" * 2049)
        self.assertIsInstance(result, mod.SelfSendOnly)
        self.assertEqual(google.sent, [])
        result, google = self._send(body="\u00e9" * 2048)
        self.assertEqual(result, {"id": "msg-fixture-id"})

    def test_the_subject_cap_is_200_characters(self):
        result, google = self._send(subject="s" * 200)
        self.assertEqual(result, {"id": "msg-fixture-id"})
        result, google = self._send(subject="s" * 201)
        self.assertIsInstance(result, mod.SelfSendOnly)
        self.assertEqual(google.sent, [])

    def test_a_subject_or_body_that_is_not_text_is_refused(self):
        for subject, body in ((None, "b"), ("s", None), (5, "b"), ("s", b"bytes"), (["s"], "b")):
            with self.subTest(subject=subject, body=body):
                result, google = self._send(subject=subject, body=body)
                self.assertIsInstance(result, mod.SelfSendOnly)
                self.assertEqual(google.sent, [])

    def test_only_plain_text_goes_out(self):
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText
        for label, build in (("multipart/alternative", None), ("text/html", None)):
            if label == "multipart/alternative":
                m = MIMEMultipart("alternative")
                m.attach(MIMEText("plain", "plain", "utf-8"))
                m.attach(MIMEText("<b>html</b>", "html", "utf-8"))
            else:
                m = MIMEText("<b>html</b>", "html", "utf-8")
            m["To"] = NOTIFY
            m["Subject"] = "Done card"
            raw = _b64(m.as_bytes())
            with self.subTest(content=label):
                result, google = self._send(build=raw)
                self.assertIsInstance(result, mod.SelfSendOnly)
                self.assertEqual(google.sent, [])
                self.assertEqual(self._log_lines(), [])

    def test_one_line_per_send_with_time_pin_prefix_and_length_but_no_text(self):
        import re
        body = "Secret-looking fixture body \u00e9"
        subject = "Subject fixture words"
        result, _ = self._send(subject=subject, body=body)
        self.assertEqual(result, {"id": "msg-fixture-id"})
        lines = self._log_lines()
        self.assertEqual(len(lines), 1)
        time_part, pin8, length = lines[0].split(" ")
        self.assertRegex(time_part, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$")
        self.assertEqual(pin8, mod._DONE_NOTIFY_RECIPIENT_SHA256[:8])
        self.assertEqual(int(length), len(body.encode("utf-8")))
        for forbidden in (body, subject, NOTIFY, "Secret", "fixture"):
            self.assertNotIn(forbidden, lines[0])
        self._send()
        self.assertEqual(len(self._log_lines()), 2, "appended, one line per send")

    def test_a_refused_recipient_leaves_no_log_line(self):
        google = _FakeGoogle()
        with _pin(NOTIFY), patch.object(mod.urllib.request, "urlopen", google):
            with self.assertRaises(mod.SelfSendOnly):
                mod.send_done_notification("fixture-token", OTHER, "Done card", "Body")
        self.assertEqual(self._log_lines(), [])

    def test_if_the_trace_cannot_be_written_nothing_is_sent(self):
        # fail closed: no trace, no mail
        with patch.object(mod, "DONE_NOTICE_LOG", os.path.join(os.path.dirname(self.log_path), "no-such-dir", "x.log")):
            result, google = None, _FakeGoogle()
            with _pin(NOTIFY), patch.object(mod.urllib.request, "urlopen", google):
                with self.assertRaises(OSError):
                    mod.send_done_notification("fixture-token", NOTIFY, "Done card", "Body")
        self.assertEqual(google.sent, [])

    def test_the_pin_is_checked_on_the_to_header_the_message_really_carries(self):
        # the recipient argument says NOTIFY, but the finished message is addressed to OTHER: the header check and the pin
        # both look at the message, so it is refused
        forged = mod.build_raw_mime(OTHER, "Done card", "Body")
        result, google = self._send(build=forged)
        self.assertIsInstance(result, mod.SelfSendOnly)
        self.assertEqual(google.sent, [])


class TestDoneNotificationDefenceInDepth(unittest.TestCase):
    def setUp(self):
        _redirect_done_log(self)

    def test_the_header_check_runs_even_if_the_builder_were_to_produce_extra_recipients(self):
        evil = _msg(_BASE + [("To", NOTIFY), ("Bcc", OTHER)])
        google = _FakeGoogle()
        with _pin(NOTIFY), patch.object(mod, "build_raw_mime", return_value=evil), patch.object(mod.urllib.request, "urlopen", google):
            with self.assertRaises(mod.SelfSendOnly):
                mod.send_done_notification("fixture-token", NOTIFY, "Done card", "Body")
        self.assertEqual(google.sent, [])

    def test_a_freshly_loaded_module_takes_its_pin_from_the_code_not_from_the_environment(self):
        import hashlib
        names = ("DONE_NOTIFY_RECIPIENT", "DONE_NOTIFY_RECIPIENT_SHA256", "NOTIFY_RECIPIENT", "RECIPIENT", "DIGEST_TO", "MARVEEN_NOTIFY_TO")
        forged = hashlib.sha256(OTHER.encode()).hexdigest()
        with patch.dict(os.environ, {k: v for k in names for v in (forged,)}, clear=False):
            spec = importlib.util.spec_from_file_location("digest_loaded_with_env", _SCRIPT_PATH)
            fresh = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(fresh)
        self.assertEqual(fresh._DONE_NOTIFY_RECIPIENT_SHA256, mod._DONE_NOTIFY_RECIPIENT_SHA256)
        google = _FakeGoogle()
        with patch.object(fresh.urllib.request, "urlopen", google):
            with self.assertRaises(fresh.SelfSendOnly):
                fresh.send_done_notification("fixture-token", OTHER, "Done card", "Body")
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
