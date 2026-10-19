#!/usr/bin/env python3
"""Gmail send-route ratchet: the Gmail REST send routes may be named in exactly the files listed in ALLOWED.

The email send gate (scripts/hooks/email-approval-gate.py) sees the command a tool call runs, not what a program
does inside. A program that calls the Gmail REST send route itself is therefore a way to mail anyone without an
approval. This repository keeps that surface to a fixed, reviewed list:

  scripts/gmail-send.py          the official sender: bound to one owner approval, the one path for any outside mail
  scripts/send-digest-email.py   the documented exception: it can only mail the token account's OWN mailbox
                                 (enforced in code: assert_self_addressed(), see SECURITY.md)
  scripts/lib/email_extract.py   recognition only (the gate reads a curl call to the route); it sends nothing

A third file that contains `messages/send` or `drafts/send` (code, a shell script, a skill or a template that tells
an agent to curl the route) fails this check until it is added to ALLOWED below, with a reason, in a reviewed
change. Documentation (CHANGELOG, SECURITY, docs/) and tests are not scanned.

Honest limit: this is a text check. A route assembled from pieces at run time, or a script that is not in the
repository, is not seen (SECURITY.md lists it: an agent that reads the OAuth token file can write its own sender).

Usage:
    python3 scripts/gmail-send-route-ratchet.py [--root DIR]

Exit codes: 0 ok, 1 an unlisted file names a send route, 2 usage / IO error.
"""
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

ALLOWED = {
    "scripts/gmail-send.py": "the official sender, bound to one owner approval",
    "scripts/send-digest-email.py": "documented exception: mails only the token account's own mailbox (assert_self_addressed)",
    "scripts/lib/email_extract.py": "recognition of the route in a curl call for the gate; sends nothing",
}

ROUTE = re.compile(r"(?:messages|drafts)/send")

# Not scanned: documentation that names the route, tests and fixtures, generated and vendored trees, this check itself.
SKIP_DIR_NAMES = {".git", "node_modules", "dist", "__tests__", "generated", "store", "coverage"}
SKIP_PREFIXES = ("docs/",)
SKIP_FILES = {"CHANGELOG.md", "SECURITY.md", "README.md", "scripts/gmail-send-route-ratchet.py"}
MAX_BYTES = 2 * 1024 * 1024


def _tracked(root):
    """Repo-relative paths: `git ls-files` inside a repository, else a walk (a temp tree in the tests)."""
    if os.path.isdir(os.path.join(root, ".git")) or os.path.isfile(os.path.join(root, ".git")):
        try:
            out = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
            return [p for p in out.decode("utf-8", "replace").split("\0") if p]
        except (OSError, subprocess.SubprocessError):
            pass
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES]
        for name in filenames:
            found.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/"))
    return found


def _skipped(rel):
    parts = rel.split("/")
    return (rel in SKIP_FILES or rel.startswith(SKIP_PREFIXES) or any(p in SKIP_DIR_NAMES for p in parts[:-1]))


def scan(root):
    """Returns (offenders, stale): files naming a send route that are not allowed, and allowed files that no longer do."""
    hits = set()
    for rel in _tracked(root):
        if _skipped(rel):
            continue
        path = os.path.join(root, rel)
        try:
            if not os.path.isfile(path) or os.path.getsize(path) > MAX_BYTES:
                continue
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            continue
        if b"\0" in data[:4096]:
            continue
        if ROUTE.search(data.decode("utf-8", "replace")):
            hits.add(rel)
    return sorted(hits - set(ALLOWED)), sorted(a for a in ALLOWED if a not in hits)


def main(argv):
    root = REPO_ROOT
    if argv and argv[0] == "--root" and len(argv) == 2:
        root = os.path.abspath(argv[1])
    elif argv:
        sys.stderr.write(__doc__.split("Usage:")[1].split("Exit codes")[0])
        return 2
    if not os.path.isdir(root):
        sys.stderr.write("gmail-send-route-ratchet: %s is not a directory\n" % root)
        return 2
    offenders, stale = scan(root)
    for rel in stale:
        print("note: %s no longer names a Gmail send route; drop it from ALLOWED" % rel)
    if offenders:
        for rel in offenders:
            print("FAIL: %s names a Gmail send route (messages/send or drafts/send) and is not in ALLOWED" % rel)
        print("A new sender needs a reviewed entry in scripts/gmail-send-route-ratchet.py ALLOWED, with a reason; "
              "outside mail goes through scripts/gmail-send.py (the approval gate).")
        return 1
    print("OK gmail-send-route ratchet (%d allowed files, none added)" % len(ALLOWED))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
