#!/usr/bin/env python3
"""Ratchet: no hook rewrites a tool's input, and no PreToolUse hook allows a call.

The rule: a PreToolUse hook may only DENY a call (permissionDecision "deny", or exit code 2) or add context.
It may not rewrite the call's arguments, and it may not allow, ask or defer.

Why it is a rule and not only a habit. The one place where an approval is bound to arguments is the outgoing
mail: scripts/hooks/email-approval-gate.py claims an approval for the sha256 of the mail it reads from the call's
input, and for the Bash route the sender (scripts/gmail-send.py) claims again for the hash the SERVER computes.
For the MCP route the gate's hash is the only binding there is: the MCP server does not check it again. If
a second PreToolUse hook rewrote the input of that same call, the mail that goes out could differ from the mail
that was approved, and nothing would notice. No hook does that today (checked: nothing in the hook scripts, the
gates or src uses the input-rewrite key, and no PreToolUse output allows), so the exposure is latent; this test is
what keeps it that way. The same direction the OpenClaw 2026.10.5 release took ("ordinary hooks can no longer
rewrite trusted approved tool arguments without another approval"): we have no inline approval to protect, we
have the email hash, and the rule is the cheap way to protect it.

A new finding fails the test. If a rewrite or an allow is really needed, it must come with a re-check of the
email hash at the point of effect (the sender claims for the hash it computed itself), and the allowlist
below gets a reviewed entry with the reason. `updatedToolOutput` (it replaces a tool RESULT, not the input) is
allowed only in the files listed.

Run: python3 scripts/__tests__/hook-input-rewrite.test.py
"""
import os
import re
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# What is scanned: every hook script, every *gate* script next to them, the TypeScript sources (a hook output is
# built in a script, but a server-side helper that formats one would belong here too) and any hooks.json.
SCAN_DIRS = ["scripts/hooks", "scripts", "src"]
SCAN_EXT = {".py", ".mjs", ".js", ".cjs", ".ts", ".sh", ".json"}
SKIP_DIRS = {"__tests__", "node_modules", "dist", "generated", "lib"}

# reviewed exceptions: repo-relative path -> the rule ids it may trigger, with the reason
ALLOW = {
    "scripts/hooks/browser-content-notice.py": {
        "updated-tool-output": "wraps a browser tool's RESULT in an untrusted-content envelope; the input is untouched",
    },
}

RULES = [
    ("input-rewrite", re.compile(r"updated_?[Ii]nput")),
    ("updated-tool-output", re.compile(r"updated_?[Tt]ool_?[Oo]utput")),
    # permissionDecision set to anything but the literal "deny" (allow / ask / defer / a variable that could be any)
    ("pretooluse-not-deny", re.compile(r"""permissionDecision['"]?\s*[:=]\s*(?!['"]deny['"])\S""")),
]

RULE_TEXT = (
    "A PreToolUse hook may only deny a call or add context; it may not rewrite the input or allow/ask/defer. "
    "If it really must, the email approval hash has to be re-checked at the point of effect (the sender claims "
    "for the hash it computed itself) and this test's ALLOW table gets a reviewed entry with the reason."
)


def iter_files(root):
    seen = set()
    for d in SCAN_DIRS:
        base = os.path.join(root, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS]
            if d == "scripts" and os.path.abspath(dirpath) == os.path.abspath(base):
                # top level of scripts/: only the gates (the rest of scripts/ is not hook code)
                names = [n for n in filenames if "gate" in n or n == "hooks.json"]
                dirnames[:] = [x for x in dirnames if x == "hooks"]
            else:
                names = filenames
            for n in names:
                if os.path.splitext(n)[1] not in SCAN_EXT:
                    continue
                p = os.path.join(dirpath, n)
                if p not in seen:
                    seen.add(p)
                    yield p


def scan_text(text):
    """The rule ids a piece of source triggers."""
    return {rid for rid, rx in RULES if rx.search(text)}


def scan_tree(root, allow=ALLOW):
    """(relative path, rule id) for every finding that is not in the allowlist."""
    findings = []
    for p in iter_files(root):
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        for rid in sorted(scan_text(text)):
            if rid in allow.get(rel, {}):
                continue
            findings.append((rel, rid))
    return findings


class TestHookInputRewriteRatchet(unittest.TestCase):
    def test_no_hook_in_the_repo_rewrites_input_or_allows(self):
        findings = scan_tree(ROOT)
        self.assertEqual(
            findings, [],
            "hook rule violated by %s.\n%s" % (", ".join("%s (%s)" % f for f in findings), RULE_TEXT),
        )

    def test_the_scan_reaches_the_hook_scripts(self):
        # a scanner that finds no files would pass forever
        files = [os.path.relpath(p, ROOT).replace(os.sep, "/") for p in iter_files(ROOT)]
        for expected in ("scripts/hooks/destructive-gate.py", "scripts/hooks/email-approval-gate.py",
                         "scripts/hooks/egress-gate.mjs", "scripts/email-send-gate.mjs", "scripts/self-pace-gate.mjs"):
            self.assertIn(expected, files)

    def test_the_allowlist_entries_are_still_needed(self):
        # a stale exception is a hole waiting to be reused
        for rel, rules in ALLOW.items():
            path = os.path.join(ROOT, rel)
            self.assertTrue(os.path.isfile(path), "%s is on the allowlist but does not exist" % rel)
            with open(path, encoding="utf-8") as fh:
                triggered = scan_text(fh.read())
            for rid in rules:
                self.assertIn(rid, triggered, "%s no longer triggers %s: remove it from ALLOW" % (rel, rid))

    # --- the scanner itself: each rule must fail on a synthetic hook (the mutation check) ---

    def test_rewrite_key_is_caught_in_python_and_js(self):
        self.assertIn("input-rewrite", scan_text('print(json.dumps({"hookSpecificOutput": {"updatedInput": {"to": "x"}}}))'))
        self.assertIn("input-rewrite", scan_text("out.hookSpecificOutput.updated_input = fixed"))
        self.assertIn("input-rewrite", scan_text("return { hookSpecificOutput: { updatedInput } }"))

    def test_allow_ask_defer_and_a_variable_are_caught(self):
        for src in (
            'out = {"hookSpecificOutput": {"permissionDecision": "allow"}}',
            "{ permissionDecision: 'allow' }",
            "{ permissionDecision: 'ask' }",
            '"permissionDecision": "defer"',
            "permissionDecision = decision",
            "{ permissionDecision: verdict, permissionDecisionReason: r }",
        ):
            self.assertIn("pretooluse-not-deny", scan_text(src), src)

    def test_deny_and_the_reason_key_are_not_findings(self):
        for src in (
            "{ permissionDecision: 'deny', permissionDecisionReason: reason }",
            '"permissionDecision": "deny"',
            "permissionDecision: \"deny\"",
        ):
            self.assertNotIn("pretooluse-not-deny", scan_text(src), src)

    def test_output_replacement_is_its_own_rule(self):
        self.assertIn("updated-tool-output", scan_text('hook_output["updatedToolOutput"] = replacement'))

    def test_a_synthetic_hook_file_fails_the_tree_scan(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "scripts", "hooks"))
            with open(os.path.join(root, "scripts", "hooks", "rewrite-gate.py"), "w") as fh:
                fh.write('print({"hookSpecificOutput": {"updatedInput": {"command": "x"}}})\n')
            with open(os.path.join(root, "scripts", "hooks", "ok-gate.py"), "w") as fh:
                fh.write('print({"hookSpecificOutput": {"permissionDecision": "deny"}})\n')
            self.assertEqual(scan_tree(root, allow={}), [("scripts/hooks/rewrite-gate.py", "input-rewrite")])
            # and an allowlist entry for exactly that file and rule lets it through
            self.assertEqual(scan_tree(root, allow={"scripts/hooks/rewrite-gate.py": {"input-rewrite": "reviewed"}}), [])

    def test_an_allowlisted_file_is_not_a_free_pass_for_other_rules(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "scripts", "hooks"))
            with open(os.path.join(root, "scripts", "hooks", "browser-content-notice.py"), "w") as fh:
                fh.write('x["updatedToolOutput"] = r\ny = {"permissionDecision": "allow"}\n')
            found = scan_tree(root, allow=ALLOW)
            self.assertEqual(found, [("scripts/hooks/browser-content-notice.py", "pretooluse-not-deny")])


if __name__ == "__main__":
    unittest.main()
