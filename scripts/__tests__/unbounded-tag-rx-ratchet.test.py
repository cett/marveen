#!/usr/bin/env python3
"""Ratchet: no new unbounded tag pattern under scripts/hooks/ or src/.

A pattern like `[^>]*>` (a run of "anything but '>'" with no upper bound, closed by a '>') or a lazy body
closed by a tag (`(.*?)</x>`, `[\\s\\S]*?</x>`) searches the rest of the text again from EVERY opener that has
no closer. On text made of openers and no closer that is quadratic: 550 kB held a hook or the event loop for
~85 s. For a gate a hook that runs into its timeout is not a deny, so a slow classifier is a fail-open.

The linear shape (an opener pattern, then one forward str.find / indexOf for the '>' and the closer, see
scrubSecurityTags in src/prompt-safety.ts) has none of these patterns. This test fails on a NEW one.

Two lists below, with a reason on every line:
  ALLOWED  a flagged line that stays: bounded input (the reason says what bounds it), or a known open item.
           A path plus a distinctive substring of the line; the substring must still match something, so
           an entry whose line was fixed or removed has to be deleted here (the list only shrinks).

The scanner reads the files under scripts/hooks/ and src/ only. This file is outside both, so it does not
check itself, and its own patterns below are not findings.
Run: python3 <thisfile>   Exit 0 = all pass.
"""
import os
import re
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SCAN_DIRS = ("scripts/hooks", "src")
SCAN_EXTS = (".py", ".sh", ".mjs", ".js", ".ts")
SKIP_PARTS = ("__tests__", "migrations", "generated", "node_modules")

# A negated-class run up to a '>' with no upper bound: `[^>]*`, `[^>]+`.
RUN_TO_GT = re.compile(r"\[\^>\][*+]")
# A lazy body closed by a closing tag: `.*?</`, `(.*?)</`, `[\s\S]*?</`, `[\s\S]*?<\/`.
LAZY_TO_CLOSER = re.compile(r"(?:\.\*\?|\[\\s\\S\]\*\?)\)?<\\?/")

COMMENT_PREFIXES = ("#", "//", "*", "/*")

# (path, a distinctive substring of the flagged line, reason)
ALLOWED = [
    ("src/web/message-router.ts", "(<channel[^>]*>)[\\s\\S]*?(<\\/channel>)",
     "pending the next window: facade-modified file, fixed there in its facade form (open item)"),
    ("src/web/federation/poller.ts", "const CHANNEL_TAG_RX",
     "pending the next window: facade-modified file, fixed there in its facade form (open item). "
     "The input is a federated peer's summary text, so this one is NOT bounded by us"),
    ("src/pane-state.ts", "flat.match(/<channel\\s+source=\"plugin:",
     "bounded: the text is the live input box of a `tmux capture-pane -p` snapshot, the visible screen "
     "only (rows x columns), about 1 ms for a full screen of openers"),
    ("src/channel-coordinator.ts", "text.replace(/<\\s*\\/?\\s*channel\\b[^>]*>/gi",
     "bounded: one chat message of a channel event (Telegram 4096 characters, about 1 ms for a message of "
     "openers); measured 0.1 s at 40 000 characters"),
    ("src/security/secret-gate.ts", "export const WRAPPER_TAG",
     "commit-time scan of the committer's own staged files, no hook timeout: a hostile file only slows the "
     "commit, nothing is let through"),
    ("src/web/routes/static.ts", "/(<script\\b[^>]*\\ssrc=\")\\/app\\.js(\")/",
     "bounded: the input is the repo's own web/index.html, never external text"),
]


def is_comment(stripped):
    return stripped.startswith(COMMENT_PREFIXES)


def flagged_lines(text):
    """[(line_number, line)] for every non-comment line holding an unbounded tag pattern."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or is_comment(s):
            continue
        if RUN_TO_GT.search(s) or LAZY_TO_CLOSER.search(s):
            out.append((n, s))
    return out


def scan(root):
    """{relative path: [(line_number, line)]} for every flagged file under the scan dirs of `root`."""
    found = {}
    for d in SCAN_DIRS:
        base = os.path.join(root, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in SKIP_PARTS]
            for name in filenames:
                if not name.endswith(SCAN_EXTS) or name.endswith((".d.ts", ".test.ts")):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    with open(path, encoding="utf-8") as fh:
                        hits = flagged_lines(fh.read())
                except (OSError, UnicodeDecodeError):
                    continue
                if hits:
                    found[os.path.relpath(path, root).replace(os.sep, "/")] = hits
    return found


def judge(found, allowed):
    """-> (new findings [(path, n, line)], stale allowlist entries [(path, substring)])."""
    new = []
    used = set()
    for path, hits in sorted(found.items()):
        for n, line in hits:
            for i, (apath, needle, _reason) in enumerate(allowed):
                if apath == path and needle in line:
                    used.add(i)
                    break
            else:
                new.append((path, n, line))
    stale = [(p, s) for i, (p, s, _r) in enumerate(allowed) if i not in used]
    return new, stale


class DetectorTest(unittest.TestCase):
    def hit(self, line):
        return bool(flagged_lines(line))

    def test_run_to_gt_forms(self):
        for line in (
            'rx = re.compile(r"<channel\\s+([^>]*)>")',
            "const RX = /<channel\\b[^>]*>/g",
            'TAG = re.compile(r"<[^>]+>")',
            "x.replace(/<a [^>]+>/g, '')",
        ):
            with self.subTest(line=line):
                self.assertTrue(self.hit(line))

    def test_lazy_body_to_closer_forms(self):
        for line in (
            "r'<(a|b)\\b([^\"]*)\">(.*?)</\\1>'",
            "const RX = /<x>([\\s\\S]*?)<\\/x>/g",
            "s.replace(/<script[\\s\\S]*?<\\/script>/gi, '')",
            "re.compile(r'<channel>.*?</channel>')",
        ):
            with self.subTest(line=line):
                self.assertTrue(self.hit(line))

    def test_bounded_and_unrelated_patterns_pass(self):
        for line in (
            "rx = /<channel\\b[^>]{0,2000}>/",
            "rx = /<channel\\b/g",
            "a = re.compile(r'\\[[^\\]]*\\]')",
            "const q = /[^>]/",
            "x = re.compile(r'\\s*(.*?)\\s*$')",
            "",
        ):
            with self.subTest(line=line):
                self.assertFalse(self.hit(line))

    def test_comment_lines_are_not_findings(self):
        for line in (
            "# the old `[^>]*>` span was quadratic",
            "// the old [^>]*> span was quadratic",
            " * a lazy (.*?)</x> body",
            "/* [^>]+> */",
        ):
            with self.subTest(line=line):
                self.assertFalse(self.hit(line))


class JudgeTest(unittest.TestCase):
    def tree(self, files):
        root = tempfile.mkdtemp(prefix="tagrx-")
        for rel, text in files.items():
            path = os.path.join(root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
        return root

    def test_a_new_pattern_in_a_hook_is_a_finding(self):
        root = self.tree({"scripts/hooks/new-hook.py": 'RX = re.compile(r"<channel\\s+([^>]*)>")\n'})
        new, stale = judge(scan(root), [])
        self.assertEqual([(p, n) for p, n, _ in new], [("scripts/hooks/new-hook.py", 1)])
        self.assertEqual(stale, [])

    def test_a_new_pattern_in_src_is_a_finding(self):
        root = self.tree({"src/web/new-route.ts": "const RX = /<x>([\\s\\S]*?)<\\/x>/g\n"})
        new, _ = judge(scan(root), [])
        self.assertEqual([p for p, _, _ in new], ["src/web/new-route.ts"])

    def test_tests_generated_and_migrations_are_not_scanned(self):
        root = self.tree({
            "src/__tests__/a.test.ts": "const RX = /<a[^>]*>/\n",
            "src/generated/api.ts": "const RX = /<a[^>]*>/\n",
            "src/migrations/0001.ts": "const RX = /<a[^>]*>/\n",
            "src/types.d.ts": "const RX = /<a[^>]*>/\n",
            "scripts/hooks/notes.md": "RX = <a[^>]*>\n",
        })
        self.assertEqual(scan(root), {})

    def test_an_allowed_line_passes_and_a_different_line_in_the_same_file_does_not(self):
        root = self.tree({
            "src/x.ts": "const A = /<a[^>]*>/\nconst B = /<b[^>]*>/\n",
        })
        allowed = [("src/x.ts", "const A", "bounded input")]
        new, stale = judge(scan(root), allowed)
        self.assertEqual([(p, n) for p, n, _ in new], [("src/x.ts", 2)])
        self.assertEqual(stale, [])

    def test_an_allowlist_entry_that_no_longer_matches_is_stale(self):
        root = self.tree({"src/x.ts": "const A = 1\n"})
        new, stale = judge(scan(root), [("src/x.ts", "const A", "bounded input")])
        self.assertEqual(new, [])
        self.assertEqual(stale, [("src/x.ts", "const A")])

    def test_every_allowlist_entry_has_a_reason(self):
        for path, needle, reason in ALLOWED:
            self.assertTrue(needle.strip(), path)
            self.assertGreater(len(reason.strip()), 20, "%s: %s" % (path, needle))


class RepoTest(unittest.TestCase):
    def test_no_new_unbounded_tag_pattern_in_the_repo(self):
        new, _ = judge(scan(ROOT), ALLOWED)
        self.assertEqual(
            new, [],
            "unbounded tag pattern(s); use an opener pattern plus one forward find (see scrubSecurityTags), or "
            "add the line to ALLOWED with the reason it is bounded:\n"
            + "\n".join("  %s:%d  %s" % f for f in new),
        )

    def test_the_allowlist_has_no_stale_entries(self):
        _, stale = judge(scan(ROOT), ALLOWED)
        self.assertEqual(stale, [], "fixed or removed: delete these ALLOWED entries")


if __name__ == "__main__":
    unittest.main()
