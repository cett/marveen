"""
Tests for generate-changelog.mjs and release-notes.mjs.

Hermetic: all git and file operations use temp dirs.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GEN_SCRIPT = REPO_ROOT / 'scripts' / 'generate-changelog.mjs'
NOTES_SCRIPT = REPO_ROOT / 'scripts' / 'release-notes.mjs'


def run_node(script: Path, *args, cwd=None, env=None) -> subprocess.CompletedProcess:
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(
        ['node', str(script), *args],
        cwd=cwd, env=full_env,
        capture_output=True, text=True
    )


class GitRepo:
    """Minimal in-process git repo fixture."""

    def __init__(self, tmp: Path):
        self.root = tmp
        self._git('init', '-b', 'main')
        self._git('config', 'user.email', 'test@example.com')
        self._git('config', 'user.name', 'Test')
        # Minimal package.json so the script can read it on --release
        (tmp / 'package.json').write_text(json.dumps({'version': '1.0.0'}))
        self._git('add', '.')
        self._git('commit', '-m', 'chore: init')

    def _git(self, *args):
        subprocess.run(['git', *args], cwd=self.root, capture_output=True, check=True)

    def commit(self, msg: str):
        # Create a dummy file change so there is something to commit.
        dummy = self.root / f'.dummy-{len(list(self.root.glob(".dummy*")))}'
        dummy.write_text(msg)
        self._git('add', str(dummy))
        self._git('commit', '-m', msg)

    def tag(self, name: str):
        self._git('tag', name)


class TestParseConventionalCommit(unittest.TestCase):
    """Unit tests for the parsing logic via the generator output."""

    def _gen(self, repo: GitRepo, **env) -> subprocess.CompletedProcess:
        return run_node(GEN_SCRIPT, cwd=repo.root, env=env)

    def test_feat_goes_to_added(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(auth): add OAuth2 login')
            r = self._gen(repo)
            self.assertEqual(r.returncode, 0, r.stderr)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('### Added', cl)
            self.assertIn('add OAuth2 login', cl)

    def test_fix_goes_to_fixed(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('fix(db): null pointer on empty result')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('### Fixed', cl)
            self.assertIn('null pointer on empty result', cl)

    def test_api_scope_gets_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(api): add /v1/memories endpoint')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('**[API]**', cl)

    def test_non_api_scope_no_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('fix(ui): button color wrong')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertNotIn('**[API]**', cl)

    def test_breaking_gets_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(api)!: remove legacy /v0/ routes')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('**BREAKING**', cl)

    def test_openapi_scope_gets_api_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(openapi): add operationId to all endpoints')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('**[API]**', cl)

    def test_release_commits_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('chore(release): v1.5.0')
            repo.commit('feat(cache): add LRU eviction')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertNotIn('v1.5.0', cl)
            self.assertIn('add LRU eviction', cl)

    def test_docs_goes_to_documentation(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('docs(api): update endpoint examples')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('### Documentation', cl)

    def test_non_conventional_commit_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('update stuff and things')
            r = self._gen(repo)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertNotIn('update stuff and things', cl)


class TestUnreleasedIdempotency(unittest.TestCase):

    def test_running_twice_does_not_duplicate_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): first feature')
            run_node(GEN_SCRIPT, cwd=repo.root)
            run_node(GEN_SCRIPT, cwd=repo.root)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertEqual(cl.count('first feature'), 1)

    def test_new_commit_appended_to_unreleased(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): alpha')
            run_node(GEN_SCRIPT, cwd=repo.root)
            repo.commit('fix(y): beta')
            run_node(GEN_SCRIPT, cwd=repo.root)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('alpha', cl)
            self.assertIn('beta', cl)


class TestIncrementalMarker(unittest.TestCase):
    """Marker-based incremental append (#739) -- hand-written [Unreleased]
    content must survive repeated runs untouched."""

    def _marker_sha(self, cl: str) -> str:
        m = re.search(r'<!-- changelog-auto-sha: ([0-9a-f]+) -->', cl)
        self.assertIsNotNone(m, 'expected a changelog-auto-sha marker in output')
        return m.group(1)

    def test_first_run_stamps_marker_at_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): first feature')
            run_node(GEN_SCRIPT, cwd=repo.root)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            head = subprocess.run(
                ['git', 'rev-parse', 'HEAD'], cwd=repo.root,
                capture_output=True, text=True, check=True
            ).stdout.strip()
            self.assertEqual(self._marker_sha(cl), head)

    def test_hand_edit_survives_next_incremental_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): first feature')
            run_node(GEN_SCRIPT, cwd=repo.root)

            # Simulate a human/agent enriching the auto-generated entry by hand.
            cl_path = repo.root / 'CHANGELOG.md'
            cl = cl_path.read_text()
            enriched = cl.replace(
                '- first feature',
                '- first feature -- with hand-written rationale that a subject line could never capture'
            )
            self.assertNotEqual(cl, enriched)
            cl_path.write_text(enriched)

            repo.commit('fix(y): second fix')
            r = run_node(GEN_SCRIPT, cwd=repo.root)
            self.assertEqual(r.returncode, 0, r.stderr)

            cl2 = cl_path.read_text()
            self.assertIn('hand-written rationale that a subject line could never capture', cl2)
            self.assertIn('second fix', cl2)

    def test_running_incrementally_does_not_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): alpha')
            run_node(GEN_SCRIPT, cwd=repo.root)
            run_node(GEN_SCRIPT, cwd=repo.root)  # no new commits -- should be a no-op append
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertEqual(cl.count('alpha'), 1)
            self.assertEqual(cl.count('changelog-auto-sha'), 1)

    def test_bootstrap_leaves_preexisting_content_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            # Pre-existing [Unreleased] content with NO marker -- simulates the
            # real CHANGELOG.md the first time this script runs after the fix.
            seeded = (
                '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n'
                '- hand-curated entry with rich detail that must not be touched\n\n'
                '## [1.0.0] - 2026-01-01\n\n### Added\n\n- old stuff\n'
            )
            (repo.root / 'CHANGELOG.md').write_text(seeded)
            repo.commit('fix(z): a commit made before the bootstrap run')
            r = run_node(GEN_SCRIPT, cwd=repo.root)
            self.assertEqual(r.returncode, 0, r.stderr)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('hand-curated entry with rich detail that must not be touched', cl)
            self.assertIn('changelog-auto-sha', cl)
            # Bootstrap only stamps the marker; it does not also try to guess
            # which commits are already represented in the hand-written text.
            self.assertNotIn('a commit made before the bootstrap run', cl)

            # The commit made *after* bootstrapping must still show up normally.
            repo.commit('fix(z): a commit made after the bootstrap run')
            run_node(GEN_SCRIPT, cwd=repo.root)
            cl2 = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('a commit made after the bootstrap run', cl2)
            self.assertIn('hand-curated entry with rich detail that must not be touched', cl2)

    def test_unresolvable_marker_falls_back_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): alpha')
            run_node(GEN_SCRIPT, cwd=repo.root)

            # Corrupt the marker to a SHA that can never resolve in this repo.
            cl_path = repo.root / 'CHANGELOG.md'
            corrupted = re.sub(
                r'changelog-auto-sha: [0-9a-f]+',
                'changelog-auto-sha: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                cl_path.read_text()
            )
            cl_path.write_text(corrupted)

            repo.commit('fix(y): beta')
            r = run_node(GEN_SCRIPT, cwd=repo.root)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('falling back', r.stderr.lower())
            cl = cl_path.read_text()
            self.assertIn('alpha', cl)
            self.assertIn('beta', cl)

    def test_release_strips_marker_from_promoted_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): nice feature')
            run_node(GEN_SCRIPT, cwd=repo.root)
            run_node(GEN_SCRIPT, '--release', '1.1.0', cwd=repo.root)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('nice feature', cl)

            # [Unreleased] comes first and keeps its own fresh marker; the
            # promoted [1.1.0] section (after it) must not carry one.
            idx_unreleased = cl.index('## [Unreleased]')
            idx_version = cl.index('## [1.1.0]')
            self.assertLess(idx_unreleased, idx_version)
            version_section = cl[idx_version:]
            self.assertNotIn('changelog-auto-sha', version_section)


class TestReleaseCut(unittest.TestCase):

    def test_release_promotes_unreleased(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): nice feature')
            run_node(GEN_SCRIPT, cwd=repo.root)
            r = run_node(GEN_SCRIPT, '--release', '1.1.0', cwd=repo.root)
            self.assertEqual(r.returncode, 0, r.stderr)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            self.assertIn('## [1.1.0]', cl)
            self.assertIn('nice feature', cl)
            # [Unreleased] must still exist and be empty
            self.assertIn('## [Unreleased]', cl)

    def test_release_updates_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            repo.commit('feat(x): bump time')
            run_node(GEN_SCRIPT, cwd=repo.root)
            run_node(GEN_SCRIPT, '--release', '2.0.0', cwd=repo.root)
            pkg = json.loads((repo.root / 'package.json').read_text())
            self.assertEqual(pkg['version'], '2.0.0')

    def test_release_invalid_version_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            r = run_node(GEN_SCRIPT, '--release', 'not-a-version', cwd=repo.root)
            self.assertNotEqual(r.returncode, 0)

    def test_release_version_appears_before_older_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            # Seed CHANGELOG with an older version
            (repo.root / 'CHANGELOG.md').write_text(
                '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- old stuff\n'
            )
            repo.commit('feat(x): new thing')
            run_node(GEN_SCRIPT, cwd=repo.root)
            run_node(GEN_SCRIPT, '--release', '1.1.0', cwd=repo.root)
            cl = (repo.root / 'CHANGELOG.md').read_text()
            pos_new = cl.index('## [1.1.0]')
            pos_old = cl.index('## [1.0.0]')
            self.assertLess(pos_new, pos_old)


class TestReleaseNotes(unittest.TestCase):

    def _setup(self, tmp: Path) -> GitRepo:
        repo = GitRepo(Path(tmp))
        repo.commit('feat(x): cool thing')
        run_node(GEN_SCRIPT, cwd=repo.root)
        run_node(GEN_SCRIPT, '--release', '1.2.0', cwd=repo.root)
        return repo

    def test_extracts_version_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._setup(Path(tmp))
            r = run_node(NOTES_SCRIPT, '1.2.0', cwd=repo.root)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('cool thing', r.stdout)

    def test_extracts_unreleased(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._setup(Path(tmp))
            repo.commit('fix(z): post-release patch')
            run_node(GEN_SCRIPT, cwd=repo.root)
            r = run_node(NOTES_SCRIPT, 'Unreleased', cwd=repo.root)
            self.assertEqual(r.returncode, 0)
            self.assertIn('post-release patch', r.stdout)

    def test_unknown_version_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._setup(Path(tmp))
            r = run_node(NOTES_SCRIPT, '99.0.0', cwd=repo.root)
            self.assertNotEqual(r.returncode, 0)

    def test_missing_version_arg_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = GitRepo(Path(tmp))
            r = run_node(NOTES_SCRIPT, cwd=repo.root)
            self.assertNotEqual(r.returncode, 0)

    def test_output_excludes_section_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._setup(Path(tmp))
            r = run_node(NOTES_SCRIPT, '1.2.0', cwd=repo.root)
            # Should NOT include the ## [1.2.0] header line itself
            self.assertNotIn('## [1.2.0]', r.stdout)


if __name__ == '__main__':
    unittest.main()
