#!/usr/bin/env python3
"""_heredoc_redirect_target() in scripts/hooks/outgoing-copy-gate.py: same answer as the old single pattern, linear.

The old pattern (`cat`/`tee`, a lazy `[^\\n]*?`, a redirect or `tee`, a file name) searched the rest of the line
again from every `cat`/`tee`: ` cat` x N took 4.6 s at 40 kB and 16 s at 80 kB. The head and the tail are separate
patterns now, the tail tried once per candidate position. In the gate the input is one heredoc opener line, which
the existing limits keep under 4 KB, so this is defence in depth; the answer must not change.

Run: python3 <thisfile>   (OUTGOING_COPY_GATE_PATH names another gate file)   Exit 0 = all pass.
"""
import importlib.util
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from timing_budget import LINEAR_CEILING_SEC, best_of, describe  # noqa: E402  (the ceiling and the cut-off timer of the linear-time tests)
GATE = os.environ.get("OUTGOING_COPY_GATE_PATH") or os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
spec = importlib.util.spec_from_file_location("outgoing_copy_gate", GATE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

# The pre-fix pattern, the oracle for the differential checks only.
OLD = re.compile(r"(?:^|[\s;&|(])(?:cat|tee)\b[^\n]*?(?:>>?|\btee(?:\s+-a)?)\s*(['\"]?)([^\s'\"<>;&|]+)\1")
BIG = 550_000
# A linearity ceiling, not a speed claim (timing_budget.py): the old pattern needs seconds already at 40 kB (` cat` x N:
# 4.6 s) and far longer at 550 kB, the linear one stays well under 0.1 s.
BUDGET = LINEAR_CEILING_SEC
failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")
    if not ok:
        failed.append(name)


def old_target(text):
    m = OLD.search(text)
    return m.group(2) if m else None


print("same answer as the old pattern")
CASES = [
    "", "no heredoc here", "cat <<EOF > out.txt", "cat > out.txt <<EOF", "cat >> log.txt <<'EOF'",
    "tee out.txt <<EOF", "tee -a out.txt <<EOF", "cat <<EOF | tee /tmp/x.sh", "echo hi; cat > a.py <<EOF",
    "cat <<EOF >'quoted name'", 'cat <<EOF >"dq.txt"', "cat <<EOF > 'q.txt'", "cat <<EOF >", "cat >", "tee",
    "cat\n> after.txt", "cat a\n b > not-same-line.txt", "(cat > sub.txt) <<EOF", "catalog > x", "cat\tcat > y",
    "cat > a > b", "cat >> >> c", "xcat > y", "cat <<EOF >out;more", "cat <<E >a&b",
]
for text in CASES:
    check("case %r" % text[:28], g._heredoc_redirect_target(text) == old_target(text))

rng = random.Random(5)
toks = ["cat", "tee", " ", ">", ">>", "-a", "f.txt", "'", '"', "\n", ";", "|", "(", "<<EOF", "x", "catx", "\t"]
bad = 0
for _ in range(60000):
    s = "".join(rng.choice(toks) for _ in range(rng.randint(0, 14)))
    if g._heredoc_redirect_target(s) != old_target(s):
        bad += 1
        if bad < 4:
            print("    mismatch:", repr(s), g._heredoc_redirect_target(s), old_target(s))
check("60000 random strings", bad == 0, "%d mismatches" % bad)

print("linear time on 550 kB")
SHAPES = {
    "cat x N": " cat" * (BIG // 4),
    "tee x N": " tee" * (BIG // 4),
    "cat x N, one redirect at the end": " cat" * (BIG // 4) + " > f",
    "cat x N, a bare > at the end": " cat" * (BIG // 4) + " >",
    "cat lines": "cat x\n" * (BIG // 6),
    "cat and > alternating": "cat > " * (BIG // 6),
    "cat then long quote run": "cat > '" + "a" * BIG,
}
for name, text in SHAPES.items():
    best = best_of(lambda: g._heredoc_redirect_target(text))
    check(name, best < BUDGET, "%s on %d bytes" % (describe(best), len(text)))

if failed:
    print("FAILED: %d" % len(failed))
    sys.exit(1)
print("OK")
