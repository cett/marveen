#!/usr/bin/env python3
"""strip_technical() in scripts/hooks/outgoing-copy-gate.py: same text as the old pattern, linear time.

The TECHNICAL pattern re-scanned a long run from every start inside it (the email alternative on a run with no '@',
the path alternative on a hyphenated run with no '/'): one 550 kB word kept the gate busy for over 90 s (20 kB: 2.3 s),
and the MCP email path has no size cap, so the mail left unchecked. Only the first start of a run is tried now.

Pinned here: the output equals the old pattern's on realistic text and on random strings over the characters that
matter; the deviations (documented) are listed; 550 kB hostile shapes take under 300 ms.
Run: python3 <thisfile>   (OUTGOING_COPY_GATE_PATH names another gate file)   Exit 0 = all pass.
"""
import importlib.util
import os
import random
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.environ.get("OUTGOING_COPY_GATE_PATH") or os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
spec = importlib.util.spec_from_file_location("outgoing_copy_gate", GATE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

OLD = g._TECHNICAL_OLD
BIG = 550_000
BUDGET = 0.3
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
    best = None
    for _ in range(3):
        t = time.perf_counter()
        g.strip_technical(text)
        dt = time.perf_counter() - t
        best = dt if best is None else min(best, dt)
    check(name, best < BUDGET, "%.3f s on %d bytes" % (best, len(text)))

if failed:
    print("FAILED: %d" % len(failed))
    sys.exit(1)
print("OK")
