#!/usr/bin/env python3
"""scripts/gate-onfailure-check.py: a PreToolUse gate entry without onFailure "block", or a claude older than 2.1.295, FAILs.

The check reads the tracked project settings, every sub-agent's settings and the user-level settings, and the
installed claude version. Nothing is written. The gate list is the one in src/web/agent-scaffold-hooks.ts
(GATE_HOOK_SCRIPTS); a test keeps the two equal so a gate added on one side cannot be missed on the other.
"""
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, "scripts", "gate-onfailure-check.py")


def load():
    spec = importlib.util.spec_from_file_location("gate_onfailure_check", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


MOD = load()


def gate_cmd(script):
    return "command -v python3 >/dev/null 2>&1 || { echo 'x: DENY' >&2; exit 2; }; python3 \"/p/scripts/hooks/%s\"" % script


def settings(*hooks, other=None):
    ptu = [{"matcher": "Bash", "hooks": [h]} for h in hooks]
    cfg = {"hooks": {"PreToolUse": ptu}}
    if other:
        cfg["hooks"].update(other)
    return cfg


def gate(script="destructive-gate.py", on_failure="block"):
    h = {"type": "command", "command": gate_cmd(script), "timeout": 10}
    if on_failure is not None:
        h["onFailure"] = on_failure
    return h


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "root")
        self.home = os.path.join(self.tmp.name, "home")
        os.makedirs(os.path.join(self.root, ".claude"))
        os.makedirs(os.path.join(self.root, "agents"))
        os.makedirs(os.path.join(self.home, ".claude"))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, cfg):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(cfg if isinstance(cfg, str) else json.dumps(cfg))

    def project(self, cfg):
        self.write(os.path.join(self.root, ".claude", "settings.json"), cfg)

    def agent(self, name, cfg):
        self.write(os.path.join(self.root, "agents", name, ".claude", "settings.json"), cfg)

    def user(self, cfg):
        self.write(os.path.join(self.home, ".claude", "settings.json"), cfg)

    def run_check(self, version=(2, 1, 310), reason=""):
        return MOD.check(self.root, self.home, version, reason)

    def by(self, results, subject):
        return [(r["level"], r["message"]) for r in results if r["subject"] == subject]

    def test_all_gates_with_the_field_is_ok(self):
        self.project(settings(gate("destructive-gate.py"), gate("auth-admin-gate.py")))
        self.agent("a1", settings(gate("tenant-skill-gate.py")))
        self.user(settings(gate("egress-gate.mjs")))
        res = self.run_check()
        for subject in ("claude", "project settings", "agent a1", "user settings"):
            self.assertEqual([lvl for lvl, _ in self.by(res, subject)], ["OK"], subject)
        self.assertFalse([r for r in res if r["level"] == "FAIL"])

    def test_a_gate_without_the_field_or_with_continue_fails_per_file(self):
        self.project(settings(gate("destructive-gate.py", None)))
        self.agent("a1", settings(gate("auth-admin-gate.py", "continue"), gate("tenant-skill-gate.py")))
        self.user(settings(gate("egress-gate.mjs", None)))
        res = self.run_check()
        self.assertEqual([lvl for lvl, _ in self.by(res, "project settings")], ["FAIL"])
        msg = self.by(res, "agent a1")[0]
        self.assertEqual(msg[0], "FAIL")
        self.assertIn("1 of 2 gate entries without onFailure", msg[1])
        self.assertIn("startup backfill", msg[1])          # a sub-agent is fixed by the dashboard restart
        usr = self.by(res, "user settings")[0]
        self.assertEqual(usr[0], "FAIL")
        self.assertIn("by hand", usr[1])                    # the scaffold never writes the user-level file

    def test_the_main_agents_own_settings_file_is_a_hand_edit_not_a_dashboard_restart(self):
        # agents/<main>/.claude/settings.json is the cwd file of the main agent's second session; the startup
        # backfill skips the main agent (refuseMainAgentHookWrite), so "restart the dashboard" would be untrue.
        self.agent("jarvis", settings(gate("destructive-gate.py", None)))
        self.agent("a1", settings(gate("destructive-gate.py", None)))
        res = MOD.check(self.root, self.home, (2, 1, 310), "", main_agent="jarvis")
        main = self.by(res, "agent jarvis")[0]
        self.assertEqual(main[0], "FAIL")
        self.assertIn("main agent: not written by the dashboard", main[1])
        self.assertIn("add onFailure:block by hand", main[1])
        self.assertNotIn("install-", main[1])                      # no installer writes a gate entry
        self.assertNotIn("restart the dashboard", main[1])
        other = self.by(res, "agent a1")[0]
        self.assertIn("restart the dashboard", other[1])           # a sub-agent is unchanged
        self.assertNotIn("main agent", other[1])

    def test_the_main_agent_id_comes_from_the_environment_then_dotenv_then_the_default(self):
        saved = os.environ.pop("MAIN_AGENT_ID", None)
        try:
            self.assertEqual(MOD.main_agent_id(self.root), "marveen")
            self.write(os.path.join(self.root, ".env"), "A=1\nMAIN_AGENT_ID=\"jarvis\"\n")
            self.assertEqual(MOD.main_agent_id(self.root), "jarvis")
            os.environ["MAIN_AGENT_ID"] = "other"
            self.assertEqual(MOD.main_agent_id(self.root), "other")
            # check() without an explicit main_agent uses it
            os.environ["MAIN_AGENT_ID"] = "a1"
            self.agent("a1", settings(gate("destructive-gate.py", None)))
            self.assertIn("main agent:", self.by(self.run_check(), "agent a1")[0][1])
        finally:
            os.environ.pop("MAIN_AGENT_ID", None)
            if saved is not None:
                os.environ["MAIN_AGENT_ID"] = saved

    def test_a_non_gate_hook_is_ignored_and_a_file_without_gates_is_info(self):
        logger = {"type": "command", "command": 'python3 "/p/scripts/hooks/tool-log-capture.py"', "timeout": 5}
        self.project(settings(gate("destructive-gate.py"), logger, other={"PostToolUse": [{"hooks": [dict(gate("destructive-gate.py", None))]}]}))
        self.agent("a1", settings(logger))
        res = self.run_check()
        self.assertEqual([lvl for lvl, _ in self.by(res, "project settings")], ["OK"])     # PostToolUse is not looked at
        self.assertEqual([lvl for lvl, _ in self.by(res, "agent a1")], ["INFO"])

    def test_every_gate_script_is_recognised_by_basename_only(self):
        for script in MOD.GATE_SCRIPTS:
            with self.subTest(script=script):
                self.assertTrue(MOD.is_gate_command('x "/p/scripts/hooks/%s"' % script))
                self.assertFalse(MOD.is_gate_command('x "/p/scripts/hooks/my-%s.bak"' % script.split(".")[0]))
        self.assertFalse(MOD.is_gate_command('python3 "/p/scripts/hooks/tool-log-capture.py"'))

    def test_missing_project_settings_and_unreadable_files_fail_an_absent_agent_or_user_file_does_not(self):
        res = self.run_check()                                  # no project settings written at all
        self.assertEqual([lvl for lvl, _ in self.by(res, "project settings")], ["FAIL"])
        self.project(settings(gate()))
        self.agent("broken", "{ not json")
        res = self.run_check()
        self.assertEqual([lvl for lvl, _ in self.by(res, "agent broken")], ["FAIL"])
        self.assertEqual(self.by(res, "user settings"), [])    # no user-level file: nothing to check

    def test_the_claude_version_gate(self):
        self.project(settings(gate()))
        cases = [((2, 1, 294), "FAIL"), ((2, 1, 295), "OK"), ((2, 1, 310), "OK"), ((2, 0, 999), "FAIL"), ((3, 0, 0), "OK"), (None, "WARN")]
        for version, level in cases:
            with self.subTest(version=version):
                res = self.run_check(version, "cannot run `claude --version`")
                self.assertEqual([lvl for lvl, _ in self.by(res, "claude")], [level])

    def test_parse_version(self):
        self.assertEqual(MOD.parse_version("2.1.310 (Claude Code)"), (2, 1, 310))
        self.assertIsNone(MOD.parse_version("claude: command not found"))
        self.assertIsNone(MOD.parse_version(""))

    def test_the_gate_list_equals_the_one_in_the_scaffold(self):
        with open(os.path.join(ROOT, "src", "web", "agent-scaffold-hooks.ts"), encoding="utf-8") as f:
            ts = f.read()
        block = re.search(r"export const GATE_HOOK_SCRIPTS: readonly string\[\] = \[(.*?)\]", ts, re.S).group(1)
        self.assertEqual(sorted(re.findall(r"'([^']+)'", block)), sorted(MOD.GATE_SCRIPTS))


class CliTest(unittest.TestCase):
    def run_cli(self, version_text, cfg):
        with tempfile.TemporaryDirectory() as tmp:
            root, home, bindir = (os.path.join(tmp, d) for d in ("root", "home", "bin"))
            for d in (os.path.join(root, ".claude"), os.path.join(root, "agents"), home, bindir):
                os.makedirs(d)
            with open(os.path.join(root, ".claude", "settings.json"), "w") as f:
                json.dump(cfg, f)
            fake = os.path.join(bindir, "claude")
            with open(fake, "w") as f:
                f.write("#!/bin/sh\necho '%s'\n" % version_text)
            os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
            env = {"PATH": bindir + ":/usr/bin:/bin", "HOME": home}
            p = subprocess.run([sys.executable, "-I", SCRIPT, "--root", root, "--home", home, "--json"], capture_output=True, text=True, env=env)
            return p.returncode, json.loads(p.stdout)

    def test_exit_code_follows_the_fail_count(self):
        code, out = self.run_cli("2.1.310 (Claude Code)", settings(gate()))
        self.assertEqual((code, out["fail"]), (0, 0))
        code, out = self.run_cli("2.1.310 (Claude Code)", settings(gate(on_failure=None)))
        self.assertEqual((code, out["fail"]), (1, 1))
        code, out = self.run_cli("2.1.100 (Claude Code)", settings(gate()))
        self.assertEqual((code, out["fail"]), (1, 1))
        code, out = self.run_cli("no version here", settings(gate()))
        self.assertEqual((code, out["fail"], out["warn"]), (0, 0, 1))


if __name__ == "__main__":
    unittest.main()
