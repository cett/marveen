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
        self._env = {k: os.environ.get(k) for k in ("MAIN_AGENT_ID", "MARVEEN_AGENT_TOKEN_FILE")}
        os.environ["MAIN_AGENT_ID"] = "m"
        os.environ.pop("MARVEEN_AGENT_TOKEN_FILE", None)

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

    def test_missing_own_token_falls_back_to_shared_and_says_so(self):
        self.put("store/.dashboard-token", "shared")
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("shared", at.SOURCE_FALLBACK))
        # The fallback is distinguishable in the meter: it names the caller.
        self.assertEqual(r.headers()["X-Agent-Id"], "a")

    def test_empty_own_token_file_is_a_miss_not_an_empty_bearer(self):
        self.put("agents/a/.agent-token", "  \n")
        self.put("store/.dashboard-token", "shared")
        self.assertEqual(self.res(agent_id="a").source, at.SOURCE_FALLBACK)

    def test_unreadable_own_token_is_a_miss(self):
        p = self.put("agents/a/.agent-token", "own-a")
        self.put("store/.dashboard-token", "shared")
        os.chmod(p, 0)
        try:
            if os.access(p, os.R_OK):  # running as root: the mode proves nothing
                self.skipTest("file still readable")
            self.assertEqual(self.res(agent_id="a").source, at.SOURCE_FALLBACK)
        finally:
            os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)

    def test_nothing_readable_gives_no_authorization_header_and_never_raises(self):
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("", at.SOURCE_NONE))
        self.assertNotIn("Authorization", r.headers())

    def test_directory_where_a_token_file_should_be_does_not_raise(self):
        os.makedirs(os.path.join(self.install, "agents", "a", ".agent-token"))
        self.put("store/.dashboard-token", "shared")
        self.assertEqual(self.res(agent_id="a").source, at.SOURCE_FALLBACK)

    def test_store_dir_override_locates_the_shared_token(self):
        other = tempfile.mkdtemp(prefix="t3-store-")
        try:
            with open(os.path.join(other, ".dashboard-token"), "w") as f:
                f.write("elsewhere")
            r = self.res(agent_id="a", store_dir=other)
            self.assertEqual((r.token, r.source), ("elsewhere", at.SOURCE_FALLBACK))
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_env_token_file_overrides_the_agent_file(self):
        self.put("agents/a/.agent-token", "own-a")
        p = self.put("elsewhere/tok", "explicit")
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = p
        r = self.res(agent_id="a")
        self.assertEqual((r.token, r.source), ("explicit", at.SOURCE_AGENT))

    def test_env_token_file_missing_still_falls_back_instead_of_reading_the_agent_file(self):
        self.put("agents/a/.agent-token", "own-a")
        self.put("store/.dashboard-token", "shared")
        os.environ["MARVEEN_AGENT_TOKEN_FILE"] = os.path.join(self.install, "nope")
        self.assertEqual(self.res(agent_id="a").source, at.SOURCE_FALLBACK)


class TestIdentity(Base):
    def test_cwd_inside_an_agent_dir_names_that_agent(self):
        cwd = os.path.join(self.install, "agents", "a", "sub")
        self.assertEqual(at.agent_id_from_cwd(cwd, self.install), "a")

    def test_install_root_is_the_main_agent(self):
        self.assertEqual(at.agent_id_from_cwd(self.install, self.install), "m")

    def test_unknown_cwd_is_not_an_identity(self):
        self.assertIsNone(at.agent_id_from_cwd("/some/scratch", self.install))

    def test_unknown_cwd_gets_the_shared_token_without_a_caller_header(self):
        self.put("store/.dashboard-token", "shared")
        r = self.res(cwd="/some/scratch")
        self.assertEqual(r.source, at.SOURCE_FALLBACK)
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
            self.assertEqual(r.source, at.SOURCE_FALLBACK, bad)

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
    def test_shared_kind_uses_the_shared_token_even_with_an_own_token(self):
        self.put("agents/a/.agent-token", "own-a")
        self.put("store/.dashboard-token", "shared")
        r = self.res(agent_id="a", kind=at.KIND_SHARED)
        self.assertEqual((r.token, r.source), ("shared", at.SOURCE_SHARED))
        self.assertEqual(r.headers()["X-Agent-Id"], "a")

    def test_shared_kind_with_no_shared_token_is_none(self):
        self.put("agents/a/.agent-token", "own-a")
        self.assertEqual(self.res(agent_id="a", kind=at.KIND_SHARED).source, at.SOURCE_NONE)

    def test_operator_kind_reads_the_operator_file_and_falls_back(self):
        self.put("store/.dashboard-token", "shared")
        self.assertEqual(self.res(kind=at.KIND_OPERATOR).source, at.SOURCE_FALLBACK)
        self.put("store/.operator-token", "op")
        r = self.res(kind=at.KIND_OPERATOR)
        self.assertEqual((r.token, r.source), ("op", at.SOURCE_OPERATOR))


if __name__ == "__main__":
    unittest.main()
