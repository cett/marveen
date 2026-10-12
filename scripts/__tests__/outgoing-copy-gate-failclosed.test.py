#!/usr/bin/env python3
"""Exit-code contract of scripts/hooks/outgoing-copy-gate.py on malformed input.

Regression guard: a non-dict tool_input crashed the gate with an unhandled
AttributeError -> exit 1. PreToolUse treats exit 1 as NON-blocking, so the
send ran UNCHECKED -- the exact opposite of the email path's fail-closed
contract. The fix is a top-level fail-closed net: any unexpected crash on the
email/Bash send paths exits 2 (block), while the telegram path keeps its own
deliberate fail-open handling (exit 0) and non-send tools stay untouched.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")


def run_gate(payload) -> int:
    data = payload if isinstance(payload, str) else json.dumps(payload)
    proc = subprocess.run(
        [sys.executable, GATE], input=data.encode(), capture_output=True,
    )
    return proc.returncode


CASES = [
    ("email with non-dict tool_input BLOCKS (was: crash, exit 1, send ran unchecked)",
     {"tool_name": "mcp__x__send_email", "tool_input": ["x"]}, 2),
    ("Bash with non-dict tool_input BLOCKS (command is uninspectable)",
     {"tool_name": "Bash", "tool_input": "not-a-dict"}, 2),
    ("telegram reply with non-dict tool_input stays FAIL-OPEN by design",
     {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": 42}, 0),
    ("non-send tool with malformed input passes (the net never widens the gate)",
     {"tool_name": "Read", "tool_input": ["x"]}, 0),
    ("unparseable stdin still exits 0 (must not wedge the session)",
     "this is not json", 0),
]

failed = []
for name, payload, want in CASES:
    got = run_gate(payload)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: exit={got} want={want}")

# --- THE SHARED RULE'S OWN IMPORT MUST FAIL CLOSED TOO -----------------------
# The mixed-script rule lives in scripts/lib/mixed_script.py so both gates share
# it. That import fires during MODULE LOAD, so a bare ImportError
# escapes the __main__ net above and exits 1 -- which PreToolUse reads as
# NON-blocking. An extraction that turns "checked" into "ran unchecked" is a
# worse bug than the duplication it removed, so the failure mode is pinned here.
#
# The rule file alone is removed from the copied tree, so the block can only
# come from the missing-rule path and this case measures exactly that.
import shutil
import tempfile

with tempfile.TemporaryDirectory() as _tmp:
    _root = os.path.join(_tmp, "scripts")
    shutil.copytree(os.path.join(os.path.dirname(HERE), "hooks"), os.path.join(_root, "hooks"))
    shutil.copytree(os.path.join(os.path.dirname(HERE), "lib"), os.path.join(_root, "lib"))
    os.remove(os.path.join(_root, "lib", "mixed_script.py"))
    _gate = os.path.join(_root, "hooks", "outgoing-copy-gate.py")
    _payload = json.dumps({
        "tool_name": "Bash",
        "tool_input": {"command": "curl -s -X POST http://localhost:3420/api/messages "
                                  "-d '{\"from\":\"igor\",\"to\":\"hex\",\"content\":\"tiszta szoveg\"}'"},
    })
    _proc = subprocess.run([sys.executable, _gate], input=_payload.encode(), capture_output=True)
    _err = _proc.stderr.decode("utf-8", "replace")
    _name = "a missing mixed_script.py BLOCKS (was: exit 1, i.e. NON-blocking)"
    _ok = _proc.returncode == 2
    failed.append(_name) if not _ok else None
    print(f"  [{'PASS' if _ok else 'FAIL'}] {_name}: exit={_proc.returncode} want=2")

    _name2 = "  ...and it says the RULE could not load, not that a homoglyph was found"
    _ok2 = ("NEM TOLTHETO BE" in _err) and ("mixed_script" in _err)
    failed.append(_name2) if not _ok2 else None
    print(f"  [{'PASS' if _ok2 else 'FAIL'}] {_name2}: stderr={_err[:120]!r}")

# --- A HOOK THAT DOES NOT FINISH IS A HOOK THAT DOES NOT BLOCK -------
# The host blocks only on exit 2 (or a deny decision); a hook that is still running at its
# timeout (10 s in the settings) is NON-blocking, so a command the classifier cannot finish on
# was waved through. The heredoc scan used to be superlinear (a lazy regex re-run for every
# never-closed opener, plus an intro that backtracked quadratically): 50 openers x 100K did not
# finish in 90 s. The cases below run the REAL hook with a wall-clock bound, so a regression
# shows as a TIMEOUT here instead of as an unchecked send in the field.
HOOK_BUDGET_S = 8  # the settings give the hook 10 s


def run_gate_timed(command: str):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}).encode()
    t0 = time.monotonic()
    try:
        proc = subprocess.run([sys.executable, GATE], input=payload, capture_output=True, timeout=HOOK_BUDGET_S)
    except subprocess.TimeoutExpired:
        return None, time.monotonic() - t0, ""
    return proc.returncode, time.monotonic() - t0, proc.stderr.decode("utf-8", "replace")


ADVERSARIAL = [
    ("200 never-closed heredoc openers + 100K padding is DENIED (too large), not a hang",
     "".join(f"cat <<T{i}\n" for i in range(200)) + "x" * 100000, 2, "tul nagy"),
    ("50 openers, each followed by a 2K word and no newline, is DENIED (was: > 20 s)",
     " ".join("<<" + "A" * 2000 for _ in range(50)), 2, "tul nagy"),
    ("`<<` + 100K word characters finishes and passes (was: > 12 s)",
     "cat <<" + "A" * 100000, 0, ""),
    ("32 never-closed openers + 100K padding (the allowed maximum) finishes and passes",
     "".join(f"cat <<T{i}\n" for i in range(32)) + "x" * 100000, 0, ""),
    ("a wrapper with 30000 unknown flags is DENIED (was: > 12 s)",
     "sudo " + "--a " * 30000 + "true", 2, "tul nagy"),
    ("a command over the size limit is DENIED, even a harmless one",
     "echo " + "x" * 140000, 2, "tul nagy"),
]
for name, command, want, needle in ADVERSARIAL:
    code, secs, err = run_gate_timed(command)
    if code is None:
        ok, shown = False, f"TIMED OUT after {HOOK_BUDGET_S}s (a timed-out hook is NON-blocking: fail-OPEN)"
    else:
        ok = code == want and needle in err and secs < HOOK_BUDGET_S
        shown = f"exit={code} want={want} in {secs:.2f}s"
    failed.append(name) if not ok else None
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {shown}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate fail-closed tests passed.")
