#!/usr/bin/env python3
"""The heredoc scan of scripts/hooks/outgoing-copy-gate.py is linear, bounded and identical to the old regex.

The ported heredoc classifier ran a lazy heredoc regex over the
command, once per never-closed opener, and the regex itself backtracked quadratically through
its intro (`<<` + a long word run + no newline). 50 openers x 100K did not finish in 90 s. A
hook still running at its timeout is NOT a deny (the host treats anything but exit 2 as
non-blocking), so a slow classifier was a fail-OPEN.

Pinned here:
  1. _scan_heredocs finds EXACTLY what the old regex found (seeded differential, incl. non-ASCII);
  2. hostile shapes finish fast in-process, or raise InspectionLimit (the caller exits 2);
  3. each limit sits right at its documented value, and a real send under the limits still fires.
The end-to-end exit-code cases (a deny inside a time bound) are in outgoing-copy-gate-failclosed.test.py.
The JS twin is pinned in src/__tests__/email-send-gate-heredoc-limits.test.ts.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import os
import random
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
spec = importlib.util.spec_from_file_location("outgoing_copy_gate", GATE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

# The regex the scanner replaced, kept here ONLY as the reference for the differential.
LEGACY = re.compile(r"(<<-?\s*'?(\w+)'?[^\n]*)\n.*?\n\2(?=\s|$)", re.S)

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")
    if not ok:
        failed.append(name)


def legacy(s):
    return [(m.start(), m.end(1), m.end(1) + 1, m.end() - len(m.group(2)), m.end()) for m in LEGACY.finditer(s)]


# --- 1. differential --------------------------------------------------------
rng = random.Random(0xB2B2)
words = ["EOF", "EO", "EOFX", "E", "A", "AB", "ABC", "PY", "X1", "_", "ÉÉ"]
junk = ["", " ", " > f", " | bash", "'", '"x"', " ;", "\t", " EOF"]
tails = ["", " ", ";", "x", "\t", "-", "'", "\r", " ", "\x1c"]


def generate():
    s = ""
    for _ in range(rng.randint(1, 4)):
        s += rng.choice(["", "cat ", "python3 - ", "x\n", " ", "a<<b "])
        s += rng.choice(["<<", "<<-", "<<<", "<< ", "<<\n", "<<  "])
        s += rng.choice(["", "'", '"'])
        s += rng.choice(words)
        s += rng.choice(["", "'", '"'])
        s += rng.choice(junk)
        s += rng.choice(["\n", "\n", "\n", "\r\n", ""])
        for _ in range(rng.randint(0, 3)):
            s += rng.choice(["body", "", " EOF", "EOF" + rng.choice(tails),
                             rng.choice(words) + rng.choice(tails), "<<" + rng.choice(words)]) + "\n"
        if rng.randint(0, 3):
            s += rng.choice(words) + rng.choice(tails)
        if rng.randint(0, 1):
            s += "\n"
    return s


diffs, with_match, multi = [], 0, 0
for _ in range(30000):
    s = generate()
    want = legacy(s)
    with_match += bool(want)
    multi += len(want) > 1
    got = g._scan_heredocs(s)
    if got != want:
        diffs.append((s, want, got))
check("30000 generated commands: identical matches to the old regex", not diffs,
      f"{len(diffs)} diffs, first: {diffs[0]!r}" if diffs else f"{with_match} with a match, {multi} with several")
check("the generator exercises matches and several heredocs", with_match > 5000 and multi > 200)
check("a prefix of the word may close the heredoc (old backtracking kept)", len(g._scan_heredocs("cat <<EOFX\nbody\nEOF\n")) == 1)
check("an empty heredoc is no match (the first body line cannot close)", g._scan_heredocs("cat <<EOF\nEOF\n") == [])
check("the closer needs whitespace or the end after it", g._scan_heredocs("cat <<EOF\nbody\nEOF;\n") == [])

# --- 2. hostile shapes ------------------------------------------------------
CAP = g.MAX_CMD_CHARS
HOSTILE = [
    ("32 never-closed openers + 100K padding", "".join(f"cat <<T{i}\n" for i in range(32)) + "x" * 100000),
    ("`<<` + 100K word characters, no newline", "cat <<" + "A" * 100000),
    ("whitespace run after `<<`", "<<" + " " * 120000),
    ("120K of `<<`", "<<" * 60000),
    ("one opener + 100K lines of padding", "cat <<ZZZ\n" + "x\n" * 50000),
    ("many closer-looking lines of different lengths", "cat <<ZZZ\n" + "".join(f"{'A' * (i % 200 + 1)} \n" for i in range(1200))),
    ("a long matched opener line full of `cat`", "cat " * 1000 + "<<EOF\nbody\nEOF\n"),
    ("32 matched heredocs on ~4K lines", "".join(("cat " * 1000)[:4000 - 12] + f"<<E{i}\nb\nE{i}\n" for i in range(32))),
    ("unbalanced quote + `resend` words (fallback literals)", ("'" + "resend " * 17000)[:CAP]),
    ("assignment chain", ("A=1 " * 30000 + "ls")[:CAP]),
    ("keyword chain", ("! " * 60000 + "ls")[:CAP]),
    ("nested shell heredocs, 3 levels", None),
]
nested = "echo hi\n" * 3000
for _ in range(3):
    nested = "bash <<EOF | bash\n" + nested + "EOF\n"
for name, cmd in HOSTILE:
    cmd = nested if cmd is None else cmd
    t0 = time.perf_counter()
    try:
        verdict = str(g.is_send_invocation(cmd))
    except g.InspectionLimit:
        verdict = "limit"
    ms = (time.perf_counter() - t0) * 1000
    check(f"{name} finishes fast", ms < 4000, f"{ms:.0f} ms ({verdict})")

t0 = time.perf_counter()
try:
    g.is_send_invocation("".join(f"cat <<T{i}\n" for i in range(200)) + "x" * 100000)
    raised = False
except g.InspectionLimit:
    raised = True
check("200 openers x 100K padding is refused at once", raised and time.perf_counter() - t0 < 1.0)

t0 = time.perf_counter()
try:
    g.is_send_invocation("sudo " + "--a " * 30000 + "true")
    raised = False
except g.InspectionLimit:
    raised = True
check("a wrapper with 30000 unknown flags is refused at once", raised and time.perf_counter() - t0 < 2.0)

# --- 3. the limits ----------------------------------------------------------


def limited(cmd):
    try:
        g.is_send_invocation(cmd)
        return None
    except g.InspectionLimit as exc:
        return str(exc)


def openers(n):
    return "".join(f"cat <<T{i}\n" for i in range(n))


check("openers: MAX is fine", limited(openers(g.MAX_HEREDOC_OPENERS)) is None)
check("openers: MAX+1 is refused", "openers" in (limited(openers(g.MAX_HEREDOC_OPENERS + 1)) or ""))
check("command length: MAX is fine", limited("a" * g.MAX_CMD_CHARS) is None)
check("command length: MAX+1 is refused", "characters" in (limited("a" * (g.MAX_CMD_CHARS + 1)) or ""))
check("opener line: just under the limit is fine",
      limited("x" * (g.MAX_OPENER_LINE_CHARS - 20) + " <<EOF\nbody\nEOF\n") is None)
check("opener line: over the limit is refused",
      "opener line" in (limited("x" * (g.MAX_OPENER_LINE_CHARS + 1) + " <<EOF\nbody\nEOF\n") or ""))
check("wrapper flags: MAX is fine", limited("sudo " + "--a " * g.MAX_WRAPPER_FLAG_STARTS + "ls") is None)
check("wrapper flags: MAX+1 is refused", "flags" in (limited("sudo " + "--a " * (g.MAX_WRAPPER_FLAG_STARTS + 1) + "ls") or ""))
check("a real send under the limits is still caught", g.is_send_invocation("python3 - <<'PY'\nimport send\nPY\n") is True)
check("unclosed openers do not hide a later sender", g.is_send_invocation("cat <<A\ncat <<B\nsendmail a@example.invalid") is True)
check("curl --url=<resend> (one glued token) is a send", g.is_send_invocation("curl --url=https://api.resend.com/emails -d '{}'") is True)
check("curl --url=<resend> read-only GET is not", g.is_send_invocation("curl --url=https://api.resend.com/domains") is False)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All heredoc-scan tests passed.")
