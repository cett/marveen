#!/usr/bin/env python3
"""The wrapper-depth deny text of scripts/hooks/outgoing-copy-gate.py.

A command with MORE wrappers in front of its real command than the gate steps over
(nohup/sudo/env/timeout ... x9 + `git status`) cannot be classified, so the gate counts it
as a send and, having no letter text to audit, blocks it. Before this change the block said
"I could not audit the letter", which is the wrong reason. Now the deny names the wrapper
depth, but ONLY when the depth bound is the whole reason. Pinned here:

  1. depth-only commands: exit 2 (unchanged verdict) with the depth text;
  2. every other deny keeps its old text (a visible send, a heredoc send, an unreadable
     --body, a send beside the deep wrapper);
  3. the boundary: _HEAD_DEPTH wrappers pass, one more is the depth deny;
  4. mutants: "always the depth text" and "never the depth text" (and three narrower ones)
     each fail at least one check above.

Run: python3 <thisfile>   (unittest; exit 0 = all pass).
The gate under test: $GATE_UNDER_TEST, else scripts/hooks/outgoing-copy-gate.py of the repo
layout, else outgoing-copy-gate.py.new next to this file.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_gate() -> str:
    env = os.environ.get("GATE_UNDER_TEST")
    if env:
        return env
    repo = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
    if os.path.exists(repo):
        return repo
    return os.path.join(HERE, "outgoing-copy-gate.py.new")


GATE = _find_gate()

# The rule file is read at gate start-up and the gate log goes next to it: keep both in a
# private temp dir so the test never touches the live store/. None of the cases below
# depends on the name rule (the deny / non-send paths exit before it).
_TMP = tempfile.mkdtemp(prefix="wrapper-depth-test-")
RULES = os.path.join(_TMP, "outgoing-copy-gate-rules.json")
with open(RULES, "w", encoding="utf-8") as _fh:
    json.dump({"bad_name_patterns": ["zzz-never-matches-zzz"], "correction": "x"}, _fh)
os.environ["OUTGOING_COPY_GATE_RULES"] = RULES

DEPTH_MARK = "a valodi parancs nem lathato"        # the new text
OLD_MARK = "mert a levelet nem tudtam megvizsgalni"  # the generic text


def run_gate(gate: str, command: str):
    proc = subprocess.run(
        [sys.executable, gate],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}).encode(),
        capture_output=True,
        timeout=60,
    )
    return proc.returncode, proc.stderr.decode("utf-8", "replace")


def _load(gate: str):
    spec = importlib.util.spec_from_file_location("outgoing_copy_gate_under_test", gate)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _depth_limit(gate: str) -> int:
    return _load(gate)._HEAD_DEPTH


def build_cases(limit: int):
    """(name, command, want_exit, texts that must be in stderr, texts that must not be)."""
    nohups = lambda n: "nohup " * n  # noqa: E731
    sudos = lambda n: "sudo " * n    # noqa: E731
    # The `2>&1` tail keeps collect_bash_body from reading the heredoc as a letter body
    # (it wants the newline right after the delimiter), so the deny is the empty-text one,
    # while the heredoc scanner still sees the shell program and its send.
    deep_heredoc_send = nohups(limit + 1) + "bash <<'EOF' 2>&1\nsendmail x\nEOF\n"
    return [
        # --- the depth text -------------------------------------------------
        (f"(a) nohup x{limit + 1} + git status: depth text, still a deny",
         nohups(limit + 1) + "git status", 2, [DEPTH_MARK], [OLD_MARK]),
        (f"one over the boundary (nohup x{limit + 2} + git status): depth text",
         nohups(limit + 2) + "git status", 2, [DEPTH_MARK], [OLD_MARK]),
        (f"(c) sudo x{limit + 1} + true: observed = depth text (the depth is the only reason)",
         sudos(limit + 1) + "true", 2, [DEPTH_MARK], [OLD_MARK]),
        (f"mixed wrappers, {limit + 1} deep, then a harmless command: depth text",
         "sudo nohup env nice timeout 5 sudo nohup env time git status", 2, [DEPTH_MARK], [OLD_MARK]),
        # --- the boundary: fewer wrappers is unchanged (allowed) -------------
        (f"exactly at the limit (nohup x{limit} + git status) is allowed, no text",
         nohups(limit) + "git status", 0, [], [DEPTH_MARK, OLD_MARK]),
        (f"sudo x{limit} + true is allowed, no text",
         sudos(limit) + "true", 0, [], [DEPTH_MARK, OLD_MARK]),
        ("plain git status is allowed", "git status", 0, [], [DEPTH_MARK, OLD_MARK]),
        # --- every other deny keeps the old text ----------------------------
        ("(b) sendmail x: old text, not the depth text",
         "sendmail x", 2, [OLD_MARK], [DEPTH_MARK]),
        (f"a visible send beside a too-deep wrapper (sendmail x; sudo x{limit + 1} true): old text",
         "sendmail x; " + sudos(limit + 1) + "true", 2, [OLD_MARK], [DEPTH_MARK]),
        (f"a real send under the limit (nohup x{limit} sendmail x): old text",
         nohups(limit) + "sendmail x", 2, [OLD_MARK], [DEPTH_MARK]),
        (f"a real send inside a heredoc under a too-deep wrapper: old text, not depth",
         deep_heredoc_send, 2, [OLD_MARK], [DEPTH_MARK]),
        (f"a too-deep wrapper plus an unreadable --body keeps the specific unreadable reason",
         nohups(limit + 1) + 'git status --body "$(cat /x/y.txt)"', 2,
         ["shell-behelyettesitest"], [DEPTH_MARK]),
    ]


def evaluate(gate: str):
    """Names of the cases the gate fails (empty list = all pass)."""
    failed = []
    for name, command, want, must, must_not in build_cases(_depth_limit(gate)):
        code, err = run_gate(gate, command)
        ok = code == want and all(m in err for m in must) and not any(m in err for m in must_not)
        if not ok:
            failed.append(name)
    return failed


class WrapperDepthText(unittest.TestCase):
    def test_cases(self):
        limit = _depth_limit(GATE)
        for name, command, want, must, must_not in build_cases(limit):
            with self.subTest(name):
                code, err = run_gate(GATE, command)
                self.assertEqual(code, want, f"exit code; stderr={err!r}")
                for m in must:
                    self.assertIn(m, err)
                for m in must_not:
                    self.assertNotIn(m, err)

    def test_depth_limit_is_eight_so_the_boundary_cases_mean_what_they_say(self):
        # If _HEAD_DEPTH moves, the case names stay true (they are built from it), but a
        # silent change of the bound deserves a visible test failure to look at.
        self.assertEqual(_depth_limit(GATE), 8)

    def test_deny_text_is_plain_ascii_without_dashes(self):
        _, err = run_gate(GATE, "nohup " * (_depth_limit(GATE) + 1) + "git status")
        self.assertTrue(err.strip())
        err.encode("ascii")  # raises on any non-ASCII character
        self.assertNotIn("—", err)
        self.assertNotIn("–", err)

    def test_unit_wrapper_depth_hit(self):
        g = _load(GATE)
        n = g._HEAD_DEPTH
        self.assertTrue(g.wrapper_depth_hit("nohup " * (n + 1) + "git status"))
        self.assertFalse(g.wrapper_depth_hit("nohup " * n + "git status"))
        self.assertFalse(g.wrapper_depth_hit("sendmail x"))
        self.assertFalse(g.wrapper_depth_hit("sendmail x; " + "sudo " * (n + 1) + "true"))
        self.assertFalse(g.wrapper_depth_hit("echo 'unterminated"))  # parse error: not a depth hit

    def test_verdict_unchanged_is_send_invocation(self):
        g = _load(GATE)
        n = g._HEAD_DEPTH
        self.assertTrue(g.is_send_invocation("nohup " * (n + 1) + "git status"))
        self.assertFalse(g.is_send_invocation("nohup " * n + "git status"))


# ----------------------------------------------------------------- mutation check
# (name, old text, new text) applied to a copy of the gate source. Each must apply
# (the old text must occur exactly once) and each must be caught by evaluate().
_GUARD = 'if tool == "Bash" and not unreadable and _depth_limit_is_sole_reason(cmd):'
_VISIBLE_SEND = ("    return any(h is None for h in heads) and not any(\n"
                 "        h is not None and _head_is_send(h, 0) for h in heads)")
MUTANTS = [
    ("always the depth text (any empty/unreadable Bash deny)", _GUARD, 'if tool == "Bash":'),
    ("never the depth text", _GUARD, 'if False and tool == "Bash":'),
    ("depth text even when a reason is unreadable",
     _GUARD, 'if tool == "Bash" and _depth_limit_is_sole_reason(cmd):'),
    ("heredoc send ignored by the sole-reason check",
     "return wrapper_depth_hit(cmd) and not _heredoc_program_sends(cmd)",
     "return wrapper_depth_hit(cmd)"),
    ("a visible send beside the deep wrapper ignored", _VISIBLE_SEND,
     "    return any(h is None for h in heads)"),
]


class MutationCheck(unittest.TestCase):
    def setUp(self):
        # The gate loads scripts/lib/mixed_script.py from <gate dir>/../lib: mirror that.
        self.root = tempfile.mkdtemp(prefix="wrapper-depth-mutant-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        lib = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(GATE))), "lib")
        shutil.copytree(lib, os.path.join(self.root, "lib"))
        os.makedirs(os.path.join(self.root, "hk"))
        with open(GATE, encoding="utf-8") as fh:
            self.source = fh.read()

    def _mutant_path(self, idx: int, old: str, new: str) -> str:
        self.assertEqual(self.source.count(old), 1, f"mutation anchor not found exactly once: {old[:60]!r}")
        path = os.path.join(self.root, "hk", f"mutant{idx}.py")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.source.replace(old, new))
        return path

    def test_unmutated_gate_passes_everything(self):
        self.assertEqual(evaluate(GATE), [])

    def test_every_mutant_is_caught(self):
        for idx, (name, old, new) in enumerate(MUTANTS):
            with self.subTest(name):
                failed = evaluate(self._mutant_path(idx, old, new))
                self.assertTrue(failed, f"mutant survived: {name}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
