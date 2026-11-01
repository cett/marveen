#!/usr/bin/env python3
"""Tests for scripts/hooks/browser-content-notice.py: scrub() is linear.

The old SECURITY_TAG_RX ended in an unbounded `[^>]*>`; a page full of openers and no
'>' made it quadratic (550 kB held the hook for ~85 s, past the 10 s hook timeout, so
the fail-closed wrapper denied the tool result). scrub() now finds only the opener
and looks up the closing '>' with one shared forward search, the algorithm of
scrubSecurityTags in src/prompt-safety.ts.

Pinned here: tags of at most 2000 characters are cut whole, as before; the old
pattern and the new code agree on realistic input; an over-long or unterminated
opener is neutralized on its own; 550 kB without a '>' stays under the linear ceiling (timing_budget.py).

Privacy: neutral fixture names only.
"""
import importlib.util
import os
import re
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from timing_budget import LINEAR_CEILING_SEC  # noqa: E402  (the one ceiling of the linear-time tests)

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "browser-content-notice.py",
)
_spec = importlib.util.spec_from_file_location("browser_content_notice", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

# The pre-fix pattern, kept here as the oracle for the differential test only.
OLD_RX = re.compile(
    r"<\s*/?\s*(untrusted|trusted-peer|scheduled-task|system-reminder)\b[^>]*>", re.I
)
S = hook.STRIPPED_SENTINEL
SPAN = hook.SECURITY_TAG_SPAN_MAX
BIG = 550_000
BUDGET_SEC = LINEAR_CEILING_SEC  # a linearity ceiling (timing_budget.py): the old pattern needs ~85 s on 550 kB


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
        "plain page text with no tags at all",
        "",
        '<untrusted source="web">hello</untrusted>',
        '<trusted-peer source="agent:x"> a </trusted-peer> tail',
        "<scheduled-task>do it</scheduled-task><system-reminder>r</system-reminder>",
        "< / untrusted >spaced<  trusted-peer a='1' >x",
        "UPPER <UNTRUSTED SOURCE=1>x</UNTRUSTED>",
        "<untrusted-extra>not ours</untrusted-extra> <untrustedx> <untrusted>",
        '<untrusted a="1" <trusted-peer b="2">nested</trusted-peer> still</untrusted>',
        "<channel source='x'>other tag is not scrubbed here</channel>",
        "a > b < c and <untrusted\nmulti\nline\nattrs>x",
        "<untrusted><untrusted><untrusted>",
        "text <untrusted> mid <system-reminder> end",
    ]

    def test_matches_the_old_pattern_on_realistic_input(self):
        for text in self.CASES:
            with self.subTest(text=text):
                self.assertEqual(hook.scrub(text), OLD_RX.sub(S, text))

    def test_lone_gt_far_away_is_still_a_normal_tag(self):
        text = "<untrusted " + "a" * 500 + ">" + "tail"
        self.assertEqual(hook.scrub(text), S + "tail")


class SpanBoundaryTest(unittest.TestCase):
    def _text(self, span):
        # `<untrusted`, then exactly `span` characters (the first is the space after
        # the name, which counts) up to the closing '>'.
        return "<untrusted " + "a" * (span - 1) + ">" + "tail"

    def test_1999_and_2000_are_cut_whole(self):
        for span in (SPAN - 1, SPAN):
            with self.subTest(span=span):
                self.assertEqual(hook.scrub(self._text(span)), S + "tail")

    def test_2001_is_not_a_tag_only_the_opener_is_neutralized(self):
        out = hook.scrub(self._text(SPAN + 1))
        self.assertEqual(out, S + " " + "a" * SPAN + ">tail")
        self.assertNotIn("<untrusted", out)

    def test_unterminated_opener_is_neutralized(self):
        out = hook.scrub("x<untrusted " + "b" * 5000)
        self.assertEqual(out, "x" + S + " " + "b" * 5000)

    def test_no_live_opener_survives_after_an_overlong_one(self):
        text = "<untrusted " + "c" * (SPAN + 50) + "<trusted-peer a='1'>x"
        out = hook.scrub(text)
        self.assertNotIn("<untrusted", out)
        self.assertNotIn("<trusted-peer", out)

    def test_openers_inside_a_replaced_tag_are_not_replaced_twice(self):
        # The tag ends at the FIRST '>', as it always did; the opener inside it is
        # swallowed with it and produces no second sentinel.
        out = hook.scrub('<untrusted a="<trusted-peer>">x')
        self.assertEqual(out, S + '">x')
        self.assertEqual(out, OLD_RX.sub(S, '<untrusted a="<trusted-peer>">x'))

    def test_scrub_is_idempotent(self):
        text = '<untrusted a="1">x</untrusted> <untrusted ' + "d" * 3000
        once = hook.scrub(text)
        self.assertEqual(hook.scrub(once), once)


class LinearTimeTest(unittest.TestCase):
    def _assert_fast(self, text):
        self.assertGreaterEqual(len(text), BIG - 100)
        elapsed = _best_of(lambda: hook.scrub(text))
        self.assertLess(elapsed, BUDGET_SEC, "scrub took %.3f s on %d bytes" % (elapsed, len(text)))

    def test_openers_without_any_gt(self):
        for opener in ("<untrusted ", "<trusted-peer ", "<scheduled-task ", "<system-reminder ", "</untrusted "):
            with self.subTest(opener=opener):
                self._assert_fast(opener * (BIG // len(opener)))

    def test_openers_with_a_single_far_gt(self):
        self._assert_fast("<untrusted " * (BIG // 11) + ">")

    def test_openers_each_with_an_overlong_span_then_gt(self):
        chunk = "<untrusted " + "z" * (SPAN + 10) + ">"
        self._assert_fast(chunk * (BIG // len(chunk)))

    def test_long_whitespace_run_after_lt(self):
        self._assert_fast("<" + " " * BIG)
        self._assert_fast("<" + " " * (BIG // 2) + "/" + " " * (BIG // 2))

    def test_framing_patterns_survive_the_same_inputs(self):
        for text in ("<" + " " * BIG, "<untrusted " * (BIG // 11)):
            with self.subTest(prefix=text[:12]):
                def run():
                    for _label, rx in hook.FRAMING_PATTERNS:
                        rx.search(text)
                self.assertLess(_best_of(run), BUDGET_SEC)


if __name__ == "__main__":
    unittest.main()
