#!/usr/bin/env python3
"""Tests for scripts/lib/email_extract.py.

Three layers:
  1. build_envelope() against the golden vectors the server's vitest suite also runs (the SAME file):
     every valid vector must give the same canonical form and sha256, every invalid vector must be refused
     for the same field.
  2. collect_email_envelope()/envelope_of_call() against the "extract" section of that file: calls in every
     sending shape, with the hash the server computes for the mail they carry; and the calls that must be
     refused as unreadable, with the reason.
  3. hostile input: header injection, hidden recipients, duplicate headers, bounds, and "never raises".

Fixture data only (example.test addresses, neutral names); files are created in a temporary directory.
"""
import base64
import hashlib
import json
import os
import random
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
import email_extract as E  # noqa: E402

VECTORS_PATH = os.path.join(HERE, "email-envelope-vectors.json")
with open(VECTORS_PATH, encoding="utf-8") as _fh:
    VECTORS = json.load(_fh)
EXTRACT = VECTORS["extract"]


def _materialize(obj, d):
    """Replace {DIR} in every string of a call (the working directory of the case)."""
    if isinstance(obj, str):
        return obj.replace("{DIR}", d)
    if isinstance(obj, list):
        return [_materialize(x, d) for x in obj]
    if isinstance(obj, dict):
        return {k: _materialize(v, d) for k, v in obj.items()}
    return obj


def _write_fixtures(fixtures, d):
    for rel, spec in fixtures.items():
        path = os.path.join(d, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(spec["base64"]) if "base64" in spec else spec["text"].encode("utf-8"))


def _run_case(case):
    with tempfile.TemporaryDirectory() as d:
        _write_fixtures(case["fixtures"], d)
        ti = _materialize(case["tool_input"], d)
        return E.envelope_of_call(case["tool"], ti, case["agent"], cwd=d)


def _call(command, **files):
    """envelope_of_call for a Bash command, with fixture files (name -> text) in the working directory."""
    with tempfile.TemporaryDirectory() as d:
        for name, text in files.items():
            with open(os.path.join(d, name), "wb") as fh:
                fh.write(text if isinstance(text, bytes) else text.encode("utf-8"))
        return E.envelope_of_call("Bash", {"command": command.replace("{DIR}", d)}, "main", cwd=d)


def _reason(command, **files):
    r = _call(command, **files)
    assert not r["ok"] and r["unreadable"], r
    return r["hint"]


SEND = "python3 scripts/support-mail/send.py"


class GoldenVectors(unittest.TestCase):
    def test_the_contract_file_is_the_one_the_server_runs(self):
        self.assertEqual(VECTORS["version"], 1)
        self.assertGreaterEqual(len(VECTORS["valid"]), 40)
        self.assertGreaterEqual(len(VECTORS["invalid"]), 30)
        self.assertGreaterEqual(len(EXTRACT["valid"]), 30)
        self.assertGreaterEqual(len(EXTRACT["unreadable"]), 50)

    def test_every_valid_vector_has_the_same_canon_and_hash(self):
        for v in VECTORS["valid"]:
            with self.subTest(v["name"]):
                r = E.build_envelope(v["envelope"], v["agent"])
                self.assertTrue(r["ok"], r)
                self.assertEqual(r["canon"], v["canon"])
                self.assertEqual(r["hash"], v["hash"])
                # the canonical form is itself a valid envelope with the same hash
                again = E.build_envelope(json.loads(r["canon"]), v["agent"])
                self.assertTrue(again["ok"])
                self.assertEqual(again["hash"], v["hash"])

    def test_every_invalid_vector_is_refused_for_the_same_field(self):
        for v in VECTORS["invalid"]:
            with self.subTest(v["name"]):
                r = E.build_envelope(v["envelope"], v["agent"])
                self.assertFalse(r["ok"], v["name"])
                self.assertEqual(r["field"], v["field"])

    def test_python_traps_the_server_does_not_have(self):
        base = {"to": ["a@example.test"], "subject": "S", "body": "b"}
        # '$' matches before a trailing newline in Python: the address check must not
        for bad in ("a@example.test\n", "a@example.test\r", "a\n@example.test", "a@example.test\n\n"):
            r = E.build_envelope(dict(base, to=[bad]), "main")
            self.assertFalse(r["ok"], repr(bad))
        # True == 1 in Python, a boolean is not a version
        self.assertFalse(E.build_envelope(dict(base, v=True), "main")["ok"])
        self.assertTrue(E.build_envelope(dict(base, v=1.0), "main")["ok"])
        self.assertFalse(E.build_envelope(dict(base, v=2), "main")["ok"])
        # a float that is a whole number is the same size, written without ".0"
        sha = "a" * 64
        r = E.build_envelope(dict(base, attachments=[{"name": "n", "size": 2.0, "sha256": sha}]), "main")
        self.assertTrue(r["ok"])
        self.assertIn('"size":2}', r["canon"])
        self.assertFalse(E.build_envelope(dict(base, attachments=[{"name": "n", "size": True, "sha256": sha}]), "main")["ok"])
        self.assertFalse(E.build_envelope(dict(base, attachments=[{"name": "n", "size": 2.5, "sha256": sha}]), "main")["ok"])
        self.assertFalse(E.build_envelope(dict(base, attachments=[{"name": "n", "size": 2 ** 53, "sha256": sha}]), "main")["ok"])
        # an explicit null is a present field with a wrong type, not an absent one
        for k in ("html_sha256", "attachments", "from", "reply_to", "in_reply_to", "agent"):
            self.assertFalse(E.build_envelope(dict(base, **{k: None}), "main")["ok"], k)
        # an agent that is not text, a surrogate in the agent
        self.assertFalse(E.build_envelope(base, None)["ok"])
        self.assertFalse(E.build_envelope(base, "ma\ud800in")["ok"])
        # the client's agent never wins
        r = E.build_envelope(dict(base, agent="someone-else"), "main")
        self.assertEqual(r["envelope"]["agent"], "main")
        # a mail larger than the payload cap is refused, not hashed
        r = E.build_envelope(dict(base, body="x" * (E.MAX_PAYLOAD_BYTES + 1)), "main")
        self.assertFalse(r["ok"])
        self.assertEqual(r["field"], "action_payload")
        # never raises, whatever it is given
        for junk in (None, [], "x", 5, {"to": {"length": 1}}, {"to": [None]}, {"__proto__": {}}, {1: 2}):
            self.assertFalse(E.build_envelope(junk, "main")["ok"], repr(junk))

    def test_the_extract_expectations_are_themselves_valid_server_envelopes(self):
        # the hash stored with each case was computed by the server code; recomputing it here from the
        # stored plain envelope must give the same value (so the vector file cannot drift on one side)
        for v in EXTRACT["valid"]:
            with self.subTest(v["name"]):
                r = E.build_envelope(v["envelope"], v["agent"])
                self.assertTrue(r["ok"], r)
                self.assertEqual(r["canon"], v["canon"])
                self.assertEqual(r["hash"], v["hash"])

    def test_a_send_py_call_is_the_same_mail_as_the_minimal_vector(self):
        minimal = next(v for v in VECTORS["valid"] if v["name"] == "minimal")
        first = EXTRACT["valid"][0]
        self.assertEqual(first["hash"], minimal["hash"])


class ExtractVectors(unittest.TestCase):
    def test_every_readable_call_gives_the_hash_the_server_computes(self):
        for case in EXTRACT["valid"]:
            with self.subTest(case["name"]):
                r = _run_case(case)
                self.assertTrue(r["ok"], r)
                self.assertEqual(r["canon"], case["canon"])
                self.assertEqual(r["hash"], case["hash"])

    def test_every_unreadable_call_is_refused_with_its_reason(self):
        for case in EXTRACT["unreadable"]:
            with self.subTest(case["name"]):
                r = _run_case(case)
                self.assertFalse(r["ok"], r)
                self.assertTrue(r["unreadable"], r)
                self.assertIn(case["reason"], r["hint"])

    def test_equal_mails_in_different_shapes_that_should_agree(self):
        by_name = {c["name"]: c["hash"] for c in EXTRACT["valid"]}
        # the same mail through send.py with literal arguments, with = forms and with abbreviated options
        a = by_name['send.py literal arguments (same mail as the "minimal" vector)']
        self.assertEqual(by_name["send.py direct path, = forms, escaped space"], a)
        self.assertEqual(by_name["send.py env prefix, shell -c wrapper and python flags"], a)
        # the same Gmail message through the REST body inline, from a file, from stdin and as an upload
        g = [h for n, h in by_name.items() if n.startswith("curl to the Gmail")]
        self.assertEqual(len(g), 4)
        self.assertEqual(len(set(g)), 1)
        # recipient order, repeats and domain case do not matter
        self.assertEqual(by_name["Gmail tool: order, case of the domain and repeats of the recipients do not change the mail"] != "", True)


class WhatTheHashIsBoundTo(unittest.TestCase):
    """Each rule of the reader, as a change of the call that must change the hash (or refuse it)."""

    def h(self, command, **files):
        r = _call(command, **files)
        self.assertTrue(r["ok"], r)
        return r["hash"]

    def test_each_field_changes_the_hash(self):
        base = self.h(f"{SEND} --to a@example.test --subject S --body B")
        others = [
            f"{SEND} --to a@example.test,b@example.test --subject S --body B",
            f"{SEND} --to a@example.test --cc b@example.test --subject S --body B",
            f"{SEND} --to a@example.test --subject S2 --body B",
            f"{SEND} --to a@example.test --subject S --body B2",
            f"{SEND} --to a@example.test --subject S --body 'B '",
            f"{SEND} --to a@example.test --subject S --body B --html",
            f"{SEND} --to A@example.test --subject S --body B",  # local part case is kept
        ]
        hashes = {self.h(o) for o in others}
        self.assertNotIn(base, hashes)
        self.assertEqual(len(hashes), len(others))

    def test_the_subject_body_boundary_does_not_move(self):
        self.assertNotEqual(self.h(f"{SEND} --to a@example.test --subject Hi --body Bob"), self.h(f"{SEND} --to a@example.test --subject HiBob --body x"))

    def test_recipient_order_domain_case_and_repeats_do_not(self):
        self.assertEqual(
            self.h(f"{SEND} --to 'B@Example.test, a@example.test, a@EXAMPLE.test' --subject S --body B"),
            self.h(f"{SEND} --to 'a@example.test, B@example.test' --subject S --body B"),
        )

    def test_a_trailing_newline_of_the_body_is_part_of_the_mail(self):
        self.assertNotEqual(
            self.h(f"{SEND} --to a@example.test --subject S <<'EOF'\nB\nEOF"),
            self.h(f"{SEND} --to a@example.test --subject S --body B"),
        )

    def test_the_agent_is_part_of_the_hash(self):
        a = E.envelope_of_call("Bash", {"command": f"{SEND} --to a@example.test --subject S --body B"}, "main")["hash"]
        b = E.envelope_of_call("Bash", {"command": f"{SEND} --to a@example.test --subject S --body B"}, "worker")["hash"]
        self.assertNotEqual(a, b)

    def test_a_changed_attachment_file_changes_the_hash(self):
        cmd = "python3 scripts/gmail-send.py --to a@example.test --subject S --body B --attach f.bin"
        one = self.h(cmd, **{"f.bin": b"one"})
        two = self.h(cmd, **{"f.bin": b"two"})
        self.assertNotEqual(one, two)

    def test_attachment_order_does_not_matter_but_the_set_does(self):
        files = {"a.bin": b"A", "b.bin": b"B"}
        ab = self.h("python3 scripts/gmail-send.py --to a@example.test --subject S --body B --attach a.bin --attach b.bin", **files)
        ba = self.h("python3 scripts/gmail-send.py --to a@example.test --subject S --body B --attach b.bin --attach a.bin", **files)
        a = self.h("python3 scripts/gmail-send.py --to a@example.test --subject S --body B --attach a.bin", **files)
        self.assertEqual(ab, ba)
        self.assertNotEqual(ab, a)

    def test_a_changed_html_file_changes_the_hash(self):
        cmd = "python3 scripts/gmail-send.py --to a@example.test --subject S --body B --html p.html"
        self.assertNotEqual(self.h(cmd, **{"p.html": "<p>1</p>"}), self.h(cmd, **{"p.html": "<p>2</p>"}))

    def test_from_reply_to_and_in_reply_to_are_bound(self):
        base = "python3 scripts/gmail-send.py --to a@example.test --subject S --body B"
        hs = {self.h(base), self.h(base + " --from f@example.test"), self.h(base + " --reply-to r@example.test"), self.h(base + " --in-reply-to '<x@example.test>'")}
        self.assertEqual(len(hs), 4)

    def test_html_through_a_message_changes_the_hash(self):
        plain = "To: a@example.test\nSubject: S\n\nB\n"
        alt = ("To: a@example.test\nSubject: S\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary=\"X\"\n\n--X\nContent-Type: text/plain\n\nB\n"
               "--X\nContent-Type: text/html\n\n<p>B</p>\n--X--\n")
        self.assertNotEqual(self.h("sendmail -t < m.eml", **{"m.eml": plain}), self.h("sendmail -t < m.eml", **{"m.eml": alt}))


class HostileInput(unittest.TestCase):
    def test_header_injection_through_the_subject_of_every_shape(self):
        for sub in ("a\nBcc: spy@example.test", "a\rBcc: spy@example.test", "a\r\nBcc: spy@example.test"):
            r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": ["a@example.test"], "subject": sub, "text": "x"}, "main")
            self.assertFalse(r["ok"], repr(sub))
            self.assertTrue(r["unreadable"])
            r = E.envelope_of_call("Bash", {"command": f"{SEND} --to a@example.test --subject '{sub}' --body x"}, "main")
            self.assertFalse(r["ok"], repr(sub))

    def test_header_injection_through_a_recipient_value(self):
        for to in ("a@example.test\nBcc: spy@example.test", "a@example.test\rBcc: spy@example.test", "a@example.test\x00b@example.test"):
            r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": [to], "subject": "S", "text": "x"}, "main")
            self.assertFalse(r["ok"], repr(to))

    def test_a_trailing_line_break_on_a_recipient_is_not_trimmed_away_by_the_parser(self):
        # the address parser strips a trailing newline, so only an explicit check keeps it from passing
        for to in ("a@example.test\n", "a@example.test\r\n", " a@example.test\r"):
            r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": [to], "subject": "S", "text": "x"}, "main")
            self.assertFalse(r["ok"], repr(to))
            self.assertIn("line break", r["hint"])

    def test_attachment_content_that_is_both_a_file_and_valid_base64_is_ambiguous(self):
        from unittest import mock
        with mock.patch.object(E.os.path, "isfile", lambda p: p == "/AAA"):
            r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": ["a@example.test"], "subject": "S", "text": "x", "attachments": [{"filename": "f", "content": "/AAA"}]}, "main")
        self.assertFalse(r["ok"])
        self.assertIn("both an existing file path and valid base64", r["hint"])

    def test_in_reply_to_and_from_cannot_carry_a_line_break(self):
        r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": ["a@example.test"], "subject": "S", "text": "x", "inReplyTo": "<a>\nBcc: spy@example.test"}, "main")
        self.assertFalse(r["ok"])
        r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": ["a@example.test"], "subject": "S", "text": "x", "from": "f@example.test\nBcc: spy@example.test"}, "main")
        self.assertFalse(r["ok"])

    def test_an_at_sign_in_a_display_name_or_a_comment_is_never_dropped_silently(self):
        for v in ('"a@example.test" <b@example.test>', "b@example.test (a@example.test)", '"x, a@example.test" <b@example.test>', "a@example.test, b@example.test (c@example.test)"):
            with self.subTest(v):
                self.assertIn('"@"', _reason(f"{SEND} --to {json.dumps(v)} --subject S --body x"))

    def test_duplicate_recipient_headers_are_united_never_picked(self):
        r = _call("sendmail -t < m.eml", **{"m.eml": "To: a@example.test\nTo: b@example.test\nCc: c@example.test\nCC: d@example.test\nBcc: e@example.test\nBCC: f@example.test\nSubject: S\n\nx\n"})
        self.assertTrue(r["ok"], r)
        e = r["envelope"]
        self.assertEqual(e["to"], ["a@example.test", "b@example.test"])
        self.assertEqual(e["cc"], ["c@example.test", "d@example.test"])
        self.assertEqual(e["bcc"], ["e@example.test", "f@example.test"])

    def test_single_valued_headers_given_twice_are_refused(self):
        for h in ("Subject: A\nSubject: B", "From: a@example.test\nFrom: b@example.test", "Reply-To: a@example.test\nReply-To: b@example.test", "In-Reply-To: <a>\nIn-Reply-To: <b>", "Subject: A\nsubject: B"):
            with self.subTest(h):
                self.assertIn("more than one", _reason("sendmail -t < m.eml", **{"m.eml": "To: a@example.test\n" + h + "\n\nx\n"}))

    def test_a_hidden_bcc_in_the_message_is_in_the_envelope(self):
        r = _call("sendmail -t < m.eml", **{"m.eml": "To: a@example.test\nBcc: hidden@example.test\nSubject: S\n\nx\n"})
        self.assertEqual(r["envelope"]["bcc"], ["hidden@example.test"])

    def test_a_bare_carriage_return_splits_a_header_and_the_hidden_bcc_is_in_the_envelope(self):
        # Python's parser, like several mailers, ends a header line at a lone CR. Whatever sits after it is a
        # header of its own, so the recipient it names is part of the approved mail (a superset is safe).
        r = _call("sendmail -t < m.eml", **{"m.eml": b"To: a@example.test\r\nSubject: ok\rBcc: spy@example.test\r\n\r\nx\r\n"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["envelope"]["bcc"], ["spy@example.test"])
        self.assertEqual(r["envelope"]["subject"], "ok")

    def test_crlf_messages_and_lf_messages_are_the_same_mail(self):
        lf = "To: a@example.test\nSubject: S\n\nline1\nline2\n"
        crlf = lf.replace("\n", "\r\n")
        self.assertEqual(_call("sendmail -t < m.eml", **{"m.eml": lf})["hash"], _call("sendmail -t < m.eml", **{"m.eml": crlf})["hash"])

    def test_a_mime_message_with_a_second_inline_part_is_refused_not_trimmed(self):
        two_html = "To: a@example.test\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary=\"B\"\n\n--B\nContent-Type: text/html\n\n<p>1</p>\n--B\nContent-Type: text/html\n\n<p>2</p>\n--B--\n"
        self.assertIn("more than one inline text/html", _reason("sendmail -t < m.eml", **{"m.eml": two_html}))
        img = "To: a@example.test\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=\"B\"\n\n--B\nContent-Type: text/plain\n\nx\n--B\nContent-Type: image/png\n\nAAAA\n--B--\n"
        self.assertIn("inline image/png", _reason("sendmail -t < m.eml", **{"m.eml": img}))

    def test_an_attachment_part_without_a_name_is_refused(self):
        m = "To: a@example.test\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=\"B\"\n\n--B\nContent-Type: text/plain\n\nx\n--B\nContent-Type: application/pdf\nContent-Disposition: attachment\n\nAAAA\n--B--\n"
        self.assertIn("no file name", _reason("sendmail -t < m.eml", **{"m.eml": m}))

    def test_an_encoded_subject_is_decoded_and_a_utf8_subject_is_kept(self):
        enc = _call("sendmail -t < m.eml", **{"m.eml": "To: a@example.test\nSubject: =?utf-8?q?=C3=81rv=C3=ADzt=C5=B1r=C5=91?=\n\nx\n"})
        raw8 = _call("sendmail -t < m.eml", **{"m.eml": "To: a@example.test\nSubject: Árvíztűrő\n\nx\n".encode("utf-8")})
        self.assertEqual(enc["envelope"]["subject"], "Árvíztűrő")
        self.assertEqual(raw8["envelope"]["subject"], "Árvíztűrő")

    def test_the_gmail_raw_message_is_read_like_a_file_with_the_same_message(self):
        msg = "To: a@example.test\r\nSubject: S\r\n\r\nx\r\n"
        raw = base64.urlsafe_b64encode(msg.encode()).decode()  # with padding
        via_rest = _call(f"curl -s https://gmail.googleapis.com/gmail/v1/users/me/messages/send -d '{json.dumps({'raw': raw})}'")
        via_file = _call("sendmail -t < m.eml", **{"m.eml": msg})
        self.assertTrue(via_rest["ok"] and via_file["ok"])
        self.assertEqual(via_rest["hash"], via_file["hash"])

    def test_standard_base64_is_not_base64url(self):
        raw = base64.b64encode(b"To: a@example.test\nSubject: ???>>>\n\nx\n").decode()
        self.assertTrue(("+" in raw) or ("/" in raw))
        self.assertIn("base64", _reason(f"curl -s https://gmail.googleapis.com/gmail/v1/users/me/messages/send -d '{json.dumps({'raw': raw})}'"))

    def test_a_message_that_is_not_a_message(self):
        for body in ("", "   ", "{\"a\":1}", "<html>"):
            r = _call("sendmail -t <<'EOF'\n" + body + "\nEOF")
            self.assertFalse(r["ok"], repr(body))

    def test_tool_input_edge_cases(self):
        def call(ti, tool="mcp__gmail__gmail_send_email"):
            return E.envelope_of_call(tool, ti, "main")

        self.assertTrue(call({"to": ["a@example.test"], "subject": "S", "text": "x"})["ok"])
        self.assertFalse(call({"to": ["a@example.test"], "subject": "S", "text": "x", "TO": ["b@example.test"]})["ok"])  # the same key twice, case differs
        self.assertFalse(call({"to": ["a@example.test"], "subject": 5, "text": "x"})["ok"])
        self.assertFalse(call({"to": ["a@example.test"], "subject": "S", "text": 5})["ok"])
        self.assertFalse(call({"to": [], "subject": "S", "text": "x"})["ok"])
        self.assertFalse(call({"subject": "S", "text": "x"})["ok"])
        self.assertFalse(call({"to": ["a@example.test"], "subject": "S"})["ok"])  # no body at all
        self.assertFalse(call("not a dict")["ok"])
        self.assertFalse(call(None)["ok"])
        self.assertFalse(call({"to": ["a@example.test"], "subject": "S", "text": "x", "replyTo": ["a@example.test", "b@example.test"]})["ok"])
        # a boolean or number in an unknown field is harmless (draft flags and the like)
        self.assertTrue(call({"to": ["a@example.test"], "subject": "S", "text": "x", "draft": False, "maxResults": 5})["ok"])
        # the same body under two names is fine when it is the same text
        self.assertTrue(call({"to": ["a@example.test"], "subject": "S", "body": "x", "text": "x"}, "send_email")["ok"])

    def test_bounds_fail_closed_and_stay_fast(self):
        t0 = time.time()
        big = f"{SEND} --to a@example.test --subject S --body " + "x" * (E.MAX_CMD_CHARS + 1)
        self.assertIn("longer than", _reason(big))
        many_openers = "cat " + "<<A " * 5000
        self.assertFalse(_call(many_openers)["ok"])
        many_words = "echo " + "a " * (E.MAX_WORDS + 10)
        self.assertFalse(_call(many_words)["ok"])
        deep = SEND + " --to a@example.test --subject S --body x"
        for _ in range(6):
            deep = "bash -c " + json.dumps(deep)
        self.assertIn("nested too deeply", _reason(deep))
        quotes = "echo '" + "a" * 100000 + "'"
        self.assertFalse(_call(quotes)["ok"])
        nested_parens = "(" * 20000 + SEND + " --to a@example.test --subject S --body x"
        self.assertFalse(_call(nested_parens)["ok"] and False)  # must return, in time; the verdict is not the point
        unclosed_dq = SEND + ' --to a@example.test --subject S --body "' + "\\" * 50000
        self.assertFalse(_call(unclosed_dq)["ok"])
        self.assertLess(time.time() - t0, 20)

    def test_a_large_input_is_refused_not_read(self):
        old = E.MAX_ATTACHMENT_BYTES
        try:
            E.MAX_ATTACHMENT_BYTES = 10
            self.assertIn("larger than", _reason("python3 scripts/gmail-send.py --to a@example.test --subject S --body B --attach f.bin", **{"f.bin": b"x" * 11}))
            r = E.envelope_of_call("mcp__gmail__gmail_send_email", {"to": ["a@example.test"], "subject": "S", "text": "x", "attachments": [{"filename": "f", "content": base64.b64encode(b"x" * 11).decode()}]}, "main")
            self.assertFalse(r["ok"])
        finally:
            E.MAX_ATTACHMENT_BYTES = old
        old = E.MAX_BODY_FILE_BYTES
        try:
            E.MAX_BODY_FILE_BYTES = 10
            self.assertIn("larger than", _reason(f"{SEND} --to a@example.test --subject S < b.txt", **{"b.txt": "x" * 11}))
        finally:
            E.MAX_BODY_FILE_BYTES = old

    def test_an_empty_body_and_a_missing_recipient_are_refused_by_the_envelope_not_the_reader(self):
        r = E.envelope_of_call("Bash", {"command": f"{SEND} --to a@example.test --subject S --body ''"}, "main")
        self.assertFalse(r["ok"])
        self.assertFalse(r["unreadable"])
        self.assertEqual(r["field"], "body")

    def test_never_raises_on_garbage(self):
        rnd = random.Random(7)
        pieces = ["send.py", "--to", "--body", "a@example.test", "'", '"', "$", "$(", "`", "<<", "<<<", "<", ">", "|", ";", "&&", "\n", "\\", "EOF", "{a,b}", "*", "--subject", "-", "--", "sendmail", "-t", "curl", "-d", "@", "mail", "-s", "bash -c", "\x00", "é", "\ud800"]
        for _ in range(3000):
            cmd = " ".join(rnd.choice(pieces) for _ in range(rnd.randint(1, 14)))
            r = E.collect_email_envelope("Bash", {"command": cmd})
            self.assertIn("unreadable_reason", r)
            r2 = E.envelope_of_call("Bash", {"command": cmd}, "main")
            self.assertIn("ok", r2)
        for ti in (None, 5, "x", [], {"command": None}, {"command": 5}, {"command": ["a"]}, {}):
            self.assertFalse(E.envelope_of_call("Bash", ti, "main")["ok"])
        for _ in range(500):
            ti = {rnd.choice(["to", "cc", "subject", "text", "html", "attachments", "from", "x"]): rnd.choice([None, 1, "a@example.test", ["a@example.test"], [None], {"a": 1}, "", True, [1]]) for _ in range(rnd.randint(0, 6))}
            r = E.envelope_of_call("mcp__gmail__gmail_send_email", ti, "main")
            self.assertIn("ok", r)

    def test_reading_never_runs_or_writes_anything(self):
        with tempfile.TemporaryDirectory() as d:
            marker = os.path.join(d, "ran")
            cmd = f"touch {marker}; {SEND} --to a@example.test --subject S --body x > {marker}.out"
            E.envelope_of_call("Bash", {"command": cmd}, "main", cwd=d)
            self.assertEqual(os.listdir(d), [])


class ShellReading(unittest.TestCase):
    """The pieces of shell syntax the reader must get exactly right, or refuse."""

    def fields(self, command, **files):
        r = _call(command, **files)
        self.assertTrue(r["ok"], r)
        return r["envelope"]

    def test_quoting_forms(self):
        e = self.fields(f"{SEND} --to a@example.test --subject 'it'\"'\"'s' --body \"a \\\"quoted\\\" word\" ")
        self.assertEqual(e["subject"], "it's")
        self.assertEqual(e["body"], 'a "quoted" word')
        e = self.fields(f"{SEND} --to a@example.test --subject S --body 'single $HOME `not` run'")
        self.assertEqual(e["body"], "single $HOME `not` run")
        e = self.fields(f'{SEND} --to a@example.test --subject S --body "escaped \\$HOME and \\`tick\\`"')
        self.assertEqual(e["body"], "escaped $HOME and `tick`")

    def test_line_continuation_and_backslash(self):
        e = self.fields(f"{SEND} --to a@example.test \\\n  --subject S \\\n  --body B")
        self.assertEqual(e["body"], "B")
        e = self.fields(f"{SEND} --to a@example.test --subject S --body a\\ b")
        self.assertEqual(e["body"], "a b")

    def test_a_dollar_that_is_only_text(self):
        self.assertEqual(self.fields(f"{SEND} --to a@example.test --subject S --body 'cost: 5$'")["body"], "cost: 5$")
        self.assertEqual(self.fields(f'{SEND} --to a@example.test --subject S --body "cost: 5$ "')["body"], "cost: 5$ ")

    def test_expansions_are_refused_in_every_position(self):
        for frag in ('--body "$X"', "--body ${X}", '--body "${X:-a b}"', "--body $((1+1))", "--body $1", "--body $@", "--body ~root/x", "--body a{1,2}", "--body a{1..3}", "--body [ab]", "--body ?"):
            with self.subTest(frag):
                r = _call(f"{SEND} --to a@example.test --subject S {frag}")
                self.assertFalse(r["ok"], frag)

    def test_command_substitution_anywhere_in_the_call_refuses_the_whole_call(self):
        for pre in ("echo $(date); ", "echo `date`; ", 'echo "$(date)"; ', "diff <(ls) <(ls); ", "echo ${X}; "):
            with self.subTest(pre):
                self.assertFalse(_call(pre + f"{SEND} --to a@example.test --subject S --body x")["ok"], pre)

    def test_a_substitution_that_hides_a_mail_command_is_not_missed(self):
        for cmd in (f"echo $({SEND} --to a@example.test --subject S --body x)", f'echo "$({SEND} --to a@example.test --subject S --body x)"', f"echo `{SEND} --to a@example.test --subject S --body x`"):
            with self.subTest(cmd):
                self.assertFalse(_call(cmd)["ok"])

    def test_comments_are_not_arguments(self):
        e = self.fields(f"{SEND} --to a@example.test --subject S --body B # --bcc spy@example.test")
        self.assertEqual(e["bcc"], [])
        # a hash inside a word is not a comment
        e = self.fields(f"{SEND} --to a@example.test --subject S --body a#b")
        self.assertEqual(e["body"], "a#b")

    def test_heredoc_forms(self):
        e = self.fields(f"{SEND} --to a@example.test --subject S <<-EOF\n\tindented\n\tEOF")
        self.assertEqual(e["body"], "indented\n")
        e = self.fields(f"{SEND} --to a@example.test --subject S <<\"EOF\"\nliteral $HOME\nEOF")
        self.assertEqual(e["body"], "literal $HOME\n")
        e = self.fields(f"{SEND} --to a@example.test --subject S <<\\EOF\nliteral $HOME\nEOF")
        self.assertEqual(e["body"], "literal $HOME\n")
        # text after the closing delimiter is another command, not part of the body
        e = self.fields(f"{SEND} --to a@example.test --subject S <<'EOF'\nbody\nEOF\necho done")
        self.assertEqual(e["body"], "body\n")
        # the delimiter has to be alone on its line
        self.assertIn("never closed", _reason(f"{SEND} --to a@example.test --subject S <<'EOF'\nbody\nEOF trailing"))

    def test_a_heredoc_bound_to_another_command_is_not_the_body(self):
        self.assertIn("pipe", _reason(f"cat <<'EOF' | {SEND} --to a@example.test --subject S\nbody\nEOF"))

    def test_a_redirect_to_a_file_is_not_a_body_source(self):
        e = self.fields(f"{SEND} --to a@example.test --subject S --body B > out.txt 2>&1")
        self.assertEqual(e["body"], "B")
        e = self.fields(f"{SEND} --to a@example.test --subject S --body B 2>/dev/null")
        self.assertEqual(e["body"], "B")

    def test_stdin_file_must_be_utf8_text(self):
        self.assertIn("UTF-8", _reason(f"{SEND} --to a@example.test --subject S < b.bin", **{"b.bin": b"\xff\xfe"}))

    def test_the_last_stdin_redirect_wins_as_in_the_shell(self):
        e = self.fields(f"{SEND} --to a@example.test --subject S < a.txt < b.txt", **{"a.txt": "A", "b.txt": "B"})
        self.assertEqual(e["body"], "B")

    def test_wrappers_and_interpreter_flags(self):
        for pre in ("env FOO=1 ", "command ", "exec ", "nohup ", "time ", "FOO=1 BAR=2 "):
            with self.subTest(pre):
                self.fields(f"{pre}{SEND} --to a@example.test --subject S --body B")
        self.fields("npx tsx scripts/graph-mail.ts send --to a@example.test --subject S --body B")
        self.fields("node --no-warnings scripts/graph-mail.js send --to a@example.test --subject S --body B")
        self.assertIn("not one the reader understands", _reason(f"python3 -W ignore scripts/support-mail/send.py --to a@example.test --subject S --body B"))
        self.assertIn("not one the reader understands", _reason(f"python3 -m something --to a@example.test"))

    def test_an_unknown_wrapper_or_ssh_hides_nothing_it_is_just_unrecognised(self):
        for pre in ("ssh host ", "xargs ", "sudo ", "timeout 5 ", "find . -exec "):
            with self.subTest(pre):
                self.assertIn("no mail command", _reason(f"{pre}{SEND} --to a@example.test --subject S --body B"))

    def test_a_command_name_from_a_variable_is_refused(self):
        self.assertIn("not literal", _reason("$MAILER --to a@example.test --subject S --body B"))

    def test_cd_makes_relative_files_unreadable_but_not_absolute_ones(self):
        self.assertIn("after a cd", _reason(f"cd /tmp; {SEND} --to a@example.test --subject S < b.txt", **{"b.txt": "x"}))
        r = _call(f"cd /tmp; {SEND} --to a@example.test --subject S < {{DIR}}/b.txt", **{"b.txt": "x"})
        self.assertTrue(r["ok"], r)


class CurlReading(unittest.TestCase):
    GM = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

    def test_bundled_flags_and_headers_with_variables(self):
        raw = base64.urlsafe_b64encode(b"To: a@example.test\nSubject: S\n\nx\n").decode()
        body = json.dumps({"raw": raw})
        r = _call(f"curl -sS -L -X POST {self.GM} -H \"Authorization: Bearer $TOKEN\" -H 'Content-Type: application/json' --data-raw '{body}'")
        self.assertTrue(r["ok"], r)
        r = _call(f"curl -sd '{body}' {self.GM}")
        self.assertTrue(r["ok"], r)
        r = _call(f"curl --url {self.GM} --data '{body}'")
        self.assertTrue(r["ok"], r)

    def test_dash_d_at_file_strips_line_breaks_but_data_binary_does_not(self):
        raw = base64.urlsafe_b64encode(b"To: a@example.test\nSubject: S\n\nx\n").decode()
        pretty = json.dumps({"raw": raw}, indent=2)
        self.assertTrue(_call(f"curl -s {self.GM} -d @r.json", **{"r.json": pretty})["ok"])
        self.assertTrue(_call(f"curl -s {self.GM} --data-binary @r.json", **{"r.json": pretty})["ok"])

    def test_a_glob_in_the_url_is_not_read(self):
        # curl turns {a,b} and [1-3] into several requests with the same body: one command, several mails.
        raw = base64.urlsafe_b64encode(b"To: a@example.test\nSubject: S\n\nx\n").decode()
        body = json.dumps({"raw": raw})
        for url in (self.GM + "?x={1,2}", self.GM + "?x=[1-3]", "https://gmail.googleapis.com/gmail/v1/users/{me,you}/messages/send",
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send?a=}"):
            for flags in ("", "-g ", "--globoff "):
                with self.subTest(url=url, flags=flags):
                    # unquoted: the shell expands braces whatever curl does; quoted without --globoff: curl does
                    for quoted in (False, True):
                        u = "'%s'" % url if quoted else url
                        r = _call(f"curl -s {flags}{u} -d '{body}'")
                        if quoted and flags:
                            continue   # the one readable shape, below
                        self.assertFalse(r["ok"], (url, flags, quoted))
                        self.assertIn("expand", r["hint"])

    def test_a_glob_in_an_upload_file_is_not_read(self):
        # -T "{a,b}" uploads (sends) every file it names
        good = json.dumps({"raw": base64.urlsafe_b64encode(b"To: a@example.test\nSubject: S\n\nx\n").decode()})
        files = {"a.json": good, "b.json": good}
        for opt in ("-T '{a.json,b.json}'", "--upload-file '[ab].json'", "-T'{a.json,b.json}'"):
            with self.subTest(opt):
                r = _call(f"curl -s {opt} {self.GM}", **files)
                self.assertFalse(r["ok"], r)
                self.assertIn("expand", r["hint"])
        self.assertTrue(_call(f"curl -s -T a.json {self.GM}", **files)["ok"])

    def test_brackets_are_plain_characters_with_globoff_and_a_quoted_url(self):
        raw = base64.urlsafe_b64encode(b"To: a@example.test\nSubject: S\n\nx\n").decode()
        body = json.dumps({"raw": raw})
        for flags in ("-g", "--globoff", "-sg"):
            with self.subTest(flags):
                r = _call(f"curl {flags} '{self.GM}?x={{1,2}}' -d '{body}'")
                self.assertTrue(r["ok"], r)
        r = _call(f"curl -s {self.GM} -d '{body}'")   # no brackets: unchanged
        self.assertTrue(r["ok"], r)

    def test_the_url_and_the_body_must_be_literal(self):
        self.assertIn("expand", _reason(f"curl -s {self.GM} -d \"$BODY\""))
        self.assertIn("expand", _reason("curl -s \"$URL\" -d '{}'"))
        self.assertIn("exactly one URL", _reason("curl -s -d '{}'"))

    def test_options_that_change_what_curl_does_are_not_read(self):
        for opt in ("-G", "-K cfg", "--config cfg", "--next", "-T-", "-F a=b", "--form a=b", "-:", "--json {}"):
            with self.subTest(opt):
                r = _call(f"curl -s {self.GM} -d '{{}}' {opt}")
                self.assertFalse(r["ok"], opt)

    def test_the_resend_route(self):
        body = json.dumps({"from": "a@example.test", "to": "b@example.test", "subject": "S", "text": "x"})
        r = _call(f"curl -s -X POST https://api.resend.com/emails -d '{body}'")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["envelope"]["to"], ["b@example.test"])
        self.assertEqual(r["envelope"]["from"], "a@example.test")
        bad = json.dumps({"to": ["b@example.test"], "bcc": ["c@example.test"], "subject": "S", "text": "x"})
        self.assertEqual(_call(f"curl -s https://api.resend.com/emails -d '{bad}'")["envelope"]["bcc"], ["c@example.test"])


class MailAndSendmailReading(unittest.TestCase):
    def test_mail_needs_a_recipient_and_a_body(self):
        self.assertFalse(_call("mail -s S <<'EOF'\nx\nEOF")["ok"])
        r = _call("mail -s S a@example.test <<'EOF'\nx\nEOF")
        self.assertTrue(r["ok"], r)

    def test_mail_options_that_attach_files_are_not_read(self):
        self.assertIn("not one the reader understands", _reason("mail -a f.txt -s S a@example.test <<'EOF'\nx\nEOF"))

    def test_clustered_sendmail_flags_and_glued_values(self):
        r = _call("sendmail -ti -fme@example.test <<'EOF'\nTo: a@example.test\nSubject: S\n\nx\nEOF")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["envelope"]["to"], ["a@example.test"])

    def test_a_command_line_recipient_is_not_lost_when_the_headers_name_others(self):
        r = _call("sendmail spy@example.test <<'EOF'\nTo: a@example.test\nSubject: S\n\nx\nEOF")
        self.assertEqual(r["envelope"]["to"], ["a@example.test"])
        self.assertEqual(r["envelope"]["bcc"], ["spy@example.test"])

    def test_a_command_line_recipient_given_in_another_case_is_not_added_twice(self):
        r = _call("sendmail a@EXAMPLE.test <<'EOF'\nTo: a@example.test\nSubject: S\n\nx\nEOF")
        self.assertEqual(r["envelope"]["bcc"], [])


class CommandSendsMail(unittest.TestCase):
    """command_sends_mail(): the question the send gate asks of a Bash call beside the send classifier."""

    def test_a_mail_program_is_a_send_even_when_the_shell_reading_gives_up(self):
        self.assertTrue(E.command_sends_mail("python3 gmail-send.py --to a@example.test"))
        self.assertTrue(E.command_sends_mail("x=$(cat f); msmtp a@example.test"))
        self.assertTrue(E.command_sends_mail('echo "$(date)" ; send.py --to a@example.test'))
        self.assertTrue(E.command_sends_mail('bash -c "send.py --to a@example.test"'))

    def test_a_mail_program_behind_a_wrapper_the_reader_does_not_follow_is_a_send(self):
        base = "send.py --to a@example.test --subject Hi --body Hello"
        for cmd in ("timeout 30 " + base, "nice -n5 " + base, "sudo " + base, "echo a | xargs " + base, "stdbuf -o0 " + base,
                    "eval '" + base + "'", "find . -exec " + base + " \\;", "watch " + base, 'bash -lc "' + base + '"',
                    "ssh host '" + base + "'", "mail -s Hi a@example.test", "mutt -s Hi a@example.test",
                    "python3 -m py_compile scripts/support-mail/send.py"):
            with self.subTest(cmd=cmd):
                self.assertTrue(E.command_sends_mail(cmd))

    def test_a_head_that_can_run_what_an_argument_names_is_not_inert(self):
        for cmd in ("git -c alias.x='!send.py --to a@example.test' x", "git -c core.pager=sendmail log", "git --exec-path=/x diff send.py",
                    "rg --pre send.py foo", "sort --compress-program=sendmail f", "vim -c '!send.py' f", "less send.py",
                    "tee send.py"):
            with self.subTest(cmd=cmd):
                self.assertTrue(E.command_sends_mail(cmd))
        # git and rg are not trusted with a mail program's name among their arguments (see test below)
        self.assertTrue(E.command_sends_mail("git diff scripts/gmail-send.py"))
        self.assertTrue(E.command_sends_mail("rg sendmail src"))

    def test_a_name_in_an_assignment_or_a_config_value_runs_under_an_inert_head(self):
        for cmd in ("GIT_PAGER=send.py git log", "GIT_EXTERNAL_DIFF=sendmail git diff", "git config core.pager send.py",
                    "git -c core.pager=sendmail log", "git log --pretty=format:x --pager=msmtp"):
            with self.subTest(cmd=cmd):
                self.assertTrue(E.command_sends_mail(cmd))
        self.assertFalse(E.command_sends_mail("FOO=1 ls scripts"))

    def test_a_shell_c_in_a_cluster_of_short_options_is_read_as_c(self):
        for flags in ("-c", "-lc", "-ec", "-xc"):
            with self.subTest(flags):
                self.assertTrue(E.command_sends_mail("bash %s \"$X\"" % flags))
                self.assertTrue(E.command_sends_mail("bash %s 'send.py --to a@example.test --subject S --body b'" % flags))
                self.assertFalse(E.command_sends_mail("bash %s 'ls'" % flags))

    def test_git_is_not_trusted_with_a_mail_program_name(self):
        # No parsing of git's options (global options with values, abbreviated long options, clusters, subcommands
        # that run a program): a name anywhere in a git command makes it a possible send, the owner can live with
        # the false alarm. A git command without such a name is an ordinary command.
        for cmd in ("git rebase --exec send.py main", "git difftool -x sendmail", "git bisect run send.py",
                    "git submodule foreach send.py", "git filter-branch --tree-filter msmtp", "git grep -O send.py x",
                    "git -C /tmp -c core.pager=sendmail log", "git grep -Osend.py x", "git grep --open send.py x",
                    "git diff scripts/gmail-send.py", "git add scripts/gmail-send.py && git commit -m x", "git log -S sendmail"):
            with self.subTest(cmd=cmd):
                self.assertTrue(E.command_sends_mail(cmd))
        for cmd in ("git status", "git rebase main", "git log --oneline -5", "git diff scripts/lib/email_extract.py", "git commit -m 'fix a bug'"):
            with self.subTest(cmd=cmd):
                self.assertFalse(E.command_sends_mail(cmd))

    def test_a_wrapper_or_interpreter_with_a_variable_to_run_is_a_possible_send(self):
        for cmd in ("env $X", "env -i FOO=1 timeout 5 $X", "nohup xargs $X", "command eval $X", "timeout 5 $X", "xargs $X", "eval $X", "sudo $X", "find . -exec $X ;", 'python3 -c "$X"', "node -e $X",
                    "ssh host $X", "nice -n5 $X"):
            with self.subTest(cmd=cmd):
                self.assertTrue(E.command_sends_mail(cmd))
        for cmd in ("timeout 5 ls", "python3 -c 'print(1)'", "find . -name '*.py'", "xargs ls", 'python3 "$X/job.py" --a b'):
            with self.subTest(cmd=cmd):
                self.assertFalse(E.command_sends_mail(cmd))

    def test_a_command_nobody_can_name_is_a_possible_send_but_an_everyday_variable_is_not(self):
        self.assertTrue(E.command_sends_mail("$CMD --to a@example.test"))
        self.assertTrue(E.command_sends_mail('bash -c "$X"'))
        self.assertFalse(E.command_sends_mail('python3 "$X/job.py" --a b'))
        self.assertFalse(E.command_sends_mail("echo $(date)"))

    def test_an_unparsable_command_is_judged_by_its_text_through_quoting_and_escapes(self):
        for cmd in ("echo $(date) `sendmail -t`", "echo $(date); {sendmail,-t}", "echo $(date); send\\.py x", "echo $(date); 's'end.py",
                    "echo $(date) <send.py", "echo $(date) !sendmail"):
            with self.subTest(cmd=cmd):
                self.assertTrue(E.command_sends_mail(cmd))
        self.assertFalse(E.command_sends_mail("echo $(date) gmail-sendx.py my-send.py.bak"))

    def test_a_command_that_only_looks_at_files_is_not_a_send(self):
        for cmd in ("cat scripts/support-mail/send.py", "grep -rn sendmail src",
                    "cat mail.txt", "echo mail", "ls scripts/ | head", "npx vitest run --silent",
                    "python3 -m pytest scripts/__tests__/email-extract.test.py"):
            with self.subTest(cmd=cmd):
                self.assertFalse(E.command_sends_mail(cmd))

    def test_other_commands_are_not(self):
        self.assertFalse(E.command_sends_mail('echo "$(date)"'))
        self.assertFalse(E.command_sends_mail("curl -s localhost:3420/api/x"))   # a curl is the send classifier's question
        self.assertFalse(E.command_sends_mail("ls -la"))
        self.assertFalse(E.command_sends_mail(None))
        self.assertFalse(E.command_sends_mail(["send.py"]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
