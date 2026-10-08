#!/usr/bin/env python3
"""Unit tests for scripts/hooks/skill-sql-sync.py (the file-system half).

The hook derives the skill id from the path, parses the generated header, reads
the file and sends the result to POST /api/skill-sync; the database half
(upsert, tenant qualification, companion limits) is tested in
src/__tests__/skill-sync-route.test.ts. Here the dashboard call is replaced by a
recorder, so the tests pin WHAT the hook sends and what it refuses to send
(forged tenant headers outside an agent skills dir, wrong directory names,
oversize or unsafe companion paths), plus the failure path: a dashboard that
cannot be reached must produce the "NOT in DB" warning, never a crash.

Privacy: only neutral fixture data; no real agent names, tokens, or chat IDs.
"""
import base64
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "skill-sql-sync.py",
)
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("skill_sql_sync", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

FM = "---\nname: demo\ndescription: d\n---\n"


def tenant_header(skill_id: str) -> str:
    return f"{hook.GENERATED_MARKER} (tenant skill {skill_id}). Edit it in the dashboard. -->"


class Recorder:
    """Stands in for hook._post: records payloads, answers with a canned message."""

    def __init__(self):
        self.calls = []
        self.fail = None

    def __call__(self, payload):
        if self.fail:
            raise self.fail
        self.calls.append(payload)
        return f"recorded {payload['kind']}"


class HookTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self._saved = (hook.HOME, hook.MARVEEN_ROOT, hook.AGENTS_BASE_DIR, hook._post)
        hook.HOME = os.path.join(root, "home")
        hook.MARVEEN_ROOT = os.path.join(root, "proj")
        hook.AGENTS_BASE_DIR = os.path.join(hook.MARVEEN_ROOT, "agents")
        self.post = Recorder()
        hook._post = self.post
        os.environ["MAIN_AGENT_ID"] = "mainx"

    def tearDown(self):
        hook.HOME, hook.MARVEEN_ROOT, hook.AGENTS_BASE_DIR, hook._post = self._saved
        os.environ.pop("MAIN_AGENT_ID", None)
        self.tmp.cleanup()

    def _run_main(self, tool_input, tool_name="Edit"):
        old = sys.stdin
        sys.stdin = io.StringIO(json.dumps({"tool_name": tool_name, "tool_input": tool_input}))
        out, err = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(out), redirect_stderr(err), self.assertRaises(SystemExit) as cm:
                hook.main()
        finally:
            sys.stdin = old
        self.assertEqual(cm.exception.code, 0)  # the hook never fails the agent
        return out.getvalue(), err.getvalue()


class TenantSync(HookTestCase):
    def _file(self, agent: str, dir_name: str, body: str, skill_id: str = "acme-demo") -> str:
        d = os.path.join(hook.AGENTS_BASE_DIR, agent, ".claude", "skills", dir_name)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "SKILL.md")
        with open(p, "w") as f:
            f.write(FM + tenant_header(skill_id) + "\n" + body)
        return p

    def _run(self, path: str) -> str:
        with open(path) as f:
            content = f.read()
        hdr = hook.read_generated_header(content)
        self.assertTrue(hdr and hdr[1])
        return hook._sync_tenant_skill(path, content, hdr[0])

    def test_edit_sends_the_tenant_id_the_agent_and_the_directory(self):
        p = self._file("ann", "acme-demo", "new body\n")
        self.assertEqual(self._run(p), "recorded tenant")
        call = self.post.calls[0]
        self.assertEqual((call["kind"], call["header_id"], call["agent_id"], call["dir_name"]),
                         ("tenant", "acme-demo", "ann", "acme-demo"))
        self.assertIn("new body", call["content"])

    def test_directory_must_match_the_header_id_and_nothing_is_sent(self):
        p = self._file("ann", "some-other-dir", "x\n")
        self.assertIn("does not match directory", self._run(p))
        self.assertEqual(self.post.calls, [])

    def test_header_outside_an_agent_skills_dir_is_not_sent(self):
        p = os.path.join(self.tmp.name, "elsewhere", "acme-demo", "SKILL.md")
        os.makedirs(os.path.dirname(p))
        with open(p, "w") as f:
            f.write(FM + tenant_header("acme-demo") + "\nx\n")
        self.assertIn("outside an agent skills dir", self._run(p))
        self.assertEqual(self.post.calls, [])

    def test_main_routes_a_tenant_copy_to_the_tenant_kind_not_the_agent_row(self):
        p = self._file("ann", "acme-demo", "via main\n")
        _, err = self._run_main({"file_path": p})
        self.assertEqual([c["kind"] for c in self.post.calls], ["tenant"])
        self.assertIn("recorded tenant", err)

    def test_read_generated_header_distinguishes_tenant_and_fleet(self):
        self.assertEqual(hook.read_generated_header(FM + tenant_header("acme-demo") + "\n"), ("acme-demo", True))
        fleet = f"{hook.GENERATED_MARKER} (skill global/x). x -->\n"
        self.assertEqual(hook.read_generated_header(FM + fleet), ("global/x", False))
        self.assertIsNone(hook.read_generated_header(FM + "body\n"))

    def test_tenant_dir_name_mirrors_the_ts_side(self):
        self.assertEqual(hook.tenant_dir_name("acme-demo"), "acme-demo")
        self.assertEqual(hook.tenant_dir_name("a/b c"), "a-b-c")
        self.assertEqual(hook.tenant_dir_name("../x"), "x")
        self.assertIsNone(hook.tenant_dir_name("..."))


class PlainSkillSync(HookTestCase):
    def test_global_skill_md_is_sent_as_a_skill_with_its_content(self):
        p = os.path.join(hook.HOME, ".claude", "skills", "demo", "SKILL.md")
        os.makedirs(os.path.dirname(p))
        with open(p, "w") as f:
            f.write(FM + "body\n")
        _, err = self._run_main({"file_path": p}, tool_name="Write")
        self.assertEqual(self.post.calls, [{"kind": "skill", "skill_id": "global/demo", "content": FM + "body\n"}])
        self.assertIn("recorded skill", err)

    def test_agent_skill_md_maps_to_its_agent_id_and_the_main_agent_to_the_project_skills(self):
        for base, expected in (
            (os.path.join(hook.AGENTS_BASE_DIR, "ann", ".claude", "skills", "loc"), "agent/ann/loc"),
            (os.path.join(hook.MARVEEN_ROOT, ".claude", "skills", "loc"), "agent/mainx/loc"),
        ):
            os.makedirs(base)
            p = os.path.join(base, "SKILL.md")
            with open(p, "w") as f:
                f.write("b")
            self._run_main({"file_path": p}, tool_name="MultiEdit")
            self.assertEqual(self.post.calls[-1]["skill_id"], expected)

    def test_other_tools_and_non_skill_files_are_ignored(self):
        p = os.path.join(hook.HOME, ".claude", "skills", "demo", "SKILL.md")
        self._run_main({"file_path": p}, tool_name="Read")
        self._run_main({"file_path": os.path.join(self.tmp.name, "notes.md")})
        self.assertEqual(self.post.calls, [])

    def test_unreachable_dashboard_warns_the_agent_and_still_exits_zero(self):
        p = os.path.join(hook.HOME, ".claude", "skills", "demo", "SKILL.md")
        os.makedirs(os.path.dirname(p))
        with open(p, "w") as f:
            f.write("body")
        self.post.fail = ConnectionRefusedError("refused")
        out, err = self._run_main({"file_path": p})
        self.assertIn("NOT in DB", err)
        ctx = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(ctx["hookEventName"], "PostToolUse")
        self.assertIn("NOT written back", ctx["additionalContext"])
        self.assertIn("global/demo", ctx["additionalContext"])


class CompanionSync(HookTestCase):
    """Edits of scripts/, references/ ... files inside a skill dir."""

    def _write(self, path: str, data: bytes, mode: int = 0o644, skill_md: "str | None" = None) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        os.chmod(path, mode)
        if skill_md is not None:
            with open(os.path.join(self._skill_dir(path), "SKILL.md"), "w") as f:
                f.write(skill_md)
        return path

    @staticmethod
    def _skill_dir(path: str) -> str:
        d = os.path.dirname(path)
        while os.path.basename(os.path.dirname(d)) != "skills":
            d = os.path.dirname(d)
        return d

    def _sync(self, path: str) -> str:
        loc = hook._companion_location(path)
        self.assertIsNotNone(loc, path)
        return hook._sync_companion_file(path, loc[0], loc[1])

    def test_global_skill_companion_is_sent_with_binary_content_and_the_file_mode(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "scripts", "run.sh"), b"\x00\xffbin\n", 0o755, skill_md="body")
        self.assertEqual(self._sync(p), "recorded companion")
        call = self.post.calls[0]
        self.assertEqual((call["skill_id"], call["rel_path"], call["mode"]), ("global/demo", "scripts/run.sh", 0o755))
        self.assertEqual(base64.b64decode(call["content_base64"]), b"\x00\xffbin\n")
        self.assertNotIn("tenant_agent", call)

    def test_skill_md_is_not_a_companion_and_tool_caches_are_skipped(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        self._write(os.path.join(base, "notes.md"), b"v1", skill_md="body")
        self.assertIsNone(hook._companion_location(os.path.join(base, "SKILL.md")))
        cache = self._write(os.path.join(base, "__pycache__", "m.pyc"), b"junk")
        self.assertIsNone(hook._companion_location(cache))

    def test_agent_local_skill_maps_to_its_agent_row(self):
        base = os.path.join(hook.AGENTS_BASE_DIR, "ann", ".claude", "skills", "loc")
        p = self._write(os.path.join(base, "references", "r.md"), b"r", skill_md="b")
        self._sync(p)
        self.assertEqual(self.post.calls[0]["skill_id"], "agent/ann/loc")

    def test_files_outside_any_skill_dir_are_not_companions(self):
        p = self._write(os.path.join(self.tmp.name, "elsewhere", "x.txt"), b"x")
        self.assertIsNone(hook._companion_location(p))

    def test_oversize_and_unsafe_paths_are_not_sent(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "big.bin"), b"x", skill_md="body")
        old = hook.MAX_SKILL_FILE_BYTES
        hook.MAX_SKILL_FILE_BYTES = 0
        try:
            self.assertIn("over the size limit", self._sync(p))
        finally:
            hook.MAX_SKILL_FILE_BYTES = old
        self.assertEqual(self.post.calls, [])
        self.assertIsNone(hook.normalize_skill_rel_path("../x"))
        self.assertIsNone(hook.normalize_skill_rel_path("SKILL.md"))
        self.assertEqual(hook.normalize_skill_rel_path("a/b.txt"), "a/b.txt")

    def test_tenant_copy_companion_carries_the_tenant_id_and_the_agent(self):
        base = os.path.join(hook.AGENTS_BASE_DIR, "ann", ".claude", "skills", "acme-demo")
        md = FM + tenant_header("acme-demo") + "\ntbody\n"
        p = self._write(os.path.join(base, "scripts", "t.sh"), b"t", skill_md=md)
        self._sync(p)
        call = self.post.calls[0]
        self.assertEqual((call["skill_id"], call["tenant_agent"]), ("acme-demo", "ann"))

    def test_tenant_copy_in_the_wrong_directory_is_not_sent(self):
        base = os.path.join(hook.AGENTS_BASE_DIR, "ann", ".claude", "skills", "renamed")
        md = FM + tenant_header("acme-demo") + "\ntbody\n"
        p = self._write(os.path.join(base, "scripts", "t.sh"), b"t", skill_md=md)
        self.assertIn("does not match its header", self._sync(p))
        self.assertEqual(self.post.calls, [])

    def test_failed_companion_write_warns_instead_of_crashing(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "notes.md"), b"v1", skill_md="body")
        self.post.fail = OSError("down")
        out, err = self._run_main({"file_path": p})
        self.assertIn("NOT in DB", err)
        self.assertIn("notes.md", json.loads(out)["hookSpecificOutput"]["additionalContext"])


if __name__ == "__main__":
    unittest.main()
