#!/usr/bin/env python3
"""Tests for scripts/hooks/tenant-skill-gate.py (PreToolUse), fed by tenant-context.py (UserPromptSubmit).

A tenant's skills may only be used in that tenant's requests; fleet skills always. Fail closed on a
missing/unknown/conflicting/stale context and on gate errors. Neutral fixtures only.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOKS = os.path.join(ROOT, "scripts", "hooks")
sys.path.insert(0, HOOKS)
import tenant_context_lib as tcl  # noqa: E402

CWD = os.path.join(ROOT, "agents", "agent-a")
SK = CWD + "/.claude/skills/"
CHAN = '<channel source="plugin:telegram:telegram" chat_id="%s" message_id="1" user="u">\nhi\n</channel>'

SCHEMA = [
    "CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, content TEXT, tenant_id TEXT)",
    "CREATE TABLE skill_tenant_access (skill_id TEXT, tenant_id TEXT)",
    """CREATE TABLE tenant_channel_bindings (agent_id TEXT, channel TEXT, external_id TEXT, tenant_id TEXT,
       PRIMARY KEY (agent_id, channel, external_id))""",
    "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, from_agent TEXT, to_agent TEXT, tenant_id TEXT)",
    "CREATE TABLE schedules (id TEXT PRIMARY KEY, agent TEXT, tenant_id TEXT)",
    "CREATE TABLE tenant_agent_availability (tenant_id TEXT, agent_id TEXT, enabled INTEGER DEFAULT 1)",
]


def make_db(path):
    con = sqlite3.connect(path)
    for ddl in SCHEMA:
        con.execute(ddl)
    con.execute("INSERT INTO skills VALUES ('global/handoff','handoff','x','fleet')")
    con.execute("INSERT INTO skills VALUES ('tenant-x-demo','demo','---\nname: demo-skill\n---\nbody','tenant-x')")
    con.execute("INSERT INTO skills VALUES ('tenant-y-tool','tool','body','tenant-y')")
    con.execute("INSERT INTO skills VALUES ('tenant-y-shared','shared','body','tenant-y')")
    con.execute("INSERT INTO skills VALUES ('acme/odd id','odd','body','tenant-y')")
    con.execute("INSERT INTO skill_tenant_access VALUES ('tenant-y-shared','tenant-x')")
    con.execute("INSERT INTO tenant_channel_bindings VALUES ('agent-a','telegram','111','tenant-x')")
    con.execute("INSERT INTO tenant_channel_bindings VALUES ('agent-a','telegram','222','tenant-y')")
    con.execute("INSERT INTO schedules VALUES ('nightly','agent-a',NULL)")
    con.execute("INSERT INTO tenant_agent_availability VALUES ('tenant-x','agent-a',1)")
    con.execute("INSERT INTO tenant_agent_availability VALUES ('tenant-y','agent-a',1)")
    con.commit()
    con.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "t.db")
        make_db(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self):
        return dict(os.environ, LEDGER_DB_PATH=self.db)

    def prompt(self, text, sid="s"):
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "tenant-context.py")],
                           input=json.dumps({"cwd": CWD, "prompt": text, "session_id": sid}),
                           capture_output=True, text=True, env=self.env())
        self.assertEqual(p.returncode, 0, p.stderr)

    def set_context(self, status, tenant, age=0):
        con = sqlite3.connect(self.db)
        con.execute(tcl.SCHEMA)
        tcl.write_context(con, "agent-a", status, tenant, "test", "s")
        con.execute("UPDATE agent_tenant_context SET updated_at = ? WHERE agent_id = 'agent-a'", (int(time.time()) - age,))
        con.commit(); con.close()

    def gate(self, tool, **inp):
        return subprocess.run([sys.executable, os.path.join(HOOKS, "tenant-skill-gate.py")],
                              input=json.dumps({"tool_name": tool, "tool_input": inp, "cwd": CWD}),
                              capture_output=True, text=True, env=self.env())

    def allowed(self, tool, **inp):
        p = self.gate(tool, **inp)
        self.assertEqual(p.returncode, 0, p.stderr)

    def denied(self, tool, **inp):
        p = self.gate(tool, **inp)
        self.assertEqual(p.returncode, 2, "expected a block, got %s" % p.returncode)
        self.assertIn("TENANT-SKILL-KAPU", p.stderr)
        return p.stderr


class TestMembershipRecheck(Base):
    def test_tenant_disabled_for_the_agent_after_the_prompt_is_denied_at_once(self):
        self.prompt(CHAN % "111")   # tenant-x, context recorded as bound
        self.allowed("Skill", skill="tenant-x-demo")
        con = sqlite3.connect(self.db)
        con.execute("UPDATE tenant_agent_availability SET enabled=0 WHERE tenant_id='tenant-x'")
        con.commit(); con.close()
        err = self.denied("Skill", skill="tenant-x-demo")   # no new prompt in between
        self.assertIn("engedelyezve", err)
        self.allowed("Skill", skill="global/handoff")        # fleet skills stay usable

    def test_missing_availability_table_fails_closed(self):
        self.prompt(CHAN % "111")
        con = sqlite3.connect(self.db)
        con.execute("DROP TABLE tenant_agent_availability")
        con.commit(); con.close()
        self.denied("Skill", skill="tenant-x-demo")


class TestSkillTool(Base):
    def test_own_tenant_skill_allowed_other_tenants_denied(self):
        self.prompt(CHAN % "111")   # tenant-x
        self.allowed("Skill", skill="tenant-x-demo")
        self.denied("Skill", skill="tenant-y-tool")

    def test_granted_skill_allowed(self):
        self.prompt(CHAN % "111")
        self.allowed("Skill", skill="tenant-y-shared")
        self.prompt(CHAN % "222")   # the owner tenant itself
        self.allowed("Skill", skill="tenant-y-shared")

    def test_fleet_and_unknown_skills_are_never_gated(self):
        self.prompt(CHAN % "222")
        self.allowed("Skill", skill="handoff")
        self.allowed("Skill", skill="some-plugin:thing")
        self.allowed("Skill", skill="")

    def test_skill_addressed_by_its_frontmatter_name_is_the_same_skill(self):
        self.prompt(CHAN % "222")
        self.denied("Skill", skill="demo-skill")     # tenant-x's skill, frontmatter name
        self.prompt(CHAN % "111")
        self.allowed("Skill", skill="demo-skill")

    def test_default_context_gets_no_tenant_skill(self):
        self.prompt("typed by the operator")
        self.allowed("Skill", skill="handoff")
        self.denied("Skill", skill="tenant-x-demo")

    def test_a_new_prompt_switches_the_tenant(self):
        self.prompt(CHAN % "111")
        self.allowed("Skill", skill="tenant-x-demo")
        self.prompt(CHAN % "222")
        self.denied("Skill", skill="tenant-x-demo")
        self.allowed("Skill", skill="tenant-y-tool")

    def test_scheduled_task_is_the_fleet_default_tenant(self):
        self.prompt('<scheduled-task source="scheduled-task:nightly">go</scheduled-task>')
        self.denied("Skill", skill="tenant-x-demo")

    def test_delegated_message_carries_the_tenant(self):
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO agent_messages VALUES (7,'coord','agent-a','tenant-x')")
        con.commit(); con.close()
        self.prompt('[Uzenet @coord-tol -- trusted team member, msg_id:7]: <trusted-peer source="agent:coord">do it</trusted-peer>')
        self.allowed("Skill", skill="tenant-x-demo")
        self.denied("Skill", skill="tenant-y-tool")


class TestFailClosed(Base):
    def test_unknown_conflict_missing_and_stale_contexts_block_tenant_skills(self):
        self.assertIn("nincs rogzitett", self.denied("Skill", skill="tenant-x-demo"))   # no context row at all
        self.set_context("unknown", "")
        self.assertIn("nem azonosithato", self.denied("Skill", skill="tenant-x-demo"))
        self.set_context("conflict", "")
        self.assertIn("nem azonosithato", self.denied("Skill", skill="tenant-x-demo"))
        # a status that is not usable blocks even when a tenant id is stored next to it
        self.set_context("unknown", "tenant-x")
        self.assertIn("nem azonosithato", self.denied("Skill", skill="tenant-x-demo"))
        self.set_context("conflict", "tenant-x")
        self.assertIn("nem azonosithato", self.denied("Skill", skill="tenant-x-demo"))
        self.set_context("bound", "tenant-x", age=13 * 3600)     # older than the default 12 h
        self.assertIn("elavult", self.denied("Skill", skill="tenant-x-demo"))
        self.set_context("bound", "tenant-x", age=60)
        self.allowed("Skill", skill="tenant-x-demo")

    def test_fleet_skills_and_plain_tools_are_allowed_without_any_context(self):
        self.allowed("Skill", skill="handoff")
        self.allowed("Read", file_path="/etc/hosts")
        self.allowed("Bash", command="ls -la")

    def test_unreadable_database_blocks_a_skill_call_but_not_an_unrelated_one(self):
        self.db = os.path.join(self.tmp.name, "missing.db")
        self.denied("Skill", skill="tenant-x-demo")
        self.allowed("Read", file_path="/etc/hosts")             # never needed the database
        self.allowed("Bash", command="git status")

    def test_garbage_input_blocks(self):
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "tenant-skill-gate.py")], input="{",
                           capture_output=True, text=True, env=self.env())
        self.assertEqual(p.returncode, 2)

    def test_stale_window_is_configurable(self):
        self.set_context("bound", "tenant-x", age=120)
        os.environ["TENANT_CONTEXT_MAX_AGE_SECONDS"] = "60"
        try:
            self.denied("Skill", skill="tenant-x-demo")
        finally:
            del os.environ["TENANT_CONTEXT_MAX_AGE_SECONDS"]


class TestPaths(Base):
    def test_read_inside_a_foreign_tenant_skill_dir_is_blocked_own_and_fleet_allowed(self):
        self.prompt(CHAN % "111")
        self.denied("Read", file_path=SK + "tenant-y-tool/SKILL.md")
        self.denied("Read", file_path=SK + "tenant-y-tool/scripts/run.sh")
        self.allowed("Read", file_path=SK + "tenant-x-demo/scripts/run.sh")
        self.allowed("Read", file_path=SK + "tenant-y-shared/SKILL.md")   # granted
        self.allowed("Read", file_path=SK + "handoff/SKILL.md")           # not a tenant skill
        self.allowed("Read", file_path=CWD + "/README.md")

    def test_same_rule_for_edit_write_glob_grep(self):
        self.prompt(CHAN % "111")
        self.denied("Edit", file_path=SK + "tenant-y-tool/SKILL.md", old_string="a", new_string="b")
        self.denied("Write", file_path=SK + "tenant-y-tool/x.md", content="a")
        self.denied("Grep", pattern="foo", path=SK + "tenant-y-tool")
        self.denied("Glob", pattern=SK + "tenant-y-tool/**/*.sh")
        self.allowed("Grep", pattern="foo", path=SK + "tenant-x-demo")

    def test_path_tricks_are_normalized(self):
        self.prompt(CHAN % "111")
        self.denied("Read", file_path=SK + "tenant-x-demo/../tenant-y-tool/SKILL.md")
        self.denied("Read", file_path=".claude/skills/tenant-y-tool/SKILL.md")   # relative to the agent cwd
        self.denied("Read", file_path=CWD + "/.claude/skills/./tenant-y-tool/SKILL.md")

    def test_odd_id_maps_to_its_sanitized_directory(self):
        self.prompt(CHAN % "111")
        self.denied("Read", file_path=SK + "acme-odd-id/SKILL.md")

    def test_default_context_cannot_read_tenant_skill_files(self):
        self.prompt("operator")
        self.denied("Read", file_path=SK + "tenant-x-demo/SKILL.md")

    def test_a_search_rooted_above_the_skills_dirs_is_allowed(self):
        self.prompt(CHAN % "111")
        self.allowed("Grep", pattern="foo", path=CWD)
        self.allowed("Glob", pattern="**/*.md", path=CWD)


class TestBash(Base):
    def test_command_naming_a_foreign_skill_dir_is_blocked_best_effort(self):
        self.prompt(CHAN % "111")
        self.denied("Bash", command="cat %stenant-y-tool/SKILL.md" % SK)
        self.denied("Bash", command="bash .claude/skills/tenant-y-tool/scripts/run.sh --go")
        self.denied("Bash", command="cd x && python3 ~/.claude/skills/tenant-y-tool/run.py")
        self.allowed("Bash", command="bash .claude/skills/tenant-x-demo/scripts/run.sh")
        self.allowed("Bash", command="ls %s" % SK.rstrip("/"))    # listing the skills root is not naming a dir

    def test_ordinary_commands_never_touch_the_gate_state(self):
        self.prompt(CHAN % "222")
        self.allowed("Bash", command="grep -rn skills docs | head")
        self.allowed("Bash", command="git log --oneline")


if __name__ == "__main__":
    unittest.main()
