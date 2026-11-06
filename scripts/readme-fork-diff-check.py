#!/usr/bin/env python3
"""CI gate: the README "Állapot:" (fork-diff status) lines must not go stale.

The README states how the fork relates to upstream in one status line that
stands in TWO places (the quoted one under the Fork note and the one at the
end of the fork-diff section):

    > Állapot: upstream `<sha>` vs fork `<sha>`, <YYYY-MM-DD>
      Állapot: upstream `<sha>` vs fork `<sha>`, <YYYY-MM-DD>

A manual "refresh the fork-diff every ~10 days" note kept slipping, so this
gate is the machine replacement. It checks only what a script can judge, and
never whether the README content is TRUE (that is a human sample):

  G1  exactly two status lines, both strictly formatted and identical
  G2  the fork SHA exists and is an ancestor of HEAD (the PR head); the
      upstream SHA is only format-checked (no `upstream` remote in CI)
  G3  the date is the commit date of the fork SHA, +-1 day (time zones)
  G4  age = (commit date of HEAD) - (status date): more than WARN_DAYS is a
      `::warning`, more than FAIL_DAYS fails the run. HEAD's commit date is
      used, never the wall clock, so the check is deterministic.

Always prints an info line: how many pull request merges happened since the
fork SHA. Standard library only; the README is read with a size cap, matched
line by line with anchored patterns (linear), and nothing from it is ever
passed to a shell or echoed back (only validated hex/date values are), so a
hostile README can neither stall the gate nor inject workflow commands.

Exit code: 0 = pass (warnings allowed), 1 = a check failed.
"""
import argparse
import datetime
import os
import re
import subprocess
import sys

# Named thresholds (the test uses them): 10 days = quiet, 11 = warning,
# 21 = warning, 22 = failure.
WARN_DAYS = 10
FAIL_DAYS = 21
# Allowed distance between the status date and the fork SHA's commit date.
TOLERANCE_DAYS = 1
README_MAX_BYTES = 1024 * 1024
GIT_TIMEOUT_SECONDS = 30

# A line that LOOKS like a status line (loose), and the strict shape.
LOOSE_RE = re.compile(r"^(?:> )?Állapot:")
STATE_RE = re.compile(
    r"^(?:> )?Állapot: upstream `([0-9a-f]{7,40})` vs fork `([0-9a-f]{7,40})`, (\d{4}-\d{2}-\d{2})\s*$",
    re.ASCII,
)

ANNOTATION_TITLE = "README fork-diff"


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.infos = []

    def error(self, check, message):
        self.errors.append("%s: %s" % (check, message))

    def warning(self, message):
        self.warnings.append(message)

    def info(self, message):
        self.infos.append(message)

    def emit(self, out):
        for line in self.infos:
            out.write("%s\n" % line)
        for line in self.warnings:
            out.write("::warning title=%s::%s\n" % (ANNOTATION_TITLE, line))
        for line in self.errors:
            out.write("::error title=%s::%s\n" % (ANNOTATION_TITLE, line))


def git(repo, *args):
    """Run git in `repo` without a shell. Returns (returncode, stdout)."""
    try:
        proc = subprocess.run(
            ["git", "-C", repo] + list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""
    return proc.returncode, proc.stdout.decode("utf-8", "replace").strip()


def parse_date(text):
    try:
        year, month, day = (int(part) for part in text.split("-"))
        return datetime.date(year, month, day)
    except (ValueError, TypeError):
        return None


def read_readme(path, report):
    """Return the README text (BOM stripped) or None after reporting why not."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(README_MAX_BYTES + 1)
    except OSError:
        report.error("G1", "cannot read the README at the given path; pass --readme or run from the repo root")
        return None
    if len(raw) > README_MAX_BYTES:
        report.error("G1", "the README is larger than %d bytes; the gate refuses to scan it" % README_MAX_BYTES)
        return None
    return raw.decode("utf-8-sig", "replace")


def check_status_lines(text, report):
    """G1. Returns the (upstream_sha, fork_sha, date_text) triple, or None."""
    found = []
    bad_lines = []
    for number, line in enumerate(text.split("\n"), start=1):
        if not LOOSE_RE.match(line):
            continue
        match = STATE_RE.match(line)
        if match:
            found.append((number, match.groups()))
        else:
            bad_lines.append(number)
    if bad_lines:
        report.error(
            "G1",
            "README line(s) %s start with 'Állapot:' but do not match the required shape "
            "'Állapot: upstream `<sha>` vs fork `<sha>`, YYYY-MM-DD' (7-40 lowercase hex digits, "
            "single backticks); fix them, see the ONGOING comment in the README"
            % ", ".join(str(n) for n in bad_lines),
        )
        return None
    if len(found) != 2:
        report.error(
            "G1",
            "expected exactly 2 'Állapot:' lines (the quoted one under the Fork note and the one at the end "
            "of the fork-diff section), found %d; restore the missing or remove the extra line, "
            "see the ONGOING comment in the README" % len(found),
        )
        return None
    (first_line, first), (second_line, second) = found
    if first != second:
        report.error(
            "G1",
            "the two 'Állapot:' lines (README lines %d and %d) differ; update both the same way, "
            "see the ONGOING comment in the README" % (first_line, second_line),
        )
        return None
    return first


def validate_date(date_text, report):
    date = parse_date(date_text)
    if date is None:
        report.error("G1", "the status date %s is not a calendar date; use YYYY-MM-DD" % date_text)
    return date


def check_fork_sha(repo, fork_sha, report):
    """G2. Returns True when the fork SHA is a usable ancestor of HEAD."""
    code, shallow = git(repo, "rev-parse", "--is-shallow-repository")
    if code != 0:
        report.error("G2", "this is not a git repository (or git failed); run the gate inside a checkout")
        return False
    if shallow == "true":
        report.error(
            "G2",
            "the checkout is shallow, so the fork SHA cannot be verified; the CI checkout needs fetch-depth: 0",
        )
        return False
    code, _ = git(repo, "cat-file", "-e", "%s^{commit}" % fork_sha)
    if code != 0:
        report.error(
            "G2",
            "the fork SHA %s is not a commit in this repository (unknown or ambiguous); "
            "set it to `git rev-parse --short origin/develop`" % fork_sha,
        )
        return False
    code, _ = git(repo, "merge-base", "--is-ancestor", fork_sha, "HEAD")
    if code != 0:
        report.error(
            "G2",
            "the fork SHA %s is not an ancestor of HEAD; the status line must name a commit "
            "this branch contains (rebase onto origin/develop, then refresh the line)" % fork_sha,
        )
        return False
    return True


def commit_date(repo, ref):
    code, out = git(repo, "show", "-s", "--format=%cs", ref)
    if code != 0:
        return None
    return parse_date(out)


def check_date_matches_sha(repo, fork_sha, status_date, report):
    """G3."""
    sha_date = commit_date(repo, fork_sha)
    if sha_date is None:
        report.error("G3", "cannot read the commit date of the fork SHA %s" % fork_sha)
        return
    if abs((status_date - sha_date).days) > TOLERANCE_DAYS:
        report.error(
            "G3",
            "the status date %s is not the commit date of fork SHA %s (%s, +-%d day allowed); "
            "the date cannot be moved forward without moving the SHA"
            % (status_date.isoformat(), fork_sha, sha_date.isoformat(), TOLERANCE_DAYS),
        )


def check_age(repo, status_date, report):
    """G4."""
    head_date = commit_date(repo, "HEAD")
    if head_date is None:
        report.error("G4", "cannot read the commit date of HEAD")
        return
    age = (head_date - status_date).days
    if age > FAIL_DAYS:
        report.error(
            "G4",
            "the README fork-diff status is %d days old (limit %d); refresh the fork-diff section and "
            "both 'Állapot:' lines, see the ONGOING comment in the README" % (age, FAIL_DAYS),
        )
    elif age > WARN_DAYS:
        report.warning(
            "the README fork-diff status is %d days old (refresh it within %d days, it fails after %d); "
            "see the ONGOING comment in the README" % (age, FAIL_DAYS - age, FAIL_DAYS)
        )


def report_merges_since(repo, fork_sha, report):
    code, out = git(
        repo, "rev-list", "--count", "--merges", "--grep=Merge pull request", "%s..HEAD" % fork_sha
    )
    if code == 0 and out.isdigit():
        report.info("readme-fork-diff: %s pull request merges since fork SHA %s" % (out, fork_sha))


def run(readme_path, repo):
    report = Report()
    text = read_readme(readme_path, report)
    if text is None:
        return report
    state = check_status_lines(text, report)
    if state is None:
        return report
    _upstream_sha, fork_sha, date_text = state
    status_date = validate_date(date_text, report)
    if status_date is None:
        return report
    if check_fork_sha(repo, fork_sha, report):
        check_date_matches_sha(repo, fork_sha, status_date, report)
        report_merges_since(repo, fork_sha, report)
    check_age(repo, status_date, report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="README fork-diff freshness gate")
    parser.add_argument("--readme", default="README.md", help="README path (relative to --repo)")
    parser.add_argument("--repo", default=".", help="git checkout to verify against")
    args = parser.parse_args(argv)
    report = run(os.path.join(args.repo, args.readme), args.repo)
    report.emit(sys.stdout)
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
