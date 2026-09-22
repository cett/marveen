#!/usr/bin/env python3
"""CI gate: catch internal kanban-rowid leaks in commit subjects/bodies.

A manual pre-push checklist ("no bare #NNN in a commit subject") repeatedly
failed to catch this in practice -- a checklist that keeps slipping is a
missing gate, not an attention problem. This script is the machine
replacement, run once per PR against every commit in the PR's range.

Why this is NOT a simple "GET the fork API, 404 = fail" check: this repo is
a FORK (cett/marveen) of Szotasz/marveen. A bare `#NNN` in a commit subject
is ambiguous by construction -- it could be a real fork issue, a real
upstream issue/PR (upstream has 1000+, so nearly any 2-4 digit number
resolves to SOMETHING there -- existence alone proves nothing), or an
internal kanban card's rowid/seq (looks identical, resolves nowhere).
Distinguishing "legit upstream ref" from "rowid leak" by comparing the
upstream issue's title to the commit's content requires editorial judgment
a script cannot make reliably.

So the gate encodes a convention instead of trying to replicate that
judgment: a bare `#NNN` must resolve on THIS fork -- if you mean the
upstream repo, say so explicitly with the literal words "upstream #NNN".
That phrasing is exempted from the fork-existence check (verified against
upstream instead, existence only, never title-matched) instead of being
rejected outright.
"""
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

FORK_REPO = "cett/marveen"
UPSTREAM_REPO = "Szotasz/marveen"

# Whole-line skip patterns: lines a #NNN token can never be a leak candidate
# on, by construction. Merge-commit subjects are GitHub-generated (always a
# real PR). Co-Authored-By lines never carry a #NNN token in the first place.
#
# Closes/Fixes/Refs/Resolves/See/Part of trailers are deliberately NOT
# skipped: skipping the whole line would let a kanban rowid hide behind the
# trailer keyword ("Closes #1234" bypassing the check entirely). Their #NNN
# is validated the same way as a bare one below -- a real issue/PR reference
# still passes ("Closes #451" is fine), only an unresolved rowid fails.
SKIP_LINE_RE = re.compile(
    r"^\s*(Merge (pull request|branch)\b|Co-Authored-By\b)",
    re.IGNORECASE,
)

# An explicit "upstream #NNN" reference -- the convention this gate enforces
# in place of a bare, ambiguous #NNN. Word boundary before "upstream" so it
# doesn't match mid-word.
UPSTREAM_REF_RE = re.compile(r"\bupstream\s+#(\d{2,4})\b", re.IGNORECASE)

# Any remaining bare #NNN candidate (2-4 digits, matching kanban seq / GitHub
# issue number range in this repo).
CANDIDATE_RE = re.compile(r"#(\d{2,4})\b")


def commit_messages(base_sha):
    """Subject+body of every commit in base_sha..HEAD, one string per commit."""
    out = subprocess.run(
        ["git", "log", f"{base_sha}..HEAD", "--format=%s%n%b%x00"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [msg for msg in out.split("\x00") if msg.strip()]


def candidates_in_message(msg):
    """Yield (number, is_upstream_ref) for every #NNN token worth checking,
    skipping whole lines that match SKIP_LINE_RE and upstream-ref numbers
    (returned separately, tagged, rather than dropped)."""
    seen = set()
    for line in msg.splitlines():
        if SKIP_LINE_RE.match(line):
            continue
        upstream_nums = {int(n) for n in UPSTREAM_REF_RE.findall(line)}
        for n in upstream_nums:
            if n not in seen:
                seen.add(n)
                yield n, True
        for m in CANDIDATE_RE.finditer(line):
            n = int(m.group(1))
            if n in upstream_nums or n in seen:
                continue
            seen.add(n)
            yield n, False


def check_issue(repo, number, token):
    """Returns 'exists', 'missing', or 'error' (rate-limit/network/5xx --
    never treated as a failure, since it isn't evidence of anything)."""
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/issues/{number}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "marveen-ci-commit-subject-gate",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            return "exists"
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "missing"
        return "error"
    except Exception:
        return "error"


def main():
    base_sha = os.environ.get("BASE_SHA")
    token = os.environ.get("GITHUB_TOKEN")
    if not base_sha or not token:
        print("check_commit_subjects: BASE_SHA or GITHUB_TOKEN not set, skipping (not a PR context?).")
        return 0

    failures = []
    warnings = []
    checked = {}  # (repo, number) -> result, avoid duplicate API calls across commits

    for msg in commit_messages(base_sha):
        subject = msg.splitlines()[0] if msg.splitlines() else msg
        for number, is_upstream_ref in candidates_in_message(msg):
            repo = UPSTREAM_REPO if is_upstream_ref else FORK_REPO
            key = (repo, number)
            if key not in checked:
                checked[key] = check_issue(repo, number, token)
            result = checked[key]

            if result == "error":
                warnings.append(
                    f"  WARNING #{number} ({'upstream' if is_upstream_ref else 'fork'}): "
                    f"GitHub API error, skipped -- \"{subject}\""
                )
            elif result == "missing":
                if is_upstream_ref:
                    failures.append(
                        f"  #{number} marked \"upstream #{number}\" but it does not exist "
                        f"in {UPSTREAM_REPO} -- \"{subject}\""
                    )
                else:
                    failures.append(
                        f"  #{number} does not exist in {FORK_REPO} -- looks like an internal "
                        f"kanban rowid, not a GitHub reference -- \"{subject}\"\n"
                        f"    If this really means an upstream issue, write it as "
                        f"\"upstream #{number}\" instead of a bare \"#{number}\"."
                    )
            # "exists" -> fine, no output.

    if warnings:
        print("check_commit_subjects: non-blocking API warnings:")
        print("\n".join(warnings))

    if failures:
        print("check_commit_subjects: commit subject/body #NNN references that don't resolve:")
        print("\n".join(failures))
        print(
            "\nA bare #NNN in a commit subject/body must resolve to a real issue/PR in "
            f"{FORK_REPO}. If it's an internal kanban card number, drop the # entirely "
            "(e.g. \"coverage step 5\" not \"#1234 step 5\"). If it's a real upstream "
            f"reference, write \"upstream #NNN\" explicitly."
        )
        return 1

    print("check_commit_subjects: OK, no unresolved #NNN references.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
