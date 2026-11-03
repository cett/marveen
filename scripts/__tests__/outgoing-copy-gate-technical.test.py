#!/usr/bin/env python3
"""strip_technical() in scripts/hooks/outgoing-copy-gate.py: same text as the old pattern, linear time.

The TECHNICAL pattern re-scanned a long run from every start inside it (the email alternative on a run with no '@',
the path alternative on a hyphenated run with no '/'): one 550 kB word kept the gate busy for over 90 s (20 kB: 2.3 s),
and the MCP email path has no size cap. (Live, the main agent's email registration wraps the gate in an 8 s alarm that
turns a stuck audit into a deny; run alone it just hangs.) Only the first start of a run is tried now.

Pinned here: the output equals the old pattern's on realistic text and on random strings over the characters that
matter; the deviations (documented) are listed; 550 kB hostile shapes finish under BUDGET.
BUDGET is a linearity ceiling, not a speed claim: the old quadratic pattern needs over 90 s on one 550 kB word, the
linear one well under 0.1 s on a developer machine, so 2 s separates them by a wide margin and a slow shared CI runner
(0.304 s was seen against a 0.3 s ceiling) cannot trip it.
Run: python3 <thisfile>   (OUTGOING_COPY_GATE_PATH names another gate file)   Exit 0 = all pass.
"""
import importlib.util
import os
import random
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from timing_budget import LINEAR_CEILING_SEC, best_of, describe  # noqa: E402  (the ceiling and the cut-off timer of the linear-time tests)
GATE = os.environ.get("OUTGOING_COPY_GATE_PATH") or os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
spec = importlib.util.spec_from_file_location("outgoing_copy_gate", GATE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

OLD = g._TECHNICAL_OLD
BIG = 550_000
BUDGET = LINEAR_CEILING_SEC  # a linearity ceiling (timing_budget.py), not the runner speed
failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")
    if not ok:
        failed.append(name)


def old(text):
    return OLD.sub(" ", text)


print("same text as the old pattern")
CASES = [
    "", "plain prose without technical tokens", "see https://example.test/a/b?c=1 for details",
    "write to a.b+c@example.com today", "the file video.mp4 and marveen.io", "snake_case_name here",
    "path /usr/local/bin and src/web/x.ts and a-b/c-d", "`code span` and `another`", "-foo/bar and --flag/x and ---z/y",
    "snake_case.a@b.cc", "x@y.zz.ww", "a.b@c", "@@@", "a@b.c@d.e", "foo-bar-baz without slash", "a/b", "/a", "a/",
    "video_view event", "https://x.test/a@b.cc", "mail:a@b.cc,c@d.ee", "one\nline/two\nthree_four",
]
for t in CASES:
    check("case %r" % t[:30], g.strip_technical(t) == old(t))

rng = random.Random(9)
toks = ["a", "b1", "_", ".", "@", "-", "--", "/", "+", "`", " ", "\n", "http://", "x.com", "ab", "mp4", "."]
bad = []
for _ in range(80000):
    s = "".join(rng.choice(toks) for _ in range(rng.randint(0, 12)))
    if g.strip_technical(s) != old(s):
        bad.append(s)
# Documented deviation: only the first start of a run is tried, so a token that begins in the MIDDLE of a run
# because another alternative consumed the run's front (e.g. `snake_a--/x`, `foo/bar+baz@x.cc`) is cut differently
# from the old pattern. It needs two technical shapes glued together without a space, and it goes BOTH ways: the
# new pattern can leave a word in the audited text that the old one hid (stricter), and it can hide a word that
# the old one left (more lenient, e.g. `a@b.cx.com-/x.comBANNED@.mp4@a/b`). No attacker gain: a token of its own
# (an email or file name shape with a space around it) is hidden by both. The fuzz is seeded, so the counts are
# exact (the same on Python 3.9 and 3.14): a change in either direction, however small, fails here. The earlier
# "at most 0.5%" bound let a regression below it through.
def length_delta(s):
    return len(g.strip_technical(s)) - len(old(s))


stricter = sum(1 for s in bad if length_delta(s) > 0)
more_lenient = sum(1 for s in bad if length_delta(s) < 0)
check("80000 dense random strings: exactly 114 differ (the documented glued-token case)",
      len(bad) == 114, "%d differ, e.g. %r" % (len(bad), bad[:2]))
check("  the new pattern keeps more text (stricter) in 95 and hides more text (more lenient) in 17",
      (stricter, more_lenient) == (95, 17), "stricter %d, more lenient %d" % (stricter, more_lenient))
check("  every difference sits inside one space-free chunk (glued tokens), none across spaces",
      all(any(g.strip_technical(c) != old(c) for c in re.split(r"\s+", s)) for s in bad))

# Known glued examples, behavior pinned in both patterns (new output, then old output; the direction is in the name).
GLUED = [
    ("snake_a--/x", " --/x", "  ", "stricter: the new pattern leaves ' --/x' in the audited text"),
    ("foo/bar+baz@x.cc", " +baz@ ", "  ", "stricter: the new pattern leaves ' +baz@ '"),
    ("mp4_a--/x.com-ab_-_", " --/ -ab_-_", "  .com-ab_-_", "mixed: different cut, neither hides a letter word"),
    ("a@b.cx.com-/x.comBANNED@.mp4@a/b", " -/ @.mp4@ ", "  .comBANNED@.mp4@ ", "more lenient: the new pattern hides 'BANNED', the old one showed it"),
]
for text, new_out, old_out, why in GLUED:
    check("glued %r: new %r, old %r (%s)" % (text[:24], new_out, old_out, why),
          g.strip_technical(text) == new_out and old(text) == old_out, "new %r old %r" % (g.strip_technical(text), old(text)))

WORDS = ["szia", "a", "terv", "kész", "ok", "video_view", "snake_case_name", "marveen.io", "video.mp4", "x.com",
         "user@example.com", "a.b+c@mail.example.org", "https://example.test/a/b?c=1", "src/web/x.ts", "a-b/c-d",
         "/usr/local/bin", "`code`", "-foo/bar", "--flag/x", "mp4", "e-mail", "2027-es", "foo-bar-baz"]
bad2 = []
for _ in range(60000):
    s = " ".join(rng.choice(WORDS) for _ in range(rng.randint(0, 8)))
    s = s.replace("  ", " ") if rng.random() < 0.5 else s + rng.choice(["", ".", ",", "\n"])
    if g.strip_technical(s) != old(s):
        bad2.append(s)
check("60000 realistic space-separated strings: no difference", not bad2, "%d differ, e.g. %r" % (len(bad2), bad2[:3]))

print("linear time on 550 kB")
SHAPES = {
    "one word": "x" * BIG,
    "one word and an @ at the end": "x" * BIG + "@",
    "one word and a / at the end": "x" * BIG + "/",
    "hyphenated run": "a-" * (BIG // 2),
    "hyphenated run, / at the end": "a-" * (BIG // 2) + "/",
    "dotted run": "a." * (BIG // 2),
    "plus run": "+" * BIG,
    "slashes": "/" * BIG,
    "at signs": "@" * BIG,
    "underscore run": "a_" * (BIG // 2),
    "backticks": "`" * BIG,
    "emails": "a@b.cc " * (BIG // 7),
    "paths": "a/b " * (BIG // 4),
    "words": "szia terv kesz " * (BIG // 15),
}
for name, text in SHAPES.items():
    best = best_of(lambda: g.strip_technical(text))
    check(name, best < BUDGET, "%s on %d bytes" % (describe(best), len(text)))

if failed:
    print("FAILED: %d" % len(failed))
    sys.exit(1)
print("OK")
