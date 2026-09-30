#!/usr/bin/env python3
"""Unit tests for scripts/hooks/skill-sql-sync.py, tenant skill handling.

A generated tenant skill copy (header "(tenant skill <id>)") lives under an
agent's skills dir. When that agent edits it, the hook must update THAT tenant
row and never mint agent/<id>/<dir> or touch a row the agent does not qualify
for (the header is only a claim). Runs against a temp SQLite DB and a temp
agents dir by patching the module's DB_PATH / AGENTS_BASE_DIR.

Privacy: only neutral fixture data; no real agent names, tokens, or chat IDs.
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "skill-sql-sync.py",
)
_spec = importlib.util.spec_from_file_location("skill_sql_sync", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]

FM = "---\nname: demo\ndescription: d\n---\n"


def tenant_header(skill_id: str) -> str:
    return f"{hook.GENERATED_MARKER} (tenant skill {skill_id}). Edit it in the dashboard. -->"


class TenantSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.agents = os.path.join(self.tmp.name, "agents")
        self.db = os.path.join(self.tmp.name, "t.db")
        hook.AGENTS_BASE_DIR = self.agents
        hook.DB_PATH = self.db
        c = sqlite3.connect(self.db)
        c.executescript(
            """CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, content TEXT,
                 tenant_id TEXT, is_global INTEGER, created_by TEXT, created_at INTEGER, updated_at INTEGER);
               CREATE TABLE skill_tenant_access (skill_id TEXT, tenant_id TEXT);
               CREATE TABLE tenant_agent_availability (tenant_id TEXT, agent_id TEXT, enabled INTEGER);"""
        )
        c.execute("INSERT INTO skills VALUES ('acme-demo','acme-demo','', 'old body', 'acme', 0, NULL, 0, 0)")
        c.execute("INSERT INTO tenant_agent_availability VALUES ('acme','ann',1)")
        c.execute("INSERT INTO tenant_agent_availability VALUES ('beta','bob',1)")
        c.commit()
        c.close()

    def tearDown(self):
        self.tmp.cleanup()

    def _file(self, agent: str, dir_name: str, body: str, skill_id: str = "acme-demo") -> str:
        d = os.path.join(self.agents, agent, ".claude", "skills", dir_name)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "SKILL.md")
        content = FM + tenant_header(skill_id) + "\n" + body
        with open(p, "w") as f:
            f.write(content)
        return p

    def _content(self, skill_id: str = "acme-demo"):
        c = sqlite3.connect(self.db)
        try:
            r = c.execute("SELECT content FROM skills WHERE id = ?", (skill_id,)).fetchone()
            return r[0] if r else None
        finally:
            c.close()

    def _ids(self):
        c = sqlite3.connect(self.db)
        try:
            return {r[0] for r in c.execute("SELECT id FROM skills")}
        finally:
            c.close()

    def _run(self, path: str) -> str:
        with open(path) as f:
            content = f.read()
        hdr = hook.read_generated_header(content)
        self.assertTrue(hdr and hdr[1])
        return hook._sync_tenant_skill(path, content, hdr[0])

    def test_edit_by_owning_tenant_agent_updates_the_tenant_row_without_the_header(self):
        p = self._file("ann", "acme-demo", "new body\n")
        self.assertIn("updated tenant skill acme-demo", self._run(p))
        self.assertEqual(self._content(), FM + "new body\n")
        self.assertEqual(self._ids(), {"acme-demo"})   # no agent/<id>/<dir> row minted

    def test_agent_of_another_tenant_cannot_overwrite_the_row_with_a_forged_header(self):
        p = self._file("bob", "acme-demo", "forged\n")
        self.assertIn("does not qualify", self._run(p))
        self.assertEqual(self._content(), "old body")

    def test_grantee_tenant_agent_may_edit(self):
        c = sqlite3.connect(self.db)
        c.execute("INSERT INTO skill_tenant_access VALUES ('acme-demo','beta')")
        c.commit(); c.close()
        p = self._file("bob", "acme-demo", "by grantee\n")
        self.assertIn("updated tenant skill", self._run(p))
        self.assertEqual(self._content(), FM + "by grantee\n")

    def test_directory_must_match_the_header_id(self):
        p = self._file("ann", "some-other-dir", "x\n")
        self.assertIn("does not match directory", self._run(p))
        self.assertEqual(self._content(), "old body")

    def test_unknown_id_and_fleet_rows_are_ignored(self):
        p = self._file("ann", "nope", "x\n", skill_id="nope")
        self.assertIn("no tenant skill nope", self._run(p))
        c = sqlite3.connect(self.db)
        c.execute("INSERT INTO skills VALUES ('global-x','global-x','', 'fleet body', 'fleet', 1, NULL, 0, 0)")
        c.commit(); c.close()
        p2 = self._file("ann", "global-x", "x\n", skill_id="global-x")
        self.assertIn("no tenant skill global-x", self._run(p2))
        self.assertEqual(self._content("global-x"), "fleet body")

    def test_header_outside_an_agent_skills_dir_is_ignored(self):
        p = os.path.join(self.tmp.name, "elsewhere", "acme-demo", "SKILL.md")
        os.makedirs(os.path.dirname(p))
        with open(p, "w") as f:
            f.write(FM + tenant_header("acme-demo") + "\nx\n")
        self.assertIn("outside an agent skills dir", self._run(p))

    def test_main_routes_a_tenant_copy_to_its_row_not_to_an_agent_row(self):
        import io, json, sys
        p = self._file("ann", "acme-demo", "via main\n")
        payload = json.dumps({"tool_name": "Edit", "tool_input": {"file_path": p}})
        old = sys.stdin
        sys.stdin = io.StringIO(payload)
        try:
            with self.assertRaises(SystemExit) as cm:
                hook.main()
        finally:
            sys.stdin = old
        self.assertEqual(cm.exception.code, 0)
        self.assertEqual(self._content(), FM + "via main\n")
        self.assertEqual(self._ids(), {"acme-demo"})

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


class CompanionSync(unittest.TestCase):
    """Edits of scripts/, references/ ... files inside a skill dir go to skill_files."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self._saved = (hook.HOME, hook.MARVEEN_ROOT, hook.AGENTS_BASE_DIR, hook.DB_PATH)
        hook.HOME = os.path.join(root, "home")
        hook.MARVEEN_ROOT = os.path.join(root, "proj")
        hook.AGENTS_BASE_DIR = os.path.join(hook.MARVEEN_ROOT, "agents")
        hook.DB_PATH = os.path.join(root, "t.db")
        os.environ["MAIN_AGENT_ID"] = "mainx"
        c = sqlite3.connect(hook.DB_PATH)
        c.executescript(
            """CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, content TEXT,
                 tenant_id TEXT, is_global INTEGER, created_by TEXT, created_at INTEGER, updated_at INTEGER);
               CREATE TABLE skill_tenant_access (skill_id TEXT, tenant_id TEXT);
               CREATE TABLE tenant_agent_availability (tenant_id TEXT, agent_id TEXT, enabled INTEGER);
               CREATE TABLE skill_files (skill_id TEXT NOT NULL, rel_path TEXT NOT NULL, content BLOB NOT NULL,
                 mode INTEGER NOT NULL DEFAULT 420, created_at INTEGER, updated_at INTEGER,
                 PRIMARY KEY (skill_id, rel_path));"""
        )
        c.execute("INSERT INTO skills VALUES ('global/demo','demo','','body','fleet',1,NULL,0,0)")
        c.execute("INSERT INTO skills VALUES ('acme-demo','acme-demo','','tbody','acme',0,NULL,0,0)")
        c.execute("INSERT INTO tenant_agent_availability VALUES ('acme','ann',1)")
        c.commit()
        c.close()

    def tearDown(self):
        hook.HOME, hook.MARVEEN_ROOT, hook.AGENTS_BASE_DIR, hook.DB_PATH = self._saved
        os.environ.pop("MAIN_AGENT_ID", None)
        self.tmp.cleanup()

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

    def _files(self, skill_id: str):
        c = sqlite3.connect(hook.DB_PATH)
        try:
            return {r[0]: (bytes(r[1]), r[2]) for r in c.execute(
                "SELECT rel_path, content, mode FROM skill_files WHERE skill_id = ?", (skill_id,))}
        finally:
            c.close()

    def _sync(self, path: str) -> str:
        loc = hook._companion_location(path)
        self.assertIsNotNone(loc, path)
        return hook._sync_companion_file(path, loc[0], loc[1])

    def test_global_skill_companion_is_stored_with_exec_bit_and_binary_content(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "scripts", "run.sh"), b"\x00\xffbin\n", 0o755, skill_md="body")
        self.assertIn("stored companion scripts/run.sh of global/demo", self._sync(p))
        self.assertEqual(self._files("global/demo"), {"scripts/run.sh": (b"\x00\xffbin\n", 0o755)})

    def test_update_replaces_and_a_skill_md_is_not_a_companion(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "notes.md"), b"v1", skill_md="body")
        self._sync(p)
        self._write(p, b"v2")
        self._sync(p)
        self.assertEqual(self._files("global/demo"), {"notes.md": (b"v2", 0o644)})
        self.assertIsNone(hook._companion_location(os.path.join(base, "SKILL.md")))

    def test_agent_local_skill_maps_to_its_agent_row(self):
        c = sqlite3.connect(hook.DB_PATH)
        c.execute("INSERT INTO skills VALUES ('agent/ann/loc','loc','','b','fleet',0,NULL,0,0)")
        c.commit(); c.close()
        base = os.path.join(hook.AGENTS_BASE_DIR, "ann", ".claude", "skills", "loc")
        p = self._write(os.path.join(base, "references", "r.md"), b"r", skill_md="b")
        self._sync(p)
        self.assertEqual(list(self._files("agent/ann/loc")), ["references/r.md"])

    def test_unknown_skill_row_and_tool_cache_dirs_are_ignored(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "norow")
        p = self._write(os.path.join(base, "x.txt"), b"x", skill_md="b")
        self.assertIn("no skill global/norow in the DB yet", self._sync(p))
        cache = os.path.join(hook.HOME, ".claude", "skills", "demo", "__pycache__", "m.pyc")
        self._write(cache, b"junk", skill_md="body")
        self.assertIsNone(hook._companion_location(cache))
        self.assertEqual(self._files("global/norow"), {})

    def test_files_outside_any_skill_dir_are_not_companions(self):
        p = self._write(os.path.join(self.tmp.name, "elsewhere", "x.txt"), b"x")
        self.assertIsNone(hook._companion_location(p))

    def test_oversize_and_unsafe_paths_are_ignored(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "big.bin"), b"x", skill_md="body")
        old = hook.MAX_SKILL_FILE_BYTES
        hook.MAX_SKILL_FILE_BYTES = 0
        try:
            self.assertIn("over the size limit", self._sync(p))
        finally:
            hook.MAX_SKILL_FILE_BYTES = old
        self.assertEqual(self._files("global/demo"), {})
        self.assertIsNone(hook.normalize_skill_rel_path("../x"))
        self.assertIsNone(hook.normalize_skill_rel_path("SKILL.md"))
        self.assertEqual(hook.normalize_skill_rel_path("a/b.txt"), "a/b.txt")

    def test_per_skill_file_cap(self):
        base = os.path.join(hook.HOME, ".claude", "skills", "demo")
        p = self._write(os.path.join(base, "one-more.txt"), b"x", skill_md="body")
        c = sqlite3.connect(hook.DB_PATH)
        c.executemany("INSERT INTO skill_files (skill_id, rel_path, content) VALUES ('global/demo', ?, x'00')",
                      [(f"f{i}",) for i in range(hook.MAX_SKILL_FILES_PER_SKILL)])
        c.commit(); c.close()
        self.assertIn("already has", self._sync(p))

    def test_tenant_copy_companion_goes_to_the_tenant_row_only_for_a_qualifying_agent(self):
        base = os.path.join(hook.AGENTS_BASE_DIR, "ann", ".claude", "skills", "acme-demo")
        md = FM + tenant_header("acme-demo") + "\ntbody\n"
        p = self._write(os.path.join(base, "scripts", "t.sh"), b"t", skill_md=md)
        self.assertIn("stored companion scripts/t.sh of acme-demo", self._sync(p))
        self.assertEqual(list(self._files("acme-demo")), ["scripts/t.sh"])
        self.assertEqual(self._files("agent/ann/acme-demo"), {})
        # an agent the tenant does not enable cannot write through the same header
        base2 = os.path.join(hook.AGENTS_BASE_DIR, "eve", ".claude", "skills", "acme-demo")
        p2 = self._write(os.path.join(base2, "scripts", "evil.sh"), b"e", skill_md=md)
        self.assertIn("does not qualify", self._sync(p2))
        self.assertEqual(list(self._files("acme-demo")), ["scripts/t.sh"])


if __name__ == "__main__":
    unittest.main()
