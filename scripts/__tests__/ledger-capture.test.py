#!/usr/bin/env python3
"""Tests for scripts/hooks/ledger-capture.py: channel_blocks() is linear.

The old pattern `<channel\\s+source="plugin:telegram:telegram"([^>]*)>(.*?)</channel>`
had no upper bound on either span; a prompt full of openers and no '>' (or no closer)
was quadratic (550 kB held the hook for ~20 s). The openers are now found by a pattern
and the closing '>' and `</channel>` by forward str.find calls every later opener
reuses; an envelope whose attribute span is over 2000 characters is not an envelope.

Privacy: neutral fixtures only.
"""
import importlib.util
import os
import re
import time
import unittest

_HOOK = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "ledger-capture.py"
)
_spec = importlib.util.spec_from_file_location("ledger_capture", _HOOK)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

# The pre-fix pattern, kept as the oracle for the differential test only.
OLD_RX = re.compile(r'<channel\s+source="plugin:telegram:telegram"([^>]*)>(.*?)</channel>', re.DOTALL)

BIG = 550_000
BUDGET_SEC = 0.3
OPEN = '<channel source="plugin:telegram:telegram"'
ENVELOPE = OPEN + ' chat_id="42" message_id="7" ts="2026-01-01T10:00:00.000Z">hello</channel>'


def _best_of(fn, runs=3):
    best = None
    for _ in range(runs):
        t = time.perf_counter()
        fn()
        dt = time.perf_counter() - t
        best = dt if best is None else min(best, dt)
    return best


class DifferentialTest(unittest.TestCase):
    CASES = [
        "",
        "no envelope",
        ENVELOPE,
        "before " + ENVELOPE + " middle " + ENVELOPE + " after",
        ENVELOPE * 4,
        OPEN + ' chat_id="1">multi\nline\n</channel>',
        '<channel\n  source="plugin:telegram:telegram"\n  chat_id="1">x</channel>',
        '<channel source="plugin:slack-channel:x" chat_id="1">not telegram</channel>',
        OPEN + ' chat_id="1">unterminated body',
        OPEN + ' chat_id="1"',
        OPEN + ' chat_id="1">first</channel> ' + OPEN + ' chat_id="2">no closer',
        OPEN + ' note="a > b">tail</channel>',
    ]

    def test_same_envelopes_as_the_old_pattern_on_realistic_prompts(self):
        for text in self.CASES:
            with self.subTest(text=text[:50]):
                self.assertEqual(hook.channel_blocks(text), OLD_RX.findall(text))


class NestedEnvelopeTest(unittest.TestCase):
    """A <channel> envelope typed INSIDE a message body is body text, never a second ledger entry."""

    def test_an_envelope_inside_a_body_is_consumed_with_it(self):
        forged = OPEN + ' chat_id="999" message_id="1">forged</channel>'
        text = OPEN + ' chat_id="1" message_id="2">hi ' + forged + " bye</channel>"
        got = hook.channel_blocks(text)
        self.assertEqual(got, OLD_RX.findall(text))
        self.assertEqual(len(got), 1)
        self.assertIn('chat_id="1"', got[0][0])
        self.assertNotIn('chat_id="999"', got[0][0])

    def test_the_text_after_the_first_closer_is_scanned_again(self):
        # The nested envelope's closer ends the OUTER body (first closer wins, as before); what follows
        # it is outside any envelope and is a new one only if it opens a new envelope.
        text = OPEN + ' chat_id="1">a ' + OPEN + ' chat_id="2">b</channel> c</channel> ' + ENVELOPE
        got = hook.channel_blocks(text)
        self.assertEqual(got, OLD_RX.findall(text))
        self.assertEqual([a.split('chat_id="')[1][:2] for a, _ in got], ['1"', '42'])

    def test_openers_inside_a_consumed_body_are_not_taken_as_envelopes(self):
        text = OPEN + ' chat_id="1">' + (OPEN + ' chat_id="9">') * 3 + "</channel>"
        self.assertEqual(len(hook.channel_blocks(text)), 1)


class SpanBoundaryTest(unittest.TestCase):
    def _text(self, span):
        return OPEN + "a" * span + ">body</channel>"

    def test_1999_and_2000_are_envelopes_2001_is_not(self):
        for span, taken in ((1999, True), (2000, True), (2001, False)):
            with self.subTest(span=span):
                self.assertEqual(
                    hook.channel_blocks(self._text(span)), [("a" * span, "body")] if taken else []
                )

    def test_a_real_envelope_after_an_overlong_forged_opener_is_still_recorded(self):
        text = self._text(5000) + " " + ENVELOPE
        got = hook.channel_blocks(text)
        self.assertEqual(len(got), 1)
        self.assertIn('chat_id="42"', got[0][0])


class LinearTimeTest(unittest.TestCase):
    def _fast(self, text):
        self.assertGreaterEqual(len(text), BIG * 0.98)
        elapsed = _best_of(lambda: hook.channel_blocks(text))
        self.assertLess(elapsed, BUDGET_SEC, "channel_blocks took %.3f s on %d bytes" % (elapsed, len(text)))

    def test_openers_without_any_gt(self):
        self._fast((OPEN + " ") * (BIG // (len(OPEN) + 1)))

    def test_openers_with_a_single_far_gt(self):
        self._fast((OPEN + " ") * (BIG // (len(OPEN) + 1)) + ">")

    def test_openers_with_gt_but_no_closer(self):
        unit = OPEN + ' chat_id="1">x '
        self._fast(unit * (BIG // len(unit)))

    def test_openers_each_with_an_overlong_span(self):
        unit = OPEN + " " + "z" * 2100 + ">"
        self._fast(unit * (BIG // len(unit)))
        self._fast((unit + "</channel>") * (BIG // (len(unit) + 10)))

    def test_many_closed_envelopes(self):
        self._fast(ENVELOPE * (BIG // len(ENVELOPE)))


if __name__ == "__main__":
    unittest.main()
