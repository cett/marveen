#!/usr/bin/env python3
"""Unit tests for scripts/workspace-put.py.

The dashboard is never contacted: WORKSPACE_PUT_API_CMD points at a fake wrapper that records the
calls and serves a tiny in-memory document store. Fixture data is neutral (agent id "a").
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest

_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "workspace-put.py",
)
_spec = importlib.util.spec_from_file_location("workspace_put", _PATH)
wp = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(wp)  # type: ignore[union-attr]

FAKE_WRAPPER = """#!%(python)s
import json, os, sys
state = os.environ["FAKE_STATE"]
args = sys.argv[1:]
with open(os.path.join(state, "calls.log"), "a") as f:
    f.write(json.dumps(args) + "\\n")
mode = os.environ.get("FAKE_MODE", "ok")
method, path = args[args.index("--max-time") + 2], args[args.index("--max-time") + 3]
if mode == "http-fail":
    sys.stdout.write(json.dumps({"error": "boom"}))
    sys.stderr.write("agent-api: HTTP 500 (%%s %%s)\\n" %% (method, path))
    sys.exit(22)
if method == "POST":
    body = json.loads(sys.stdin.read())
    with open(os.path.join(state, "posted.json"), "w") as f:
        json.dump(body, f)
    stored = dict(body)
    if mode == "truncate":
        stored["content"] = body["content"][:-1]
    stored["id"] = "doc123"
    stored["size_bytes"] = len(stored["content"].encode("utf-8"))
    with open(os.path.join(state, "stored.json"), "w") as f:
        json.dump(stored, f)
    sys.stdout.write(json.dumps({"id": "doc123"}))
else:
    with open(os.path.join(state, "stored.json")) as f:
        sys.stdout.write(f.read())
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="wp-test-"))
        self.state = os.path.join(self.tmp, "state")
        self.scratch = os.path.join(self.tmp, "scratchpad")
        os.makedirs(self.state)
        os.makedirs(self.scratch)
        self.fake = os.path.join(self.tmp, "fake-wrapper")
        with open(self.fake, "w") as f:
            f.write(FAKE_WRAPPER % {"python": sys.executable})
        os.chmod(self.fake, os.stat(self.fake).st_mode | stat.S_IXUSR)
        self.env = {
            "PATH": os.environ.get("PATH", ""),
            "WORKSPACE_PUT_API_CMD": self.fake,
            "FAKE_STATE": self.state,
            "MARVEEN_AGENT_ID": "a",
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def doc(self, name="draft.md", text="# Plan title\n\nbody text\n", where=None):
        p = os.path.join(where or self.scratch, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def run_main(self, argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = wp.main(argv, self.env if env is None else env)
        return code, out.getvalue(), err.getvalue()

    def calls(self):
        p = os.path.join(self.state, "calls.log")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return [json.loads(line) for line in f if line.strip()]


class TestDocKey(unittest.TestCase):
    def test_accepts_the_convention(self):
        for key in ("plan/card1", "brief/card1", "report/card1", "notes/a/2026-10-12-topic", "draft/series/part1-v2", "peter-report/2026-10-14"):
            self.assertEqual(wp.validate_doc_key(key), key)

    def test_rejects_bad_keys(self):
        for key in ("", "card1", "plan", "plan/", "other/x", "plan/../x", "plan/a b", "plan//x", "plan/a/b/c/d", "/plan/x", "plan/x" + "y" * 250):
            with self.assertRaises(wp.Fail, msg=key) as cm:
                wp.validate_doc_key(key)
            self.assertEqual(cm.exception.code, 2)


class TestSeriesDocKey(unittest.TestCase):
    def test_accepts_series_keys(self):
        for key in (
            "series-foo/bar",
            "series-foo/part1-v2",
            "series-foo/a/b",
            "series-foo/a/b/c",  # 4 segments is the maximum
            "series-a_b-1/part.1",
            "series-0/x",
            "series-" + "a" * 50 + "/x",
        ):
            self.assertEqual(wp.validate_doc_key(key), key)

    def test_refuses_malformed_series_keys(self):
        bad = (
            "series-foo",  # no second segment
            "series-foo/",  # empty second segment
            "series-",
            "series-/x",  # empty slug
            "series-//x",
            "series-FOO/x",  # uppercase slug
            "series-Foo/x",
            "Series-foo/x",  # uppercase prefix
            "series-a b/x",
            "series-a\tb/x",
            "series-foo/../x",  # traversal in a later segment
            "series-foo/./x",
            "series-../x",  # traversal as the slug
            "series-./x",
            "series-.x/x",  # a dot cannot start or sit in the slug
            "series-a.b/x",
            "series--x/x",  # the slug starts with a letter or digit
            "series-_x/x",
            "series-a/b/c/d/e",  # 5 segments
            "series-foo/" + "y" * 250,  # over the length cap
            "/series-foo/x",
            "series-foo//x",
            "series-foo/x/",
            "series-foo/.hidden",
            "series-é/x",  # non-ASCII slug
            "series-foo/é",
            "series-a\\b/x",
            "series-a;b/x",
            "series-a%2fb/x",
            "series-foo/x\x00y",  # control characters
            "series-foo/x\x1b[0m",
            "series-foo\n/x",  # a newline hides behind "$" in a naive regex
            "series-foo/x\n",
            "series-foo/x\r",
            "series-foo\n",
            "seriesfoo/x",  # not the series prefix
            "series_foo/x",
            "series/x",
            "xseries-foo/x",
        )
        for key in bad:
            with self.assertRaises(wp.Fail, msg=repr(key)) as cm:
                wp.validate_doc_key(key)
            self.assertEqual(cm.exception.code, 2, repr(key))

    def test_a_trailing_newline_is_refused_for_every_prefix(self):
        # The same \Z guard covers the original prefixes: "$" alone let "plan/x\n" through.
        for key in ("plan/x\n", "brief/x\n", "report/x\n", "notes/a/x\n", "draft/s/p\n", "plan/a\n/b"):
            with self.assertRaises(wp.Fail, msg=repr(key)) as cm:
                wp.validate_doc_key(key)
            self.assertEqual(cm.exception.code, 2, repr(key))

    def test_the_prefix_error_names_the_series_form(self):
        with self.assertRaises(wp.Fail) as cm:
            wp.validate_doc_key("other/x")
        self.assertIn("series-<slug>", str(cm.exception))
        for prefix in ("plan", "brief", "report", "notes", "draft"):
            self.assertIn(prefix, str(cm.exception))
        with self.assertRaises(wp.Fail) as cm:
            wp.validate_doc_key("series-FOO/x")
        self.assertIn("lowercase", str(cm.exception))

    def test_usage_text_lists_the_series_prefix(self):
        helptext = wp.build_parser().format_help()
        self.assertIn("series-<slug>/<part>", helptext)
        self.assertIn("draft/<series>/<part>-vN", helptext)  # the existing forms stay listed
        self.assertIn("series-<slug>", wp.__doc__)


class TestUpload(Base):
    def test_uploads_verifies_and_keeps_the_source_by_default(self):
        src = self.doc()
        code, out, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--task-ref", "c1"])
        self.assertEqual(code, 0, err)
        self.assertIn("ok doc_key=plan/c1 id=doc123", out)
        self.assertTrue(os.path.exists(src))
        with open(os.path.join(self.state, "posted.json")) as f:
            posted = json.load(f)
        self.assertEqual(posted["agent_id"], "a")
        self.assertEqual(posted["doc_key"], "plan/c1")
        self.assertEqual(posted["type"], "plan")
        self.assertEqual(posted["task_ref"], "c1")
        self.assertEqual(posted["title"], "Plan title")
        self.assertEqual(posted["content"], "# Plan title\n\nbody text\n")
        calls = self.calls()
        self.assertEqual(calls[0][:2], ["--agent", "a"])
        self.assertIn("/api/v1/workspace", calls[0])
        self.assertIn("/api/v1/workspace/doc123", calls[1])

    def test_type_is_implied_by_the_prefix_and_must_agree(self):
        src = self.doc()
        code, _, _ = self.run_main(["--file", src, "--doc-key", "draft/s/p1-v1"])
        self.assertEqual(code, 0)
        with open(os.path.join(self.state, "posted.json")) as f:
            self.assertEqual(json.load(f)["type"], "notes")
        code, _, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--type", "report"])
        self.assertEqual(code, 2)
        self.assertIn("does not match", err)

    def posted_type(self):
        with open(os.path.join(self.state, "posted.json")) as f:
            return json.load(f)["type"]

    def test_existing_prefixes_keep_their_implied_type_and_mismatch_refusal(self):
        src = self.doc()
        implied = {"plan": "plan", "brief": "brief", "report": "report", "notes": "notes", "draft": "notes", "peter-report": "report"}
        for prefix, expected in implied.items():
            key = prefix + "/a/x"
            self.assertEqual(self.run_main(["--file", src, "--doc-key", key])[0], 0, key)
            self.assertEqual(self.posted_type(), expected, key)
            # naming the implied type explicitly is fine
            self.assertEqual(self.run_main(["--file", src, "--doc-key", key, "--type", expected])[0], 0, key)
            # any other type is refused before a single API call
            for other in wp.TYPES:
                if other == expected:
                    continue
                before = len(self.calls())
                code, _, err = self.run_main(["--file", src, "--doc-key", key, "--type", other])
                self.assertEqual(code, 2, "%s %s" % (key, other))
                self.assertIn("does not match", err)
                self.assertEqual(len(self.calls()), before, "%s %s made an API call" % (key, other))

    def test_series_key_defaults_to_notes(self):
        src = self.doc()
        code, out, err = self.run_main(["--file", src, "--doc-key", "series-foo/part1-v1"])
        self.assertEqual(code, 0, err)
        self.assertIn("ok doc_key=series-foo/part1-v1 id=doc123", out)
        self.assertEqual(self.posted_type(), "notes")
        with open(os.path.join(self.state, "posted.json")) as f:
            posted = json.load(f)
        self.assertEqual(posted["doc_key"], "series-foo/part1-v1")
        self.assertEqual(posted["agent_id"], "a")
        self.assertEqual(posted["title"], "Plan title")

    def test_series_key_takes_any_valid_type(self):
        src = self.doc()
        for doc_type in wp.TYPES:
            code, _, err = self.run_main(["--file", src, "--doc-key", "series-foo/x", "--type", doc_type])
            self.assertEqual(code, 0, err)
            self.assertEqual(self.posted_type(), doc_type)
        # an unknown type is still refused by the argument parser
        before = len(self.calls())
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "series-foo/x", "--type", "memo"])[0], 2)
        self.assertEqual(len(self.calls()), before)

    def test_malformed_series_keys_make_no_api_call_and_keep_the_source(self):
        src = self.doc()
        for key in ("series-foo", "series-/x", "series-FOO/x", "series-a b/x", "series-foo/../x", "series-foo/x\n"):
            code, _, err = self.run_main(["--file", src, "--doc-key", key, "--delete-source"])
            self.assertEqual(code, 2, repr(key))
            self.assertTrue(err.startswith("workspace-put: doc_key"), err)
            self.assertTrue(os.path.exists(src), repr(key))
        self.assertEqual(self.calls(), [])

    def test_series_key_with_delete_source_uploads_then_deletes(self):
        src = self.doc()
        code, out, err = self.run_main(["--file", src, "--doc-key", "series-foo/p1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 0, err)
        self.assertFalse(os.path.exists(src))
        self.assertIn("deleted source", out)

    def test_title_falls_back_to_the_doc_key_and_can_be_set(self):
        src = self.doc(text="no heading here\n")
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "notes/a/x"])[0], 0)
        with open(os.path.join(self.state, "posted.json")) as f:
            self.assertEqual(json.load(f)["title"], "notes/a/x")
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "notes/a/x", "--title", "Given"])[0], 0)
        with open(os.path.join(self.state, "posted.json")) as f:
            self.assertEqual(json.load(f)["title"], "Given")

    def test_stdin_source(self):
        old = sys.stdin
        sys.stdin = io.TextIOWrapper(io.BytesIO("from stdin\n".encode("utf-8")), encoding="utf-8")
        try:
            code, _, err = self.run_main(["--file", "-", "--doc-key", "notes/a/stdin"])
        finally:
            sys.stdin = old
        self.assertEqual(code, 0, err)
        code, _, err = self.run_main(["--file", "-", "--doc-key", "notes/a/stdin", "--delete-source"])
        self.assertEqual(code, 2)
        self.assertIn("not stdin", err)

    def test_arg_validation_makes_no_api_call(self):
        src = self.doc()
        bad = [
            ["--doc-key", "plan/c1"],  # no --file
            ["--file", src],  # no --doc-key
            ["--file", src, "--doc-key", "nope/c1"],
            ["--file", src, "--doc-key", "plan/c1", "--type", "memo"],
            ["--file", os.path.join(self.tmp, "missing.md"), "--doc-key", "plan/c1"],
        ]
        for argv in bad:
            code, _, _ = self.run_main(argv)
            self.assertEqual(code, 2, argv)
        self.assertEqual(self.calls(), [])

    def test_empty_binary_and_oversized_files_are_refused(self):
        empty = self.doc("e.md", "  \n")
        self.assertEqual(self.run_main(["--file", empty, "--doc-key", "plan/c1"])[0], 2)
        binf = os.path.join(self.scratch, "b.bin")
        with open(binf, "wb") as f:
            f.write(b"abc\x00def")
        code, _, err = self.run_main(["--file", binf, "--doc-key", "plan/c1"])
        self.assertEqual(code, 2)
        self.assertIn("binary", err)
        badutf = os.path.join(self.scratch, "u.bin")
        with open(badutf, "wb") as f:
            f.write(b"\xff\xfe\xfa")
        self.assertEqual(self.run_main(["--file", badutf, "--doc-key", "plan/c1"])[0], 2)
        big = self.doc("big.md", "x" * (2 * 1024 * 1024 + 1))
        self.assertEqual(self.run_main(["--file", big, "--doc-key", "plan/c1"])[0], 2)
        self.assertEqual(self.run_main(["--file", big, "--doc-key", "plan/c1", "--content-type", "code"])[0], 0)
        self.assertEqual(len(self.calls()), 2)

    def test_agent_resolution(self):
        env = dict(self.env)
        del env["MARVEEN_AGENT_ID"]
        src = self.doc()
        code, _, err = self.run_main(["--file", src, "--doc-key", "plan/c1"], env)
        self.assertEqual(code, 2)
        self.assertIn("--agent", err)
        env["BOT_NAME"] = "Bee"
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "plan/c1"], env)[0], 0)
        self.assertEqual(self.calls()[-1][:2], ["--agent", "bee"])
        env2 = dict(self.env)
        del env2["MARVEEN_AGENT_ID"]
        env2["CLAUDE_CONFIG_DIR"] = "/x/agents/cfg/.claude-config"
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "plan/c1"], env2)[0], 0)
        self.assertEqual(self.calls()[-1][:2], ["--agent", "cfg"])
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "plan/c1", "--agent", "Z!"])[0], 2)
        self.assertEqual(self.run_main(["--file", src, "--doc-key", "plan/c1", "--agent", "zed"])[0], 0)
        self.assertEqual(self.calls()[-1][:2], ["--agent", "zed"])


class TestFailuresKeepTheSource(Base):
    def test_length_mismatch_keeps_the_source(self):
        src = self.doc()
        self.env["FAKE_MODE"] = "truncate"
        code, out, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 1)
        self.assertIn("read-back mismatch", err)
        self.assertNotIn("deleted", out)
        self.assertTrue(os.path.exists(src))

    def test_api_failure_keeps_the_source(self):
        src = self.doc()
        self.env["FAKE_MODE"] = "http-fail"
        code, out, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 1)
        self.assertIn("exit 22", err)
        self.assertTrue(os.path.exists(src))

    def test_wrapper_missing_keeps_the_source(self):
        src = self.doc()
        self.env["WORKSPACE_PUT_API_CMD"] = os.path.join(self.tmp, "no-such-wrapper")
        code, _, _ = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 1)
        self.assertTrue(os.path.exists(src))


class TestDeleteSource(Base):
    def test_deletes_a_scratchpad_file_after_the_verified_upload(self):
        src = self.doc()
        code, out, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 0, err)
        self.assertFalse(os.path.exists(src))
        self.assertIn("deleted source " + src, out)

    def test_refuses_a_file_outside_the_scratchpad_before_uploading(self):
        elsewhere = self.doc("x.md", where=os.path.join(self.tmp, "elsewhere"))
        code, _, err = self.run_main(["--file", elsewhere, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 2)
        self.assertIn("not inside the session scratchpad", err)
        self.assertTrue(os.path.exists(elsewhere))
        self.assertEqual(self.calls(), [])

    def test_refuses_a_sibling_directory_that_shares_the_scratchpad_name_as_a_prefix(self):
        # <tmp>/scratchpad is the root; <tmp>/scratchpad-evil starts with the same characters but is not inside it
        sibling = self.doc("x.md", where=self.scratch + "-evil")
        code, _, err = self.run_main(["--file", sibling, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 2)
        self.assertIn("not inside the session scratchpad", err)
        self.assertTrue(os.path.exists(sibling))
        self.assertEqual(self.calls(), [])

    def test_refuses_without_any_scratchpad_signal(self):
        src = self.doc()  # directory is named scratchpad but does not follow the convention
        code, _, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source"])
        self.assertEqual(code, 2)
        self.assertTrue(os.path.exists(src))
        self.assertEqual(self.calls(), [])

    def test_refuses_a_scratchpad_root_that_is_not_named_scratchpad(self):
        src = self.doc("x.md", where=os.path.join(self.tmp, "stuff"))
        code, _, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", os.path.join(self.tmp, "stuff")])
        self.assertEqual(code, 2)
        self.assertIn("named 'scratchpad'", err)
        self.assertTrue(os.path.exists(src))

    def test_refuses_a_path_inside_a_git_work_tree(self):
        repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(repo, ".git"))
        in_repo = self.doc("notes.md", where=repo)
        code, _, err = self.run_main(["--file", in_repo, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 2)
        self.assertTrue(os.path.exists(in_repo))
        # even a scratchpad directory nested in a work tree is refused
        nested = self.doc("n.md", where=os.path.join(repo, "scratchpad"))
        code, _, err = self.run_main(["--file", nested, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", os.path.join(repo, "scratchpad")])
        self.assertEqual(code, 2)
        self.assertIn("git work tree", err)
        self.assertTrue(os.path.exists(nested))
        # a worktree-style .git file counts too
        wt = os.path.join(self.tmp, "wt")
        os.makedirs(wt)
        with open(os.path.join(wt, ".git"), "w") as f:
            f.write("gitdir: /elsewhere\n")
        in_wt = self.doc("w.md", where=os.path.join(wt, "scratchpad"))
        code, _, _ = self.run_main(["--file", in_wt, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", os.path.join(wt, "scratchpad")])
        self.assertEqual(code, 2)
        self.assertEqual(self.calls(), [])

    def test_refuses_symlinks(self):
        target = self.doc("t.md", where=os.path.join(self.tmp, "elsewhere"))
        link = os.path.join(self.scratch, "link.md")
        os.symlink(target, link)
        code, _, err = self.run_main(["--file", link, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 2)
        self.assertIn("symlink", err)
        self.assertTrue(os.path.exists(target))

    def test_dotdot_cannot_escape_the_scratchpad(self):
        outside = self.doc("o.md", where=os.path.join(self.tmp, "elsewhere"))
        sneaky = os.path.join(self.scratch, "..", "elsewhere", "o.md")
        code, _, _ = self.run_main(["--file", sneaky, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 2)
        self.assertTrue(os.path.exists(outside))

    def test_a_source_edited_during_the_upload_is_kept(self):
        src = self.doc()
        # make the fake wrapper rewrite the source while handling the POST
        with open(self.fake, "a") as f:
            f.write("\nif method == 'POST':\n    open(%r, 'a').write('late edit')\n" % src)
        code, out, err = self.run_main(["--file", src, "--doc-key", "plan/c1", "--delete-source", "--scratchpad-root", self.scratch])
        self.assertEqual(code, 1)
        self.assertIn("changed during the upload", err)
        self.assertTrue(os.path.exists(src))

    def test_scratchpad_convention_regex(self):
        ok = [
            "/private/tmp/claude-501/-proj/abc-123/scratchpad/x.md",
            "/tmp/claude-1000/proj/abc/scratchpad/sub/x.md",
            "/private/var/folders/ab/cd1234/T/claude-501/proj/abc/scratchpad/x.md",
        ]
        bad = [
            "/private/tmp/x.md",
            "/private/tmp/claude-501/proj/abc/x.md",
            "/private/tmp/claude-501/proj/scratchpad/x.md",
            "/private/tmp/claude-501/proj/abc/scratchpad-evil/x.md",
            "/home/u/claude-501/proj/abc/scratchpad/x.md",
            "/private/tmp/claude-x/proj/abc/scratchpad/x.md",
            "/private/tmp/claude-501/proj/abc/def/scratchpad/x.md",
        ]
        for p in ok:
            self.assertTrue(wp.SCRATCH_RE.match(p), p)
        for p in bad:
            self.assertFalse(wp.SCRATCH_RE.match(p), p)


if __name__ == "__main__":
    unittest.main()
