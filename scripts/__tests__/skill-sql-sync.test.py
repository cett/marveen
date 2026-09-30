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


if __name__ == "__main__":
    unittest.main()
