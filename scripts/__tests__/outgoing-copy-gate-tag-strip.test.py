#!/usr/bin/env python3
"""_strip_tags() in scripts/hooks/outgoing-copy-gate.py: same output as the old regex, in linear time.

audit() removed markup with `re.sub(r"<[^>]+>", " ", text)`. From every '<' without a '>' after it the regex
searched the rest of the string again, so a body of 550 kB made of '<' and no '>' took ~40 s. A hook still running
at its timeout is not a deny, so a slow audit is a fail-open.

Pinned here: the output equals the old regex's on realistic text, on the edge shapes ("<>", nested '<', a '>' only
far away) and on 20000 random strings over a tiny alphabet; 550 kB of hostile shapes stays under the linear ceiling (timing_budget.py).
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

OLD_TAG = re.compile(r"<[^>]+>")  # the pre-fix pattern, the oracle for the differential checks only
BIG = 550_000
BUDGET_SEC = LINEAR_CEILING_SEC  # a linearity ceiling (timing_budget.py): the old regex needs ~40 s on 550 kB

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")
    if not ok:
        failed.append(name)


print("same output as the old regex")
CASES = [
    "",
    "plain text",
    "<b>bold</b> and <a href='x'>link</a>",
    "a <> b",
    "<>",
    "<><a>",
    "<<a>>",
    "a < b and c > d",
    "x <a <b> y",
    "<a\nmulti\nline>tail",
    "unterminated <a",
    "< >",
    "text <",
    "> leading gt <b>x",
]
for text in CASES:
    check("case %r" % text[:30], g._strip_tags(text) == OLD_TAG.sub(" ", text))

rng = random.Random(7)
mismatches = 0
for _ in range(20000):
    s = "".join(rng.choice("<>ab ") for _ in range(rng.randint(0, 14)))
    if g._strip_tags(s) != OLD_TAG.sub(" ", s):
        mismatches += 1
check("20000 random strings over '<>ab '", mismatches == 0, "%d mismatches" % mismatches)

print("linear time on 550 kB")
for name, text in (
    ("lt only", "<a " * (BIG // 3)),
    ("lt, one far gt", "<a " * (BIG // 3) + ">"),
    ("empty tags", "<>" * (BIG // 2)),
    ("lt then gt pairs", "<a>" * (BIG // 3)),
    ("lt with gt every 100", ("<a " * 33 + ">") * (BIG // 100)),
):
    dt = best_of(lambda: g._strip_tags(text))
    check(name, dt < BUDGET_SEC, "%s on %d bytes" % (describe(dt), len(text)))

print("audit() still uses it")
check("markup is not audited as prose", g.audit("<b>x</b>") == g.audit(" x "))

if failed:
    print("FAILED: %d" % len(failed))
    sys.exit(1)
print("OK")
