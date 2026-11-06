#!/usr/bin/env python3
"""Tests for scripts/readme-fork-diff-check.py (README fork-diff freshness gate).

Every case builds a throwaway git repository in a temp dir, with commit dates
pinned through GIT_AUTHOR_DATE / GIT_COMMITTER_DATE (including HEAD's), so the
age arithmetic is deterministic and never depends on the wall clock. The dates
are in 2020 on purpose: a gate that read the wall clock instead of HEAD's
commit date would see an enormous age and fail the "fresh" cases.

The script under test can be swapped with README_FORK_DIFF_CHECK_SCRIPT, which
is how the mutation sweep points this suite at a mutated copy.
"""
import datetime
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.environ.get("README_FORK_DIFF_CHECK_SCRIPT") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "readme-fork-diff-check.py",
)

# Thresholds written out literally (the script's named constants are 10 / 21 /
# 1): if someone moves a threshold, this suite has to be edited on purpose.
WARN_DAYS = 10
FAIL_DAYS = 21

FORK_DATE = datetime.date(2020, 3, 1)
UPSTREAM_SHA = "cb190127"  # never exists in the fixture: the gate only checks its shape

GIT_ENV = dict(
    os.environ,
    GIT_CONFIG_GLOBAL=os.devnull,
    GIT_CONFIG_NOSYSTEM="1",
    GIT_AUTHOR_NAME="t",
    GIT_AUTHOR_EMAIL="t@example.invalid",
    GIT_COMMITTER_NAME="t",
    GIT_COMMITTER_EMAIL="t@example.invalid",
)


def iso(date):
    return "%sT12:00:00+0000" % date.isoformat()


class Fixture:
    """A temp git repo plus a README written next to it (not committed)."""

    def __init__(self, test):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        self.repo = os.path.join(self.dir.name, "repo")
        os.mkdir(self.repo)
        self.readme = os.path.join(self.dir.name, "README.md")
        self.git("init", "-q", "-b", "main")

    def git(self, *args, date=None, cwd=None):
        env = dict(GIT_ENV)
        if date is not None:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = iso(date)
        proc = subprocess.run(
            ["git"] + list(args), cwd=cwd or self.repo, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
        )
        return proc.stdout.decode().strip()

    def commit(self, date, message="c"):
        self.git("commit", "-q", "--allow-empty", "-m", message, date=date)
        return self.git("rev-parse", "HEAD")

    def write_readme(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        with open(self.readme, "wb") as handle:
            handle.write(data)

    def run(self, extra=None, repo=None, readme=None):
        cmd = [sys.executable, SCRIPT, "--readme", readme or self.readme, "--repo", repo or self.repo]
        proc = subprocess.run(cmd + (extra or []), env=GIT_ENV, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=60)
        return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


def status_line(fork_sha, date, upstream=UPSTREAM_SHA, quoted=False):
    return "%sÁllapot: upstream `%s` vs fork `%s`, %s" % ("> " if quoted else "", upstream, fork_sha, date)


def readme_text(fork_sha, date, upstream=UPSTREAM_SHA, eol="\n"):
    """The real README shape: the quoted line first, the plain one second."""
    lines = [
        "# Title",
        "> Fork note.",
        ">",
        status_line(fork_sha, date, upstream, quoted=True),
        "",
        "## Section",
        "",
        status_line(fork_sha, date, upstream),
        "",
        "<!-- ONGOING: refresh both lines -->",
    ]
    return eol.join(lines) + eol


class Base(unittest.TestCase):
    def fixture(self, head_offset_days=0, fork_date=FORK_DATE):
        """base commit, the fork commit (fork_date), then HEAD (fork_date + offset)."""
        fx = Fixture(self)
        fx.commit(fork_date - datetime.timedelta(days=2), "base")
        fx.fork_sha = fx.commit(fork_date, "fork")
        fx.head_sha = fx.commit(fork_date + datetime.timedelta(days=head_offset_days), "head")
        fx.short = fx.fork_sha[:8]
        return fx

    def passing(self, fx, text=None, date=None):
        fx.write_readme(text if text is not None else readme_text(fx.short, date or FORK_DATE.isoformat()))

    def assertPass(self, result, warning=False):
        rc, out, err = result
        self.assertEqual(rc, 0, "stdout=%r stderr=%r" % (out, err))
        self.assertNotIn("::error", out)
        if warning:
            self.assertIn("::warning title=README fork-diff::", out)
        else:
            self.assertNotIn("::warning", out)
        return out

    def assertFail(self, result, check, snippet):
        rc, out, err = result
        self.assertEqual(rc, 1, "stdout=%r stderr=%r" % (out, err))
        self.assertIn("::error title=README fork-diff::%s: " % check, out)
        self.assertIn(snippet, out)
        self.assertNotIn("Traceback", err)
        return out


class TestAge(Base):
    def test_fresh_passes_quietly(self):
        fx = self.fixture(0)
        self.passing(fx)
        self.assertPass(fx.run())

    def test_ten_days_is_quiet(self):
        fx = self.fixture(WARN_DAYS)
        self.passing(fx)
        self.assertPass(fx.run())

    def test_eleven_days_warns_but_passes(self):
        fx = self.fixture(WARN_DAYS + 1)
        self.passing(fx)
        out = self.assertPass(fx.run(), warning=True)
        self.assertIn("%d days old" % (WARN_DAYS + 1), out)

    def test_twenty_one_days_still_only_warns(self):
        fx = self.fixture(FAIL_DAYS)
        self.passing(fx)
        self.assertPass(fx.run(), warning=True)

    def test_twenty_two_days_fails(self):
        fx = self.fixture(FAIL_DAYS + 1)
        self.passing(fx)
        out = self.assertFail(fx.run(), "G4", "%d days old" % (FAIL_DAYS + 1))
        self.assertIn("ONGOING", out)

    def test_age_uses_head_commit_date_not_the_wall_clock(self):
        # 2020 dates: the wall clock is years later, so a wall-clock gate fails here.
        fx = self.fixture(3)
        self.passing(fx)
        self.assertPass(fx.run())

    def test_head_older_than_status_date_is_not_an_error(self):
        fx = self.fixture(-1)  # HEAD one day before the fork commit's date
        self.passing(fx)
        self.assertPass(fx.run())


class TestStatusLines(Base):
    def test_zero_status_lines_fail(self):
        fx = self.fixture()
        self.passing(fx, text="# Title\n\nno status here\n")
        self.assertFail(fx.run(), "G1", "found 0")

    def test_one_status_line_fails(self):
        fx = self.fixture()
        self.passing(fx, text=status_line(fx.short, FORK_DATE.isoformat(), quoted=True) + "\n")
        self.assertFail(fx.run(), "G1", "found 1")

    def test_three_status_lines_fail(self):
        fx = self.fixture()
        text = readme_text(fx.short, FORK_DATE.isoformat()) + status_line(fx.short, FORK_DATE.isoformat()) + "\n"
        self.passing(fx, text=text)
        self.assertFail(fx.run(), "G1", "found 3")

    def test_the_two_lines_must_agree_on_the_fork_sha(self):
        fx = self.fixture()
        other = "0" * 8 if not fx.short.startswith("0") else "1" * 8
        text = "\n".join([
            status_line(fx.short, FORK_DATE.isoformat(), quoted=True),
            status_line(other, FORK_DATE.isoformat()),
        ]) + "\n"
        self.passing(fx, text=text)
        self.assertFail(fx.run(), "G1", "differ")

    def test_the_two_lines_must_agree_on_the_upstream_sha(self):
        fx = self.fixture()
        text = "\n".join([
            status_line(fx.short, FORK_DATE.isoformat(), upstream="cb190127", quoted=True),
            status_line(fx.short, FORK_DATE.isoformat(), upstream="cb190128"),
        ]) + "\n"
        self.passing(fx, text=text)
        self.assertFail(fx.run(), "G1", "differ")

    def test_the_two_lines_must_agree_on_the_date(self):
        fx = self.fixture()
        text = "\n".join([
            status_line(fx.short, FORK_DATE.isoformat(), quoted=True),
            status_line(fx.short, (FORK_DATE + datetime.timedelta(days=1)).isoformat()),
        ]) + "\n"
        self.passing(fx, text=text)
        self.assertFail(fx.run(), "G1", "differ")

    def test_non_hex_sha_is_a_format_error(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text("zzzzzzzz", FORK_DATE.isoformat()))
        self.assertFail(fx.run(), "G1", "do not match the required shape")

    def test_six_digit_sha_is_a_format_error(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.fork_sha[:6], FORK_DATE.isoformat()))
        self.assertFail(fx.run(), "G1", "do not match the required shape")

    def test_uppercase_sha_is_a_format_error(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.short.upper() + "F", FORK_DATE.isoformat()))
        self.assertFail(fx.run(), "G1", "do not match the required shape")

    def test_forty_one_digit_sha_is_a_format_error(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.fork_sha + "a", FORK_DATE.isoformat()))
        self.assertFail(fx.run(), "G1", "do not match the required shape")

    def test_non_ascii_digits_in_the_date_are_a_format_error(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.short, "٢٠٢٠-٠٣-٠١"))
        self.assertFail(fx.run(), "G1", "do not match the required shape")

    def test_non_calendar_date_fails(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.short, "2020-13-40"))
        self.assertFail(fx.run(), "G1", "not a calendar date")

    def test_malformed_line_message_does_not_echo_readme_content(self):
        fx = self.fixture()
        evil = "Állapot: ::error title=x::injected"
        self.passing(fx, text=readme_text(fx.short, FORK_DATE.isoformat()) + evil + "\n")
        rc, out, _ = fx.run()
        self.assertEqual(rc, 1)
        self.assertNotIn("injected", out)

    def test_quoted_and_unquoted_forms_mixed_is_the_normal_shape(self):
        fx = self.fixture()
        self.passing(fx)
        self.assertPass(fx.run())

    def test_both_lines_quoted_passes(self):
        fx = self.fixture()
        text = "\n".join([status_line(fx.short, FORK_DATE.isoformat(), quoted=True)] * 2) + "\n"
        self.passing(fx, text=text)
        self.assertPass(fx.run())

    def test_both_lines_unquoted_passes(self):
        fx = self.fixture()
        text = "\n".join([status_line(fx.short, FORK_DATE.isoformat())] * 2) + "\n"
        self.passing(fx, text=text)
        self.assertPass(fx.run())

    def test_seven_and_forty_digit_shas_are_accepted(self):
        fx = self.fixture()
        text = "\n".join([
            status_line(fx.fork_sha[:7], FORK_DATE.isoformat(), upstream="a" * 40, quoted=True),
            status_line(fx.fork_sha[:7], FORK_DATE.isoformat(), upstream="a" * 40),
        ]) + "\n"
        self.passing(fx, text=text)
        self.assertPass(fx.run())
        text = "\n".join([status_line(fx.fork_sha, FORK_DATE.isoformat(), quoted=True),
                          status_line(fx.fork_sha, FORK_DATE.isoformat())]) + "\n"
        self.passing(fx, text=text)
        self.assertPass(fx.run())

    def test_crlf_line_endings_work(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.short, FORK_DATE.isoformat(), eol="\r\n"))
        self.assertPass(fx.run())

    def test_utf8_bom_is_tolerated(self):
        fx = self.fixture()
        fx.write_readme(b"\xef\xbb\xbf" + readme_text(fx.short, FORK_DATE.isoformat()).encode("utf-8"))
        self.assertPass(fx.run())

    def test_status_line_as_very_first_line_after_bom(self):
        fx = self.fixture()
        text = status_line(fx.short, FORK_DATE.isoformat(), quoted=True) + "\n" + status_line(fx.short, FORK_DATE.isoformat()) + "\n"
        fx.write_readme(b"\xef\xbb\xbf" + text.encode("utf-8"))
        self.assertPass(fx.run())

    def test_missing_readme_fails_cleanly(self):
        fx = self.fixture()
        self.assertFail(fx.run(readme=os.path.join(fx.dir.name, "nope.md")), "G1", "cannot read the README")

    def test_oversized_readme_is_refused(self):
        fx = self.fixture()
        fx.write_readme(b"x" * (1024 * 1024 + 1))
        self.assertFail(fx.run(), "G1", "larger than")

    def test_hostile_long_line_stays_linear(self):
        fx = self.fixture()
        junk = "Állapot: upstream `" + "a" * 200000 + " " * 200000 + "x"
        self.passing(fx, text=readme_text(fx.short, FORK_DATE.isoformat()) + junk + "\n")
        rc, out, _ = fx.run()  # the subprocess timeout (60 s) is the linearity bound
        self.assertEqual(rc, 1)
        self.assertIn("G1", out)


class TestForkSha(Base):
    def test_unknown_sha_fails(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text("deadbeef", FORK_DATE.isoformat()))
        self.assertFail(fx.run(), "G2", "not a commit in this repository")

    def test_side_branch_sha_is_not_an_ancestor(self):
        fx = Fixture(self)
        fx.commit(FORK_DATE - datetime.timedelta(days=2), "base")
        fx.git("checkout", "-q", "-b", "side")
        side = fx.commit(FORK_DATE, "side")
        fx.git("checkout", "-q", "main")
        fx.commit(FORK_DATE, "main work")
        self.passing(fx, text=readme_text(side[:8], FORK_DATE.isoformat()))
        self.assertFail(fx.run(), "G2", "not an ancestor of HEAD")

    def test_shallow_clone_gets_a_clear_error_not_a_false_green(self):
        fx = self.fixture()
        self.passing(fx)
        clone = os.path.join(fx.dir.name, "shallow")
        fx.git("clone", "-q", "--depth", "1", "file://" + fx.repo, clone, cwd=fx.dir.name)
        out = self.assertFail(fx.run(repo=clone), "G2", "fetch-depth: 0")
        self.assertIn("shallow", out)

    def test_upstream_sha_is_format_checked_only(self):
        fx = self.fixture()
        self.passing(fx, text=readme_text(fx.short, FORK_DATE.isoformat(), upstream="1234567"))
        self.assertPass(fx.run())

    def test_not_a_git_repo_fails_cleanly(self):
        fx = self.fixture()
        self.passing(fx)
        plain = os.path.join(fx.dir.name, "plain")
        os.mkdir(plain)
        self.assertFail(fx.run(repo=plain), "G2", "not a git repository")


class TestDateMatchesSha(Base):
    def at(self, delta):
        fx = self.fixture(delta if delta > 0 else 0)
        self.passing(fx, date=(FORK_DATE + datetime.timedelta(days=delta)).isoformat())
        return fx

    def test_plus_one_day_is_tolerated(self):
        self.assertPass(self.at(1).run())

    def test_minus_one_day_is_tolerated(self):
        self.assertPass(self.at(-1).run())

    def test_plus_two_days_fails(self):
        out = self.assertFail(self.at(2).run(), "G3", "not the commit date of fork SHA")
        self.assertIn("moved forward", out)

    def test_minus_two_days_fails(self):
        self.assertFail(self.at(-2).run(), "G3", "not the commit date of fork SHA")

    def test_plus_three_days_fails(self):
        self.assertFail(self.at(3).run(), "G3", "not the commit date of fork SHA")


class TestMergeInfo(Base):
    def merge_fixture(self, head_offset_days=0):
        fx = Fixture(self)
        fx.commit(FORK_DATE - datetime.timedelta(days=2), "base")
        fork = fx.commit(FORK_DATE, "fork")
        fx.git("checkout", "-q", "-b", "feat")
        fx.commit(FORK_DATE, "feat work")
        fx.git("checkout", "-q", "main")
        fx.commit(FORK_DATE, "main work")
        fx.git("merge", "-q", "--no-ff", "-m", "Merge pull request #7 from a/feat", "feat", date=FORK_DATE)
        # an ordinary (non-merge) commit that only QUOTES the phrase must not be counted
        fx.commit(FORK_DATE, "Revert: Merge pull request #3 was a mistake")
        fx.git("checkout", "-q", "-b", "other", "HEAD~1")
        fx.commit(FORK_DATE, "other work")
        fx.git("checkout", "-q", "main")
        fx.git("merge", "-q", "--no-ff", "-m", "Merge branch 'other'", "other",
               date=FORK_DATE + datetime.timedelta(days=head_offset_days))
        fx.short = fork[:8]
        return fx

    def test_counts_pull_request_merges_only(self):
        fx = self.merge_fixture()
        self.passing(fx)
        out = self.assertPass(fx.run())
        self.assertIn("1 pull request merges since fork SHA", out)

    def test_info_line_is_printed_even_when_the_gate_fails(self):
        fx = self.merge_fixture(FAIL_DAYS + 1)
        self.passing(fx)
        out = self.assertFail(fx.run(), "G4", "days old")
        self.assertIn("1 pull request merges since fork SHA", out)

    def test_info_line_is_printed_with_a_warning(self):
        fx = self.merge_fixture(WARN_DAYS + 1)
        self.passing(fx)
        out = self.assertPass(fx.run(), warning=True)
        self.assertIn("pull request merges since fork SHA", out)


class TestCli(Base):
    def test_defaults_read_readme_md_in_the_repo(self):
        fx = self.fixture()
        with open(os.path.join(fx.repo, "README.md"), "w", encoding="utf-8") as handle:
            handle.write(readme_text(fx.short, FORK_DATE.isoformat()))
        proc = subprocess.run([sys.executable, SCRIPT, "--repo", fx.repo], env=GIT_ENV,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stdout.decode() + proc.stderr.decode())

    def test_defaults_work_from_the_repo_root(self):
        fx = self.fixture()
        with open(os.path.join(fx.repo, "README.md"), "w", encoding="utf-8") as handle:
            handle.write(readme_text(fx.short, FORK_DATE.isoformat()))
        proc = subprocess.run([sys.executable, SCRIPT], cwd=fx.repo, env=GIT_ENV,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stdout.decode() + proc.stderr.decode())


if __name__ == "__main__":
    unittest.main()
