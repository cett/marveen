#!/usr/bin/env python3
"""Unit tests for scripts/hooks/agent_token.py (Phase T3 token resolution).

Privacy: only neutral fixture data (agent ids a/b, made-up token strings), temp directories.
"""
import importlib.util
import os
import shutil
import stat
import sys
import tempfile
import unittest

_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "agent_token.py",
)
_spec = importlib.util.spec_from_file_location("agent_token", _PATH)
at = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(at)  # type: ignore[union-attr]


class Base(unittest.TestCase):
    def setUp(self):
        self.install = tempfile.mkdtemp(prefix="t3-install-")
        os.makedirs(os.path.join(self.install, "store"))
        os.makedirs(os.path.join(self.install, "agents", "a"))
        self._env = {k: os.environ.get(k) for k in ("MAIN_AGENT_ID", "MARVEEN_AGENT_TOKEN_FILE", "MARVEEN_AGENT_ID", "CLAUDE_CONFIG_DIR")}
        os.environ["MAIN_AGENT_ID"] = "m"
        for k in ("MARVEEN_AGENT_TOKEN_FILE", "MARVEEN_AGENT_ID", "CLAUDE_CONFIG_DIR"):
            os.environ.pop(k, None)

    def tearDown(self):
        shutil.rmtree(self.install, ignore_errors=True)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def put(self, rel, text):
        p = os.path.join(self.install, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)
        return p

    def res(self, **kw):
        return at.resolve(install=self.install, **kw)


class TestIdentityFromTheLaunch(Base):
    """A working directory that names nobody (a worktree, a scratch directory) must not turn the
    caller anonymous: the environment the session was launched with names it."""

    def setUp(self):
        super().setUp()
        self.put("agents/a/.agent-token", "own-a")
        self.put(".agent-token", "own-m")
        self.put("store/.dashboard-token", "shared")
        self.scratch = tempfile.mkdtemp(prefix="t3-scratch-")
        self.addCleanup(shutil.rmtree, self.scratch, True)

    def test_a_scratch_cwd_alone_is_anonymous_and_has_no_token(self):
        r = self.res(cwd=self.scratch)
        self.assertEqual((r.token, r.source, r.agent_id), ("", at.SOURCE_NONE, None))
        self.assertNotIn("X-Agent-Id", r.headers())

    def test_config_dir_of_an_agent_names_it(self):
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, "agents", "a", ".claude-config")
        r = self.res(cwd=self.scratch)
        self.assertEqual((r.token, r.source, r.agent_id), ("own-a", at.SOURCE_AGENT, "a"))
        self.assertEqual(r.headers()["X-Agent-Id"], "a")

    def test_a_path_below_the_config_dir_and_a_trailing_slash_still_name_it(self):
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, "agents", "a", ".claude-config", "projects") + "/"
        self.assertEqual(self.res(cwd=self.scratch).agent_id, "a")

    def test_the_main_agents_channels_config_names_the_main_agent(self):
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, ".channels-config")
        r = self.res(cwd=self.scratch)
        self.assertEqual((r.token, r.source, r.agent_id), ("own-m", at.SOURCE_AGENT, "m"))

    def test_only_the_config_dir_of_THIS_install_counts(self):
        other = tempfile.mkdtemp(prefix="t3-other-")
        self.addCleanup(shutil.rmtree, other, True)
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(other, "agents", "a", ".claude-config")
        self.assertIsNone(self.res(cwd=self.scratch).agent_id)

    def test_an_agent_dir_that_is_not_a_config_dir_names_nobody(self):
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, "agents", "a", "notes")
        self.assertIsNone(self.res(cwd=self.scratch).agent_id)
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, "agents", "a")
        self.assertIsNone(self.res(cwd=self.scratch).agent_id)

    def test_the_marveen_agent_id_variable_wins_over_the_config_dir(self):
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, "agents", "a", ".claude-config")
        os.environ["MARVEEN_AGENT_ID"] = "m"
        self.assertEqual(self.res(cwd=self.scratch).agent_id, "m")

    def test_the_working_directory_still_wins_over_the_environment(self):
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.install, "agents", "a", ".claude-config")
        self.assertEqual(self.res(cwd=self.install).agent_id, "m")

    def test_an_explicit_agent_id_wins_over_everything(self):
        os.environ["MARVEEN_AGENT_ID"] = "m"
        self.assertEqual(self.res(agent_id="a", cwd=self.scratch).agent_id, "a")

    def test_a_path_like_agent_id_in_the_environment_is_ignored(self):
        os.environ["MARVEEN_AGENT_ID"] = "../x"
        r = self.res(cwd=self.scratch)
        self.assertEqual((r.agent_id, r.source), (None, at.SOURCE_NONE))


class TestResolution(Base):
    def test_own_token_wins_over_shared(self):
        self.put("agents/a/.agent-token", "own-a\n")
        self.put("store/.dashboard-token", "shared\n")
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("own-a", at.SOURCE_AGENT))

    def test_main_agent_token_lives_in_install_root(self):
        self.put(".agent-token", "own-m")
        self.put("store/.dashboard-token", "shared")
        r = self.res(agent_id="m")
        self.assertEqual((r.token, r.source), ("own-m", at.SOURCE_AGENT))

    def test_missing_own_token_is_none_with_the_fix_named_and_the_shared_token_untouched(self):
        self.put("store/.dashboard-token", "shared")
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("", at.SOURCE_NONE))
        self.assertIn("agent-tokens -- issue a", r.error)
        self.assertNotIn("shared", repr(r) + str(r.error))
        h = r.headers()
        self.assertNotIn("Authorization", h)  # no credential at all, and certainly not the shared one
        self.assertEqual(h["X-Agent-Id"], "a")

    def test_empty_own_token_file_is_a_miss_with_no_fallback(self):
        self.put("agents/a/.agent-token", "  \n")
        self.put("store/.dashboard-token", "shared")
        self.assertEqual(self.res(agent_id="a").source, at.SOURCE_NONE)

    def test_unreadable_own_token_is_a_miss(self):
        p = self.put("agents/a/.agent-token", "own-a")
        self.put("store/.dashboard-token", "shared")
        os.chmod(p, 0)
        try:
            if os.access(p, os.R_OK):  # running as root: the mode proves nothing
                self.skipTest("file still readable")
            self.assertEqual(self.res(agent_id="a").source, at.SOURCE_NONE)
        finally:
            os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)

    def test_nothing_readable_gives_no_authorization_header_and_never_raises(self):
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("", at.SOURCE_NONE))
        self.assertNotIn("Authorization", r.headers())

    def test_directory_where_a_token_file_should_be_does_not_raise(self):
        os.makedirs(os.path.join(self.install, "agents", "a", ".agent-token"))
        self.put("store/.dashboard-token", "shared")
        self.assertEqual(self.res(agent_id="a").source, at.SOURCE_NONE)

    def test_a_shared_token_in_any_store_dir_is_never_picked_up(self):
        other = tempfile.mkdtemp(prefix="t3-store-")
        try:
            with open(os.path.join(other, ".dashboard-token"), "w") as f:
                f.write("elsewhere")
            r = self.res(agent_id="a", store_dir=other)
            self.assertEqual((r.token, r.source), ("", at.SOURCE_NONE))
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_no_resolver_surface_exposes_the_shared_token(self):
        # The shared kind, the fallback source and the shared_file seam are gone; only the gate's
        # canary has a dedicated reader.
        for gone in ("KIND_SHARED", "SOURCE_FALLBACK", "SOURCE_SHARED", "SHARED_TOKEN_FILENAME"):
            self.assertFalse(hasattr(at, gone), gone)
        with self.assertRaises(TypeError):
            at.resolve(install=self.install, agent_id="a", shared_file="/x")
        self.put("store/.dashboard-token", "canary-value")
        self.assertEqual(at.canary_shared_token(store_dir=os.path.join(self.install, "store")), "canary-value")

    def test_env_token_file_overrides_the_agent_file(self):
        self.put("agents/a/.agent-token", "own-a")
        p = self.put("elsewhere/tok", "explicit")
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = p
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("explicit", at.SOURCE_AGENT))

    def test_env_token_file_missing_is_none_not_the_agent_file_and_not_shared(self):
        self.put("agents/a/.agent-token", "own-a")
        self.put("store/.dashboard-token", "shared")
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = os.path.join(self.install, "nope")
        self.assertEqual(self.res(agent_id="a").source, at.SOURCE_NONE)


class TestIdentity(Base):
    def test_cwd_inside_an_agent_dir_names_that_agent(self):
        cwd = os.path.join(self.install, "agents", "a", "sub")
        self.assertEqual(at.agent_id_from_cwd(cwd, self.install), "a")

    def test_install_root_is_the_main_agent(self):
        self.assertEqual(at.agent_id_from_cwd(self.install, self.install), "m")

    def test_unknown_cwd_is_not_an_identity(self):
        self.assertIsNone(at.agent_id_from_cwd("/some/scratch", self.install))

    def test_unknown_cwd_has_no_token_and_no_caller_header(self):
        self.put("store/.dashboard-token", "shared")
        r = self.res(cwd="/some/scratch")
        self.assertEqual(r.source, at.SOURCE_NONE)
        self.assertIn("MARVEEN_AGENT_ID", r.error)  # no identity: the error says how to give one
        self.assertNotIn("X-Agent-Id", r.headers())

    def test_cwd_drives_the_resolution(self):
        self.put("agents/a/.agent-token", "own-a")
        r = self.res(cwd=os.path.join(self.install, "agents", "a"))
        self.assertEqual((r.token, r.agent_id), ("own-a", "a"))

    def test_path_like_agent_ids_are_refused(self):
        self.put("store/.dashboard-token", "shared")
        for bad in ("../x", "a/b", ".hidden"):
            r = self.res(agent_id=bad)
            self.assertIsNone(r.agent_id, bad)
            self.assertEqual(r.source, at.SOURCE_NONE, bad)

    def test_main_agent_id_read_from_env_file(self):
        os.environ.pop("MAIN_AGENT_ID", None)
        self.put(".env", 'FOO=1\nMAIN_AGENT_ID="m2"\n')
        self.assertEqual(at.main_agent_id(self.install), "m2")


class TestNoLeak(Base):
    def test_repr_and_str_do_not_carry_the_token(self):
        self.put("agents/a/.agent-token", "super-secret-token")
        r = self.res(agent_id="a")
        self.assertNotIn("super-secret-token", repr(r))
        self.assertNotIn("super-secret-token", str(r))

    def test_headers_carry_the_bearer(self):
        self.put("agents/a/.agent-token", "own-a")
        h = at.auth_headers({"Content-Type": "application/json"}, agent_id="a", install=self.install)
        self.assertEqual(h["Authorization"], "Bearer own-a")
        self.assertEqual(h["Content-Type"], "application/json")


class TestKinds(Base):
    def test_admin_kind_is_the_main_agents_own_token_and_nothing_for_everyone_else(self):
        self.put(".agent-token", "own-m")
        self.put("agents/a/.agent-token", "own-a")
        self.put("store/.dashboard-token", "shared")
        m = self.res(agent_id="m", kind=at.KIND_ADMIN)
        self.assertEqual((m.token, m.source, m.error), ("own-m", at.SOURCE_AGENT, None))
        a = self.res(agent_id="a", kind=at.KIND_ADMIN)
        self.assertEqual((a.token, a.source), ("", at.SOURCE_NONE))  # not its own token, not the shared one
        self.assertEqual(a.error, at.ADMIN_ONLY_MESSAGE)
        self.assertIn("ask the main agent", a.error)
        self.assertNotIn("Authorization", a.headers())

    def test_admin_kind_with_no_identity_is_refused_too(self):
        self.put("store/.dashboard-token", "shared")
        r = self.res(cwd=self.install + "-nowhere", kind=at.KIND_ADMIN)
        self.assertEqual((r.token, r.source), ("", at.SOURCE_NONE))
        self.assertEqual(r.error, at.ADMIN_ONLY_MESSAGE)

    def test_main_kind_acts_as_the_main_agent_whoever_runs_it(self):
        self.put(".agent-token", "own-m")
        self.put("agents/a/.agent-token", "own-a")
        r = self.res(agent_id="a", kind=at.KIND_MAIN)
        self.assertEqual((r.token, r.source, r.agent_id), ("own-m", at.SOURCE_AGENT, "m"))
        # the main agent's own file gone: there is no shared fallback behind it any more
        self.put("store/.dashboard-token", "shared")
        os.remove(os.path.join(self.install, ".agent-token"))
        r = self.res(kind=at.KIND_MAIN)
        self.assertEqual((r.token, r.source, r.agent_id), ("", at.SOURCE_NONE, "m"))
        self.assertIn("agent-tokens -- issue m", r.error)

    def test_operator_kind_reads_the_operator_file_and_has_no_fallback(self):
        self.put("store/.dashboard-token", "shared")
        r = self.res(kind=at.KIND_OPERATOR)
        self.assertEqual((r.token, r.source), ("", at.SOURCE_NONE))
        self.assertIn("issue-operator", r.error)
        self.put("store/.operator-token", "op")
        r = self.res(kind=at.KIND_OPERATOR)
        self.assertEqual((r.token, r.source), ("op", at.SOURCE_OPERATOR))


if __name__ == "__main__":
    unittest.main()
