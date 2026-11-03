#!/usr/bin/env python3
"""Tests for the <channel ...> envelope scan of staleness-guard.py, telegram-ack.py
and telegram_progress.py.

Each of them used to run an unbounded `<channel\\s+([^>]*)>` style pattern over the
whole prompt; a prompt full of openers and no '>' made it quadratic (550 kB held the
hook for ~85 s, past its timeout). The openers are now found by a pattern and the
closing '>' by one shared forward str.find; an envelope whose attribute span is over
2000 characters is not an envelope.

Pinned here: on realistic prompts the old pattern and the new scan agree; the
1999/2000/2001 boundary; 550 kB without a '>' stays under a second.

Privacy: neutral fixture names only.
"""
import importlib.util
import os
import re
import time
import unittest

_HOOKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HOOKS, filename))
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


staleness = _load("staleness_guard", "staleness-guard.py")
ack = _load("telegram_ack", "telegram-ack.py")
progress = _load("telegram_progress", "telegram_progress.py")

# The pre-fix patterns, kept as the oracle for the differential tests only.
OLD_ATTRS_RX = re.compile(r"<channel\s+([^>]*)>", re.DOTALL)
OLD_TELEGRAM_RX = re.compile(r'<channel\b[^>]*\bsource="[^"]*telegram[^"]*"[^>]*>')

BIG = 550_000
BUDGET_SEC = 0.3
ENVELOPE = (
    '<channel source="plugin:telegram:telegram" chat_id="42" message_id="7" '
    'user="someone" ts="2026-01-01T10:00:00.000Z">hello</channel>'
)

REALISTIC = [
    "",
    "no envelope at all",
    ENVELOPE,
    "before " + ENVELOPE + " after " + ENVELOPE,
    '<channel source="plugin:slack-channel:x" chat_id="1">\nmulti\nline\n</channel>',
    '<channel\n  source="plugin:telegram:telegram"\n  chat_id="1" message_id="2">x</channel>',
    "a > b and <channel> bare and <channelization> word " + ENVELOPE,
    '<channel source="a" note="x > y">tail',
    ENVELOPE * 5,
]


def _best_of(fn, runs=3):
    best = None
    for _ in range(runs):
        t = time.perf_counter()
        fn()
        dt = time.perf_counter() - t
        best = dt if best is None else min(best, dt)
    return best


class AttrStringsDifferentialTest(unittest.TestCase):
    def test_both_hooks_match_the_old_pattern_on_realistic_prompts(self):
        for scan in (staleness.channel_attr_strings, ack.channel_attr_strings):
            for text in REALISTIC:
                with self.subTest(scan=scan.__module__, text=text[:40]):
                    self.assertEqual(scan(text), OLD_ATTRS_RX.findall(text))


class TelegramTagsDifferentialTest(unittest.TestCase):
    def test_matches_the_old_pattern_on_realistic_prompts(self):
        for text in REALISTIC:
            with self.subTest(text=text[:40]):
                self.assertEqual(progress.telegram_channel_tags(text), OLD_TELEGRAM_RX.findall(text))

    def test_a_non_telegram_envelope_is_not_returned(self):
        self.assertEqual(progress.telegram_channel_tags('<channel source="plugin:slack-channel:x">y'), [])

    def test_a_real_envelope_after_a_non_telegram_one_is_found(self):
        text = '<channel source="plugin:slack-channel:x">y</channel> ' + ENVELOPE
        self.assertEqual(len(progress.telegram_channel_tags(text)), 1)


class SpanBoundaryTest(unittest.TestCase):
    def test_attr_string_of_1999_2000_is_taken_2001_is_not(self):
        for scan in (staleness.channel_attr_strings, ack.channel_attr_strings):
            for size, taken in ((1999, True), (2000, True), (2001, False)):
                with self.subTest(scan=scan.__module__, size=size):
                    text = "<channel " + "a" * size + ">tail"
                    self.assertEqual(scan(text), ["a" * size] if taken else [])

    def test_tag_span_of_1999_2000_is_taken_2001_is_not(self):
        # The span is counted from the end of `<channel` to the closing '>'.
        head = ' source="plugin:telegram:telegram" x="'
        for size, taken in ((1999, True), (2000, True), (2001, False)):
            with self.subTest(size=size):
                text = "<channel" + head + "b" * (size - len(head) - 1) + '">tail'
                self.assertEqual(len(progress.telegram_channel_tags(text)), 1 if taken else 0)

    def test_a_real_envelope_after_an_overlong_forged_opener_is_still_found(self):
        forged = "<channel " + "f" * 5000 + " "
        text = forged + ENVELOPE
        self.assertEqual(len(ack.channel_attr_strings(text)), 1)
        self.assertEqual(len(staleness.channel_attr_strings(text)), 1)
        self.assertEqual(len(progress.telegram_channel_tags(text)), 1)


class LinearTimeTest(unittest.TestCase):
    def _fast(self, fn, text):
        self.assertGreaterEqual(len(text), BIG * 0.98)
        elapsed = _best_of(lambda: fn(text))
        self.assertLess(elapsed, BUDGET_SEC, "%s took %.3f s on %d bytes" % (fn.__name__, elapsed, len(text)))

    def _scans(self):
        return (staleness.channel_attr_strings, ack.channel_attr_strings, progress.telegram_channel_tags)

    def test_openers_without_any_gt(self):
        for fn in self._scans():
            with self.subTest(fn=fn.__module__):
                self._fast(fn, "<channel " * (BIG // 9))

    def test_openers_with_a_single_far_gt(self):
        for fn in self._scans():
            with self.subTest(fn=fn.__module__):
                self._fast(fn, "<channel " * (BIG // 9) + ">")

    def test_dense_openers_inside_one_span(self):
        # Every span is under the cap, so each opener passes the length check: the
        # telegram scan must not re-search the same text once per opener.
        chunk = '<channel source="x" ' * 90 + ">"
        for fn in self._scans():
            with self.subTest(fn=fn.__module__):
                self._fast(fn, chunk * (BIG // len(chunk)))

    def test_long_whitespace_runs(self):
        for fn in self._scans():
            with self.subTest(fn=fn.__module__):
                self._fast(fn, "<channel" + " " * BIG)
                self._fast(fn, ("<channel" + " " * 1000) * (BIG // 1008))


if __name__ == "__main__":
    unittest.main()
