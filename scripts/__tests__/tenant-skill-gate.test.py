#!/usr/bin/env python3
"""Tests for scripts/hooks/tenant-skill-gate.py (PreToolUse), fed by tenant-context.py (UserPromptSubmit).

A tenant's skills may only be used in that tenant's requests; fleet skills always. Fail closed on a
missing/unknown/conflicting/stale context and on gate errors. Neutral fixtures only.
"""
import json
import os
import shutil
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
    "CREATE TABLE tenants (id TEXT PRIMARY KEY, main_agent_id TEXT, disabled_at INTEGER)",
    "CREATE TABLE tenant_agent_availability (tenant_id TEXT, agent_id TEXT, enabled INTEGER DEFAULT 1)",
]


def make_db(path):
    con = sqlite3.connect(path)
    with open(os.path.join(ROOT, "src", "migrations", "0065_agent_tenant_context.sql")) as f:
        con.executescript(f.read())   # the table belongs to the migration; the hooks never create it
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
    con.execute("INSERT INTO tenants VALUES ('tenant-x',NULL,NULL)")
    con.execute("INSERT INTO tenants VALUES ('tenant-y',NULL,NULL)")
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
        tcl.write_context(con, "agent-a", status, tenant, "test", "s")
        con.execute("UPDATE agent_tenant_context SET updated_at = ? WHERE agent_id = 'agent-a'", (int(time.time()) - age,))
        con.commit(); con.close()

    def gate(self, tool, **inp):
        hooks = getattr(self, "hooks", HOOKS)   # a mutated copy of the hooks directory in the mutation tests
        return subprocess.run([sys.executable, os.path.join(hooks, "tenant-skill-gate.py")],
                              input=json.dumps({"tool_name": tool, "tool_input": inp, "cwd": getattr(self, "cwd", CWD)}),
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

    def test_tenant_disabled_after_the_prompt_is_denied_at_once(self):
        self.prompt(CHAN % "111")
        self.allowed("Skill", skill="tenant-x-demo")
        con = sqlite3.connect(self.db)
        con.execute("UPDATE tenants SET disabled_at=5 WHERE id='tenant-x'")
        con.commit(); con.close()
        self.denied("Skill", skill="tenant-x-demo")

    def test_missing_context_table_denies_tenant_skills_and_creates_nothing(self):
        self.prompt(CHAN % "111")
        con = sqlite3.connect(self.db)
        con.execute("DROP TABLE agent_tenant_context")
        con.commit(); con.close()
        self.denied("Skill", skill="tenant-x-demo")
        self.allowed("Skill", skill="global/handoff")
        con = sqlite3.connect(self.db)
        names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE name='agent_tenant_context'")]
        con.close()
        self.assertEqual(names, [])

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


ALIAS = CWD + "/.claude-config/skills/"   # the config alias the harness gives each agent


class TestConfigAlias(Base):
    """The .claude-config/skills/<dir> alias (a symlink onto the global root) is a skill directory too."""

    def test_read_through_the_alias_is_judged_like_the_real_path(self):
        self.prompt(CHAN % "111")
        self.denied("Read", file_path=ALIAS + "tenant-y-tool/SKILL.md")
        self.denied("Read", file_path=ALIAS + "tenant-y-tool/scripts/run.sh")
        self.allowed("Read", file_path=ALIAS + "tenant-x-demo/SKILL.md")      # own tenant
        self.allowed("Read", file_path=ALIAS + "tenant-y-shared/SKILL.md")    # granted
        self.allowed("Read", file_path=ALIAS + "handoff/SKILL.md")            # fleet skill, not gated
        self.allowed("Read", file_path=CWD + "/.claude-config/notes.md")

    def test_same_rule_for_edit_write_glob_grep_through_the_alias(self):
        self.prompt(CHAN % "111")
        self.denied("Edit", file_path=ALIAS + "tenant-y-tool/SKILL.md", old_string="a", new_string="b")
        self.denied("Write", file_path=ALIAS + "tenant-y-tool/x.md", content="a")
        self.denied("Grep", pattern="foo", path=ALIAS + "tenant-y-tool")
        self.denied("Glob", pattern=ALIAS + "tenant-y-tool/**/*.sh")
        self.allowed("Grep", pattern="foo", path=ALIAS + "tenant-x-demo")

    def test_relative_and_tilde_alias_paths(self):
        self.prompt(CHAN % "111")
        self.denied("Read", file_path=".claude-config/skills/tenant-y-tool/SKILL.md")        # relative to the agent cwd
        self.denied("Read", file_path=ALIAS + "tenant-x-demo/../tenant-y-tool/SKILL.md")
        self.denied("Read", file_path=CWD + "/.claude-config/./skills/tenant-y-tool/SKILL.md")
        self.denied("Read", file_path="~/.claude-config/skills/tenant-y-tool/SKILL.md")

    def test_bash_naming_an_alias_directory_is_blocked_best_effort(self):
        self.prompt(CHAN % "111")
        self.denied("Bash", command="cat %stenant-y-tool/SKILL.md" % ALIAS)
        self.denied("Bash", command="bash .claude-config/skills/tenant-y-tool/scripts/run.sh --go")
        self.denied("Bash", command="cd x && python3 ~/.claude-config/skills/tenant-y-tool/run.py")
        self.denied("Bash", command="head -n 5 '%stenant-y-tool/SKILL.md'" % ALIAS)
        self.allowed("Bash", command="cat %stenant-x-demo/SKILL.md" % ALIAS)
        self.allowed("Bash", command="ls %s" % ALIAS.rstrip("/"))    # listing the alias root names no directory

    def test_default_context_cannot_read_tenant_skill_files_through_the_alias(self):
        self.prompt("operator")
        self.denied("Read", file_path=ALIAS + "tenant-x-demo/SKILL.md")

    def test_a_config_directory_that_is_not_the_skills_alias_is_not_a_skill_dir(self):
        self.prompt(CHAN % "111")
        self.allowed("Read", file_path=CWD + "/.claude-config/projects/x/memory/MEMORY.md")
        self.allowed("Read", file_path=CWD + "/.claude-configs/skills/tenant-y-tool/SKILL.md")   # different name
        self.allowed("Bash", command="cat x.claude-config/skills/tenant-y-tool/SKILL.md")      # not a path component


class TestSymlinks(Base):
    """A symlink the textual patterns do not know is followed (realpath), for file tools and absolute shell words."""

    def setUp(self):
        super().setUp()
        self.real = os.path.join(self.tmp.name, "real", ".claude", "skills")
        for d in ("tenant-y-tool", "tenant-x-demo", "handoff"):
            os.makedirs(os.path.join(self.real, d))
            with open(os.path.join(self.real, d, "SKILL.md"), "w") as f:
                f.write("x")
        self.link = os.path.join(self.tmp.name, "innocent-name")
        os.symlink(self.real, self.link)

    def test_file_tools_follow_a_symlink_onto_the_skills_root(self):
        self.prompt(CHAN % "111")
        self.denied("Read", file_path=self.link + "/tenant-y-tool/SKILL.md")
        self.denied("Edit", file_path=self.link + "/tenant-y-tool/SKILL.md", old_string="a", new_string="b")
        self.denied("Grep", pattern="x", path=self.link + "/tenant-y-tool")
        self.allowed("Read", file_path=self.link + "/tenant-x-demo/SKILL.md")
        self.allowed("Read", file_path=self.link + "/handoff/SKILL.md")

    def test_a_symlink_to_one_tenant_directory_is_followed(self):
        self.prompt(CHAN % "111")
        one = os.path.join(self.tmp.name, "shortcut")
        os.symlink(os.path.join(self.real, "tenant-y-tool"), one)
        self.denied("Read", file_path=one + "/SKILL.md")

    def test_absolute_shell_words_follow_a_symlink(self):
        self.prompt(CHAN % "111")
        self.denied("Bash", command="cat %s/tenant-y-tool/SKILL.md" % self.link)
        self.denied("Bash", command="cd x && python3 '%s/tenant-y-tool/SKILL.md'" % self.link)
        self.allowed("Bash", command="cat %s/tenant-x-demo/SKILL.md" % self.link)
        self.allowed("Bash", command="cat %s/handoff/SKILL.md" % self.link)

    def test_a_broken_or_missing_link_target_does_not_crash_the_gate(self):
        self.prompt(CHAN % "111")
        os.symlink(os.path.join(self.tmp.name, "nowhere"), os.path.join(self.tmp.name, "dangling"))
        self.allowed("Read", file_path=os.path.join(self.tmp.name, "dangling", "SKILL.md"))
        self.allowed("Bash", command="cat %s/nope/SKILL.md" % os.path.join(self.tmp.name, "dangling"))

    def test_a_malformed_path_never_crashes_the_gate(self):
        self.prompt(CHAN % "111")
        self.assertIn(self.gate("Read", file_path="/a\x00b/skills/x").returncode, (0, 2))


class TestShellFormsAndCase(Base):
    """Quoting, escaping, letter case and word count must not hide a skill directory from the gate."""

    def setUp(self):
        super().setUp()
        self.prompt(CHAN % "111")
        self.real = os.path.join(self.tmp.name, "real", ".claude", "skills")
        os.makedirs(os.path.join(self.real, "tenant-y-tool"))
        self.link = os.path.join(self.tmp.name, "innocent-name")
        os.symlink(self.real, self.link)

    def test_shell_quoting_that_splits_the_path_text_is_read_as_the_shell_reads_it(self):
        self.denied("Bash", command="cat '%s/.cla'ude/skills/tenant-y-tool/SKILL.md" % CWD)
        self.denied("Bash", command='cat "%s/.cla""ude/skills/tenant-y-tool/SKILL.md"' % CWD)
        self.denied("Bash", command="cat %s/\\.claude/skills/tenant-y-tool/SKILL.md" % CWD)
        self.denied("Bash", command="cat %s/.claude/skills/ten'ant-y-to'ol/SKILL.md" % CWD)
        self.allowed("Bash", command="cat '%s/.cla'ude/skills/tenant-x-demo/SKILL.md" % CWD)   # own tenant

    def test_a_command_shlex_cannot_parse_is_still_judged_textually_and_not_blocked_for_it(self):
        self.allowed("Bash", command="echo it's fine")
        self.denied("Bash", command="echo it's; cat %s/.claude/skills/tenant-y-tool/SKILL.md" % CWD)

    def test_letter_case_does_not_hide_a_directory(self):
        self.denied("Read", file_path=CWD + "/.claude/SKILLS/tenant-y-tool/SKILL.md")
        self.denied("Read", file_path=CWD + "/.CLAUDE-CONFIG/Skills/tenant-y-tool/SKILL.md")
        self.denied("Read", file_path=SK + "Tenant-Y-Tool/SKILL.md")
        self.denied("Bash", command="cat %sTENANT-Y-TOOL/SKILL.md" % SK)
        self.denied("Bash", command="cat %s/.Claude/Skills/tenant-y-tool/SKILL.md" % CWD)
        self.allowed("Read", file_path=SK + "TENANT-X-DEMO/SKILL.md")    # own tenant, any case
        self.allowed("Read", file_path=SK + "Handoff/SKILL.md")           # fleet skill

    def test_the_link_word_is_found_among_many_path_words(self):
        words = " ".join("/nonexistent/path%d" % i for i in range(60))
        self.denied("Bash", command="cat %s %s/tenant-y-tool/SKILL.md" % (words, self.link))

    def test_a_relative_symlink_is_followed_from_the_session_cwd(self):
        cwd = os.path.join(self.tmp.name, "agent-a")      # basename = the agent id the context belongs to
        os.makedirs(cwd)
        os.symlink(self.real, os.path.join(cwd, "shortcut"))
        self.cwd = cwd
        self.denied("Bash", command="cat shortcut/tenant-y-tool/SKILL.md")
        self.denied("Bash", command="cat ./shortcut/tenant-y-tool/SKILL.md")
        self.denied("Read", file_path="shortcut/tenant-y-tool/SKILL.md")
        self.allowed("Bash", command="cat shortcut/handoff/SKILL.md")


class TestGateMutations(Base):
    """Each guard added for the alias fail-open is load-bearing: a mutated copy of the hooks must let one of the
    must-block calls through."""

    def setUp(self):
        super().setUp()
        self.real = os.path.join(self.tmp.name, "real", ".claude", "skills")
        os.makedirs(os.path.join(self.real, "tenant-y-tool"))
        self.link = os.path.join(self.tmp.name, "innocent-name")
        os.symlink(self.real, self.link)
        self.hooks = os.path.join(self.tmp.name, "hooks-copy")
        shutil.copytree(HOOKS, self.hooks, ignore=shutil.ignore_patterns("__pycache__"))
        self.prompt(CHAN % "111")

    def calls(self):
        return {
            "alias_read": ("Read", dict(file_path=ALIAS + "tenant-y-tool/SKILL.md")),
            "alias_edit": ("Edit", dict(file_path=ALIAS + "tenant-y-tool/SKILL.md", old_string="a", new_string="b")),
            "alias_grep": ("Grep", dict(pattern="x", path=ALIAS + "tenant-y-tool")),
            "alias_bash": ("Bash", dict(command="cat %stenant-y-tool/SKILL.md" % ALIAS)),
            "link_read": ("Read", dict(file_path=self.link + "/tenant-y-tool/SKILL.md")),
            "link_bash": ("Bash", dict(command="cat %s/tenant-y-tool/SKILL.md" % self.link)),
            "case_root": ("Read", dict(file_path=CWD + "/.claude/SKILLS/tenant-y-tool/SKILL.md")),
            "case_dir": ("Read", dict(file_path=SK + "Tenant-Y-Tool/SKILL.md")),
            "quote_bash": ("Bash", dict(command="cat '%s/.cla'ude/skills/tenant-y-tool/SKILL.md" % CWD)),
        }

    def patch(self, fname, old, new):
        path = os.path.join(self.hooks, fname)
        with open(path) as f:
            src = f.read()
        self.assertIn(old, src, "mutation anchor drifted")
        with open(path, "w") as f:
            f.write(src.replace(old, new, 1))

    def survivors(self):
        return [name for name, (tool, inp) in self.calls().items() if self.gate(tool, **inp).returncode == 0]

    def test_unmutated_copy_blocks_every_call(self):
        self.assertEqual(self.survivors(), [])

    def test_removing_the_alias_from_the_pattern_is_caught(self):
        self.patch("tenant_context_lib.py", "\\.claude(?:-config)?/skills/", "\\.claude/skills/")
        self.assertIn("alias_read", self.survivors())
        self.assertIn("alias_bash", self.survivors())

    def test_removing_the_realpath_variant_is_caught(self):
        self.patch("tenant-skill-gate.py", "if resolve:", "if False:")
        self.assertIn("link_read", self.survivors())
        self.assertIn("link_bash", self.survivors())

    def test_file_tools_not_resolving_is_caught(self):
        self.patch("tenant-skill-gate.py", 'cwd, resolve=True)]\n    elif tool in ("Glob"', 'cwd)]\n    elif tool in ("Glob"')
        self.assertIn("link_read", self.survivors())

    def test_bash_not_resolving_words_is_caught(self):
        self.patch("tenant-skill-gate.py", "skill_dirs_in(word, cwd, resolve=True)", "skill_dirs_in(word, cwd)")
        self.assertEqual(self.survivors(), ["link_bash"])

    def test_dropping_the_bash_word_scan_is_caught(self):
        self.patch("tenant-skill-gate.py", "    for word in words:", "    for word in []:")
        self.assertEqual(sorted(self.survivors()), ["link_bash", "quote_bash"])

    def test_dropping_the_shell_dequoting_is_caught(self):
        self.patch("tenant-skill-gate.py", "        return list(lex)", "        return []")
        self.assertEqual(self.survivors(), ["quote_bash"])

    def test_case_sensitive_pattern_is_caught(self):
        self.patch("tenant_context_lib.py", ", re.IGNORECASE)", ")")
        self.assertIn("case_root", self.survivors())

    def test_case_sensitive_directory_compare_is_caught(self):
        self.patch("tenant-skill-gate.py", '(s["dir"] or "").casefold() == value.casefold()', 's["dir"] == value')
        self.assertIn("case_dir", self.survivors())


if __name__ == "__main__":
    unittest.main()
