#!/usr/bin/env python3
"""Unit tests for scripts/check_commit_subjects.py.

Covers the core distinction this gate exists for: a bare #NNN must resolve
on the FORK (cett/marveen); an explicit "upstream #NNN" is checked against
Szotasz/marveen instead; API errors (rate-limit/network/5xx) warn but never
fail the build; skip patterns (merge commits, Closes/Fixes/etc trailers)
are never checked at all.
"""
import importlib.util
import os
import sys
import unittest
import urllib.error
from unittest.mock import patch, MagicMock

_SCRIPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "check_commit_subjects.py",
)

_spec = importlib.util.spec_from_file_location("check_commit_subjects", _SCRIPT_PATH)
gate = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(gate)  # type: ignore[union-attr]


def _http_error(code):
    return urllib.error.HTTPError(url="x", code=code, msg="x", hdrs=None, fp=None)


class TestCandidatesInMessage(unittest.TestCase):
    def test_bare_hash_is_a_fork_candidate(self):
        cands = list(gate.candidates_in_message("test(coverage step 5): #8001 example module"))
        self.assertEqual(cands, [(8001, False)])

    def test_upstream_prefixed_is_tagged_upstream(self):
        cands = list(gate.candidates_in_message("docs: port fix from upstream #1357"))
        self.assertEqual(cands, [(1357, True)])

    def test_merge_commit_subject_skipped(self):
        msg = "Merge pull request #451 from cett/feat/example-fix"
        self.assertEqual(list(gate.candidates_in_message(msg)), [])

    def test_merge_branch_subject_skipped(self):
        msg = "Merge branch 'develop' into feat/foo (#500 context)"
        self.assertEqual(list(gate.candidates_in_message(msg)), [])

    def test_closes_trailer_line_skipped(self):
        msg = "fix(auth): resolve principal from auth gate\n\nCloses #8003"
        self.assertEqual(list(gate.candidates_in_message(msg)), [])

    def test_fixes_refs_resolves_see_partof_coauthor_all_skipped(self):
        msg = (
            "fix: x\n\n"
            "Fixes #100\nRefs #101\nResolves #102\nSee #103\nPart of #104\n"
            "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
        )
        self.assertEqual(list(gate.candidates_in_message(msg)), [])

    def test_no_duplicate_yield_same_number_same_message(self):
        msg = "fix(#8001): mention #8001 twice in the subject"
        self.assertEqual(list(gate.candidates_in_message(msg)), [(8001, False)])

    def test_upstream_number_not_also_yielded_as_bare(self):
        # "upstream #1357" should not ALSO produce a bare (1357, False) candidate.
        cands = list(gate.candidates_in_message("port upstream #1357 fix"))
        self.assertEqual(cands, [(1357, True)])


class TestCheckIssue(unittest.TestCase):
    def test_200_is_exists(self):
        cm = MagicMock()
        cm.__enter__.return_value = MagicMock()
        with patch.object(gate.urllib.request, "urlopen", return_value=cm):
            self.assertEqual(gate.check_issue("cett/marveen", 1, "tok"), "exists")

    def test_404_is_missing(self):
        with patch.object(gate.urllib.request, "urlopen", side_effect=_http_error(404)):
            self.assertEqual(gate.check_issue("cett/marveen", 8001, "tok"), "missing")

    def test_403_rate_limit_is_error_not_missing(self):
        with patch.object(gate.urllib.request, "urlopen", side_effect=_http_error(403)):
            self.assertEqual(gate.check_issue("cett/marveen", 1, "tok"), "error")

    def test_network_exception_is_error(self):
        with patch.object(gate.urllib.request, "urlopen", side_effect=OSError("boom")):
            self.assertEqual(gate.check_issue("cett/marveen", 1, "tok"), "error")


class TestMain(unittest.TestCase):
    def _run_main(self, env, log_lines, issue_results):
        """issue_results: dict[(repo, number)] -> 'exists'|'missing'|'error'."""
        with patch.dict(os.environ, env, clear=False):
            with patch.object(gate, "commit_messages", return_value=log_lines):
                with patch.object(
                    gate, "check_issue",
                    side_effect=lambda repo, n, tok: issue_results[(repo, n)],
                ):
                    return gate.main()

    def test_no_base_sha_or_token_skips_cleanly(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(gate.main(), 0)

    def test_real_fork_issue_passes(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["fix: real thing (#451)"],
            {("cett/marveen", 451): "exists"},
        )
        self.assertEqual(rc, 0)

    def test_fake_rowid_fails(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["test(#8001 step 5): example coverage"],
            {("cett/marveen", 8001): "missing"},
        )
        self.assertEqual(rc, 1)

    def test_api_error_warns_but_passes(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["fix: something (#8004)"],
            {("cett/marveen", 8004): "error"},
        )
        self.assertEqual(rc, 0)

    def test_explicit_upstream_ref_checked_against_upstream_repo(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["docs: port fix from upstream #1357"],
            {("Szotasz/marveen", 1357): "exists"},
        )
        self.assertEqual(rc, 0)

    def test_explicit_upstream_ref_missing_upstream_fails(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["docs: port fix from upstream #9999"],
            {("Szotasz/marveen", 9999): "missing"},
        )
        self.assertEqual(rc, 1)

    def test_merge_commit_never_checked(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["Merge pull request #451 from cett/feat/example-fix"],
            {},
        )
        self.assertEqual(rc, 0)

    def test_closes_trailer_never_checked(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            ["fix(security): resolve principal\n\nCloses #8003"],
            {},
        )
        self.assertEqual(rc, 0)

    def test_multiple_commits_mixed_pass_and_fail(self):
        rc = self._run_main(
            {"BASE_SHA": "abc", "GITHUB_TOKEN": "tok"},
            [
                "fix: real thing (#451)",
                "test(#8002 step 3): example coverage",
            ],
            {
                ("cett/marveen", 451): "exists",
                ("cett/marveen", 8002): "missing",
            },
        )
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
