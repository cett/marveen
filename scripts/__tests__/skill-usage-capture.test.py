#!/usr/bin/env python3
"""Unit tests for scripts/hooks/skill-usage-capture.py.

Tests cover _classify() / _classify_all() (what counts as a skill use and under
which source), _agent_id_from_cwd() (which agent), a mutation harness that proves
every guard in the classifier is load-bearing, and one end-to-end run of the hook
against a stub dashboard.

Privacy: only fake agent IDs (agent-a, agent-b) and synthetic paths are used.
"""
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "skill-usage-capture.py",
)


def _load(source_text=None):
    """Import the hook module; with source_text, a (mutated) copy of it."""
    spec = importlib.util.spec_from_file_location("skill_usage_capture", _HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    if source_text is None:
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    else:
        mod.__file__ = _HOOK_PATH
        exec(compile(source_text, _HOOK_PATH, "exec"), mod.__dict__)
    return mod


hook = _load()

# ---------------------------------------------------------------------------
# The decision tables. (tool, tool_input, expected (skill, trigger_type, source))
# ---------------------------------------------------------------------------

HOME = "/home/agent-a"
SK = f"{HOME}/.claude/skills"


def bash(cmd):
    return ("Bash", {"command": cmd})


POSITIVE = [
    # Skill tool
    ("Skill", {"skill": "fleet-helper"}, ("fleet-helper", "tool_call", "skill_tool")),
    ("Skill", {"skill": "deep-research", "args": "x"}, ("deep-research", "tool_call", "skill_tool")),
    ("Skill", {"skill": "  fleet-helper  "}, ("fleet-helper", "tool_call", "skill_tool")),
    # Read tool: every skill root, any file inside
    ("Read", {"file_path": f"{SK}/fleet-helper/SKILL.md"}, ("fleet-helper", "skill_read", "read_tool")),
    ("Read", {"file_path": f"{SK}/fleet-helper/references/extra.md"}, ("fleet-helper", "skill_read", "read_tool")),
    ("Read", {"file_path": ".claude/skills/proj-skill/SKILL.md"}, ("proj-skill", "skill_read", "read_tool")),
    ("Read", {"file_path": "/inst/agents/agent-a/.claude-config/skills/cfg-skill/SKILL.md"}, ("cfg-skill", "skill_read", "read_tool")),
    ("Read", {"file_path": "/inst/agents/agent-a/.claude/skills/local-skill/SKILL.md"}, ("local-skill", "skill_read", "read_tool")),
    ("Read", {"file_path": "/home/Agent A/.claude/skills/spaced/SKILL.md"}, ("spaced", "skill_read", "read_tool")),
    # Bash read verbs
    (*bash(f"cat {SK}/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("cat ~/.claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("cat $HOME/.claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("cat .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("cat ./.claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("head -n 40 .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("tail -20 .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("sed -n '1,40p' .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("less .claude/skills/x/references/a.md"), ("x", "skill_read", "bash_read")),
    (*bash("bat .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("nl .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("awk '/name/' .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("grep pinned .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("rg pinned .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("grep -r pinned .claude/skills/x/"), ("x", "skill_read", "bash_read")),
    (*bash("cat /inst/agents/agent-a/.claude-config/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("cat /inst/agents/agent-a/.claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("FOO=1 cat .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("cd repo && cat .claude/skills/x/SKILL.md | head -5"), ("x", "skill_read", "bash_read")),
    (*bash("cat .claude/skills/x/SKILL.md 2>/dev/null"), ("x", "skill_read", "bash_read")),
    (*bash("echo hi; cat .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("echo \"$(date)\" && cat .claude/skills/x/SKILL.md"), ("x", "skill_read", "bash_read")),
    (*bash("echo $(cat .claude/skills/x/SKILL.md)"), ("x", "skill_read", "bash_read")),
    # Bash script runs
    (*bash("python3 .claude/skills/x/scripts/ci-wait.py --pr 1"), ("x", "skill_read", "bash_script")),
    (*bash("python3 -u .claude/skills/x/scripts/ci-wait.py"), ("x", "skill_read", "bash_script")),
    (*bash("python .claude/skills/x/scripts/a.py"), ("x", "skill_read", "bash_script")),
    (*bash("bash ./.claude/skills/x/scripts/y.sh"), ("x", "skill_read", "bash_script")),
    (*bash("sh .claude/skills/x/scripts/y.sh"), ("x", "skill_read", "bash_script")),
    (*bash("node .claude/skills/x/scripts/y.mjs"), ("x", "skill_read", "bash_script")),
    (*bash("npx tsx .claude/skills/x/scripts/y.ts"), ("x", "skill_read", "bash_script")),
    (*bash("./.claude/skills/x/scripts/y.sh --flag"), ("x", "skill_read", "bash_script")),
    (*bash("FOO=1 python3 .claude/skills/x/scripts/y.py"), ("x", "skill_read", "bash_script")),
    (*bash(f"python3 {SK}/x/scripts/y.py"), ("x", "skill_read", "bash_script")),
    (*bash("cd repo && python3 .claude/skills/x/scripts/y.py"), ("x", "skill_read", "bash_script")),
    # Skills API reads
    (*bash("curl -s http://localhost:3420/api/skills/sql/global%2Fx"), ("x", "skill_read", "api_read")),
    (*bash("curl -s -H 'Authorization: Bearer t' http://localhost:3420/api/skills/sql/agent%2Fagent-a%2Fx"), ("x", "skill_read", "api_read")),
    (*bash("curl -s http://localhost:3420/api/skills/sql/agent%2Fagent-b%2Fx/files/references%2Fa.md"), ("x", "skill_read", "api_read")),
    (*bash("curl -s http://localhost:3420/api/v1/skills/sql/global%2Fx"), ("x", "skill_read", "api_read")),
    (*bash("curl -s -X GET http://localhost:3420/api/skills/sql/global%2Fx"), ("x", "skill_read", "api_read")),
    (*bash("curl -s \"http://localhost:3420/api/skills/sql/global%2Fx?include=files\""), ("x", "skill_read", "api_read")),
    (*bash("curl -s -H \"Authorization: Bearer $(cat store/.dashboard-token)\" http://localhost:3420/api/skills/sql/global%2Fx"), ("x", "skill_read", "api_read")),
    (*bash("curl -s http://localhost:3420/api/skills/sql/tenant-x"), ("tenant-x", "skill_read", "api_read")),
]

NEGATIVE = [
    # not a tool we capture
    ("Write", {"file_path": f"{SK}/x/SKILL.md", "content": "x"}),
    ("Edit", {"file_path": f"{SK}/x/SKILL.md"}),
    ("WebSearch", {"query": "something"}),
    ("UnknownTool", {"key": "value"}),
    ("Skill", {"skill": ""}),
    ("Skill", {}),
    # Read: not a concrete skill file
    ("Read", {"file_path": "/some/other/file.md"}),
    ("Read", {}),
    ("Read", {"file_path": f"{SK}"}),
    ("Read", {"file_path": f"{SK}/x"}),
    ("Read", {"file_path": f"{SK}/*/SKILL.md"}),
    ("Read", {"file_path": f"{HOME}/.claude/skillsx/y/SKILL.md"}),
    ("Read", {"file_path": f"{HOME}/.claude-other/skills/x/SKILL.md"}),
    ("Read", {"file_path": f"{HOME}/.claude/skills/$VAR/SKILL.md"}),
    # Bash: listing, copying, editing, committing
    bash("echo hi"),
    bash(""),
    bash("ls ~/.claude/skills"),
    bash("ls .claude/skills/x"),
    bash("ls -la .claude/skills/x/scripts"),
    bash("cat .claude/skills/x"),
    bash("head .claude/skills/x/"),
    bash("stat .claude/skills/x/SKILL.md"),
    bash("wc -l .claude/skills/x/SKILL.md"),
    bash("find .claude/skills -name SKILL.md"),
    bash("du -sh ~/.claude/skills"),
    bash("grep -r foo ~/.claude/skills"),
    bash("grep -L \"^pinned:\" ~/.claude/skills/*/SKILL.md"),
    bash("cat ~/.claude/skills/*/SKILL.md"),
    bash("bash scripts/skill-index.sh"),
    bash("npx tsx scripts/regen-skills.ts --check"),
    bash("cp -r ~/.claude/skills /tmp/b"),
    bash("cp .claude/skills/x/SKILL.md /tmp/b"),
    bash("mv .claude/skills/x /tmp/b"),
    bash("tar czf b.tgz .claude/skills"),
    bash("rsync -a .claude/skills/ /tmp/b/"),
    bash("sed -i s/a/b/ .claude/skills/x/SKILL.md"),
    bash("sed -i.bak s/a/b/ .claude/skills/x/SKILL.md"),
    bash("sed -ni '1p' .claude/skills/x/SKILL.md"),
    bash("sed --in-place s/a/b/ .claude/skills/x/SKILL.md"),
    bash("git add .claude/skills/x"),
    bash("git diff -- .claude/skills/x/SKILL.md"),
    bash("git commit -m 'edit .claude/skills/x/SKILL.md'"),
    bash("rm -r .claude/skills/x"),
    bash("tee .claude/skills/x/SKILL.md"),
    bash("echo hi > .claude/skills/x/SKILL.md"),
    bash("echo hi >> .claude/skills/x/SKILL.md"),
    bash("cat notes.md > .claude/skills/x/SKILL.md"),
    bash("cat notes.md >.claude/skills/x/SKILL.md"),
    bash("python3 foo.py < .claude/skills/x/SKILL.md"),
    # Bash: quoted / heredoc text is data
    bash("echo \"cat .claude/skills/x/SKILL.md\""),
    bash("echo 'cat .claude/skills/x/SKILL.md'"),
    bash("echo \"done; cat .claude/skills/x/SKILL.md\""),
    bash("cat <<EOF\ncat .claude/skills/x/SKILL.md\nEOF"),
    bash("cat > notes.md <<'EOF'\npython3 .claude/skills/x/scripts/y.py\nEOF"),
    # Bash: runtime-built or non-script paths
    bash("cat $DIR/SKILL.md"),
    bash("cat .claude/skills/$NAME/SKILL.md"),
    bash("python3 .claude/skills/x/references/a.py"),
    bash("python3 -c \"print(1)\" .claude/skills/x/scripts/y.py"),
    bash("python3 -c \"open('.claude/skills/x/scripts/y.py')\""),
    # Bash: skills API that is not a plain read of one skill
    bash("curl -s http://localhost:3420/api/skills/sql"),
    bash("curl -s http://localhost:3420/api/skills/sql?limit=5"),
    bash("curl -s -X PUT http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -s -XPUT http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -s --request DELETE http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -s --request=POST http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -sX POST http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -s -d '{}' http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -s --data-raw '{}' http://localhost:3420/api/skills/sql/global%2Fx"),
    bash("curl -s http://localhost:3420/api/skills/sql/global%2F\\$X"),
    bash("curl -s http://localhost:3420/api/skills/sql/$ID"),
    bash("curl -s http://localhost:3420/api/skills/sql/global%2Fx/access"),
    bash("curl -s http://localhost:3420/api/memories?q=skills/sql/x"),
    bash("wget http://localhost:3420/api/skills/sql/global%2Fx"),
]


def _label(item):
    return f"{item[0]}:{json.dumps(item[1])[:90]}"


def _run_tables(mod):
    """Return the list of table cases a hook module gets wrong."""
    wrong = []
    for tool, tin, expected in POSITIVE:
        got = mod._classify(tool, tin)
        if got != expected:
            wrong.append(f"POS {_label((tool, tin))} -> {got!r}, want {expected!r}")
    for tool, tin in NEGATIVE:
        got = mod._classify(tool, tin)
        if got is not None:
            wrong.append(f"NEG {_label((tool, tin))} -> {got!r}")
    return wrong


class TestClassifyTables(unittest.TestCase):
    """_classify(tool_name, tool_input) -> (skill_name, trigger_type, source) | None"""

    def test_positive_cases(self):
        for tool, tin, expected in POSITIVE:
            with self.subTest(case=_label((tool, tin))):
                self.assertEqual(hook._classify(tool, tin), expected)

    def test_negative_cases(self):
        for tool, tin in NEGATIVE:
            with self.subTest(case=_label((tool, tin))):
                self.assertIsNone(hook._classify(tool, tin))

    def test_every_source_maps_to_its_trigger_type(self):
        self.assertEqual(hook.SOURCE_TRIGGER["skill_tool"], "tool_call")
        for src in ("read_tool", "bash_read", "bash_script", "api_read"):
            self.assertEqual(hook.SOURCE_TRIGGER[src], "skill_read")
        for _tool, _tin, (_name, trigger, source) in POSITIVE:
            self.assertEqual(hook.SOURCE_TRIGGER[source], trigger)

    def test_all_five_sources_are_exercised(self):
        self.assertEqual(
            {exp[2] for _t, _i, exp in POSITIVE},
            {"skill_tool", "read_tool", "bash_read", "bash_script", "api_read"},
        )

    def test_command_without_skills_path_exits_before_parsing(self):
        # The fast exit: a Bash call that names no skills/ part must not even be tokenised
        # (this hook fires on every Bash call of every agent).
        real = hook._segments
        hook._segments = lambda _c: (_ for _ in ()).throw(AssertionError("parsed"))
        try:
            self.assertEqual(hook._bash_hits("git status && npm test"), [])
            self.assertIsNone(hook._classify("Bash", {"command": "echo hi"}))
        finally:
            hook._segments = real

    def test_non_string_command_is_ignored(self):
        self.assertIsNone(hook._classify("Bash", {"command": None}))
        self.assertIsNone(hook._classify("Bash", {"command": ["cat", "x"]}))
        self.assertIsNone(hook._classify("Bash", {}))

    def test_unterminated_quote_does_not_crash(self):
        self.assertEqual(
            hook._classify("Bash", {"command": "cat .claude/skills/x/SKILL.md 'oops"}),
            ("x", "skill_read", "bash_read"),
        )

    def test_two_skills_in_one_command_are_both_logged(self):
        hits = hook._classify_all(
            "Bash", {"command": "cat .claude/skills/a/SKILL.md && cat .claude/skills/b/SKILL.md"}
        )
        self.assertEqual([h[0] for h in hits], ["a", "b"])

    def test_same_skill_twice_in_one_command_is_logged_once(self):
        hits = hook._classify_all(
            "Bash", {"command": "head .claude/skills/a/SKILL.md; tail .claude/skills/a/SKILL.md"}
        )
        self.assertEqual(len(hits), 1)

    def test_hits_per_command_are_capped(self):
        cmd = " && ".join(f"cat .claude/skills/s{i}/SKILL.md" for i in range(20))
        self.assertEqual(len(hook._classify_all("Bash", {"command": cmd})), hook._MAX_HITS)


# ---------------------------------------------------------------------------
# Mutation harness: each guard in the classifier is load-bearing. A mutated copy
# of the hook must get at least one table case wrong, or the table has a hole.
# ---------------------------------------------------------------------------

MUTATIONS = [
    (
        "the Bash branch is removed",
        [('elif tool_name == "Bash":', 'elif tool_name == "BashX":')],
    ),
    (
        "the sed -i exclusion is removed",
        [('if verb == "sed" and any(', 'if False and any(')],
    ),
    (
        "the skill-name pattern accepts globs and variables",
        [('_NAME = r"[A-Za-z0-9_][A-Za-z0-9_.@+-]*"', '_NAME = r"[^/\\s]+"')],
    ),
    (
        "the .claude-config alias is removed",
        [('(?:-config)?', '')],
    ),
    (
        "the curl method check is removed",
        [('if (method or "GET").upper() != "GET" or data:', 'if False:')],
    ),
    (
        "the curl body check is removed",
        [('if (method or "GET").upper() != "GET" or data:', 'if (method or "GET").upper() != "GET":')],
    ),
    (
        "the skills-API list exclusion is removed",
        [
            ('/skills/sql/([^/?#\\s]+)', '/skills/sql/?([^/?#\\s]*)'),
            ('if _NAME_OK.match(last):', 'if True:'),
        ],
    ),
    (
        "the redirect handling is removed",
        [('if _REDIRECT.match(t):', 'if False:')],
    ),
    (
        "quote tracking in the segment splitter is removed",
        [("elif c in \"'\\\"\":", 'elif False:')],
    ),
    (
        "heredoc bodies are no longer stripped",
        [('        if pending:\n            if line.strip()', '        if False:\n            if line.strip()')],
    ),
    (
        "the interpreter branch only trusts scripts/ no more",
        [('(m.group(2) or "").startswith("/scripts/"):\n            return [m.group(1)]', 'True:\n            return [m.group(1)]')],
    ),
    (
        "a skill directory itself counts for cat/head (not only grep/rg)",
        [('if rest in ("", "/") and verb not in _DIR_OK_VERBS:', 'if False:')],
    ),
    (
        "the Read branch stops matching the config alias path shape (any file, not only inside a dir)",
        [('_READ_RE = re.compile(_SKILL_DIR + r"/.+$")', '_READ_RE = re.compile(_SKILL_DIR)')],
    ),
]


class TestMutations(unittest.TestCase):
    def setUp(self):
        with open(_HOOK_PATH) as f:
            self.source = f.read()

    def test_unmutated_hook_passes_every_table_case(self):
        self.assertEqual(_run_tables(hook), [])

    def test_every_mutation_is_caught_by_the_tables(self):
        for name, replacements in MUTATIONS:
            with self.subTest(mutation=name):
                mutated = self.source
                for old, new in replacements:
                    self.assertIn(old, mutated, f"mutation anchor drifted: {old!r}")
                    mutated = mutated.replace(old, new)
                self.assertNotEqual(mutated, self.source)
                self.assertTrue(
                    _run_tables(_load(mutated)),
                    f"mutation survived (table has a hole): {name}",
                )


# ---------------------------------------------------------------------------
# Slash-command use (UserPromptSubmit): a prompt that starts with /<name>.
# ---------------------------------------------------------------------------

_SLASH_SKILLS = {
    "home": ["fleet-helper", "help", "clear"],   # global; help/clear collide with built-in commands
    "install": ["proj-skill"],                    # project-level
    "cwd": ["local-skill"],                       # agent-local
    "cfg": ["cfg-skill"],                         # .claude-config alias
}
SLASH_POSITIVE = [
    ("/fleet-helper", "fleet-helper"),
    ("/fleet-helper do the thing", "fleet-helper"),
    ("/fleet-helper\nsecond line", "fleet-helper"),
    ("/fleet-helper\targ", "fleet-helper"),
    ("/proj-skill", "proj-skill"),
    ("/local-skill with args", "local-skill"),
    ("/cfg-skill", "cfg-skill"),
]
SLASH_NEGATIVE = [
    "/clear",                    # built-in command
    "/help",                     # built-in, even though a skill directory of that name exists
    "/clear everything",
    "/rename new-name",
    "/compact",
    "/model opus",
    "/does-not-exist",           # no such skill
    "/does-not-exist some args",
    "/home/agent-a/notes.md",   # a path, not a command
    "/fleet-helper/extra",       # path-like continuation of an existing name
    "/fleet-helper.md",          # a file name, no such directory
    "/plugin:skill",             # plugin-qualified names have no directory here
    "//fleet-helper",
    "/",
    "",
    "fleet-helper",              # no slash
    "please run /fleet-helper",  # not at the start
    " /fleet-helper",            # leading whitespace
    "/*",
    "/$HOME",
    "/../fleet-helper",
]


def _slash_fixture():
    root = tempfile.mkdtemp(prefix="skill-usage-slash-")
    dirs = {
        "home": os.path.join(root, "home", ".claude", "skills"),
        "install": os.path.join(root, "install", ".claude", "skills"),
        "cwd": os.path.join(root, "cwd", ".claude", "skills"),
        "cfg": os.path.join(root, "cwd", ".claude-config", "skills"),
    }
    for key, names in _SLASH_SKILLS.items():
        for n in names:
            os.makedirs(os.path.join(dirs[key], n))
    return root


def _run_slash_tables(mod, root):
    home, install, cwd = (os.path.join(root, "home"), os.path.join(root, "install"), os.path.join(root, "cwd"))
    wrong = []
    for prompt, name in SLASH_POSITIVE:
        got = mod._classify_prompt(prompt, cwd, home, install)
        if got != [(name, "tool_call", "slash")]:
            wrong.append(f"POS {prompt!r} -> {got!r}")
    for prompt in SLASH_NEGATIVE:
        got = mod._classify_prompt(prompt, cwd, home, install)
        if got:
            wrong.append(f"NEG {prompt!r} -> {got!r}")
    for bad in (None, 5, ["/fleet-helper"], {"a": 1}):
        if mod._classify_prompt(bad, cwd, home, install):
            wrong.append(f"NEG non-string {bad!r}")
    return wrong


class TestSlashClassify(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _slash_fixture()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_tables(self):
        self.assertEqual(_run_slash_tables(hook, self.root), [])

    def test_each_positive_and_negative_case_individually(self):
        home, install, cwd = (os.path.join(self.root, "home"), os.path.join(self.root, "install"), os.path.join(self.root, "cwd"))
        for prompt, name in SLASH_POSITIVE:
            with self.subTest(positive=prompt):
                self.assertEqual(hook._classify_prompt(prompt, cwd, home, install), [(name, "tool_call", "slash")])
        for prompt in SLASH_NEGATIVE:
            with self.subTest(negative=prompt):
                self.assertEqual(hook._classify_prompt(prompt, cwd, home, install), [])

    def test_slash_maps_to_tool_call(self):
        self.assertEqual(hook.SOURCE_TRIGGER["slash"], "tool_call")

    def test_agent_local_skill_is_not_found_from_another_cwd(self):
        home, install = os.path.join(self.root, "home"), os.path.join(self.root, "install")
        self.assertEqual(hook._classify_prompt("/local-skill", os.path.join(self.root, "elsewhere"), home, install), [])

    def test_tool_classifier_ignores_prompts(self):
        self.assertIsNone(hook._classify("UserPromptSubmit", {"prompt": "/fleet-helper"}))


SLASH_MUTATIONS = [
    ("the slash match is removed", [('m = _SLASH_RE.match(prompt)\n    if not m:\n        return []', 'return []\n    m = None')]),
    ("the built-in command exclusion is removed", [('if name in _BUILTIN_COMMANDS:', 'if False:')]),
    ("the skill-exists check is removed", [('if not any(os.path.isdir(os.path.join(root, name)) for root in _skill_roots(cwd, home, install)):', 'if False:')]),
    ("the end-of-name boundary is removed", [('(?=\\s|$)")', '")')]),
    ("the .claude-config root is removed", [('roots.append(os.path.join(cwd, ".claude-config", "skills"))', 'pass')]),
    ("the agent-local root is removed", [('roots.append(os.path.join(cwd, ".claude", "skills"))', 'pass')]),
    ("the project-level root is removed", [('os.path.join(install, ".claude", "skills")]', '"/nonexistent-root"]')]),
    ("the non-string guard is removed", [('if not isinstance(prompt, str):\n        return []', 'pass')]),
]


class TestSlashMutations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _slash_fixture()
        with open(_HOOK_PATH) as f:
            cls.source = f.read()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_every_slash_mutation_is_caught(self):
        for name, replacements in SLASH_MUTATIONS:
            with self.subTest(mutation=name):
                mutated = self.source
                for old, new in replacements:
                    self.assertIn(old, mutated, f"mutation anchor drifted: {old!r}")
                    mutated = mutated.replace(old, new)
                try:
                    wrong = _run_slash_tables(_load(mutated), self.root)
                except Exception as exc:  # a mutant that crashes on the table is caught too
                    wrong = [f"raised {exc!r}"]
                self.assertTrue(wrong, f"mutation survived: {name}")

    def test_the_main_dispatch_is_covered_by_the_end_to_end_run(self):
        # Removing the prompt branch of main() is caught by TestHookEndToEnd.test_slash_prompt_posts_slash_source
        # (it needs the real script and a stub dashboard, so it is not a table mutation).
        self.assertIn('hits = _classify_prompt(payload.get("prompt"), cwd)', self.source)


class TestAgentIdFromCwd(unittest.TestCase):
    """_agent_id_from_cwd(cwd) derives the agent identity from the session cwd."""

    def _call(self, cwd):
        return hook._agent_id_from_cwd(cwd)

    def _install(self):
        return hook._install_dir()

    def test_agents_subdir_returns_agent_name(self):
        cwd = os.path.join(self._install(), "agents", "agent-a")
        self.assertEqual(self._call(cwd), "agent-a")

    def test_agents_subdir_nested_returns_first_segment(self):
        cwd = os.path.join(self._install(), "agents", "agent-b", "subdir")
        self.assertEqual(self._call(cwd), "agent-b")

    def test_install_root_returns_main_agent_id(self):
        result = self._call(self._install())
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_empty_cwd_returns_nonempty_string(self):
        result = self._call("")
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_trailing_slash_ignored(self):
        cwd_with_slash = os.path.join(self._install(), "agents", "agent-a") + "/"
        self.assertEqual(self._call(cwd_with_slash), "agent-a")


# ---------------------------------------------------------------------------
# End to end: the real script, a stub dashboard, a throwaway install tree.
# ---------------------------------------------------------------------------

class _Stub(http.server.BaseHTTPRequestHandler):
    posts: list = []

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", "0"))
        _Stub.posts.append({
            "path": self.path,
            "auth": self.headers.get("Authorization"),
            "body": json.loads(self.rfile.read(n) or b"{}"),
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *_a):
        pass


class TestHookEndToEnd(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="skill-usage-e2e-")
        os.makedirs(os.path.join(self.root, "scripts", "hooks"))
        os.makedirs(os.path.join(self.root, "store"))
        os.makedirs(os.path.join(self.root, "agents", "agent-a"))
        shutil.copy(_HOOK_PATH, os.path.join(self.root, "scripts", "hooks", "skill-usage-capture.py"))
        with open(os.path.join(self.root, "store", ".dashboard-token"), "w") as f:
            f.write("tok-123\n")
        _Stub.posts = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Stub)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.root, ignore_errors=True)

    def _run(self, payload):
        env = dict(os.environ, WEB_PORT=str(self.port))
        return subprocess.run(
            [sys.executable, os.path.join(self.root, "scripts", "hooks", "skill-usage-capture.py")],
            input=json.dumps(payload).encode(), env=env, timeout=20, capture_output=True,
        )

    def test_bash_script_run_posts_source_and_agent(self):
        r = self._run({
            "tool_name": "Bash",
            "tool_input": {"command": "python3 .claude/skills/x/scripts/ci-wait.py --pr 1"},
            "session_id": "sess-1",
            "cwd": os.path.join(self.root, "agents", "agent-a"),
        })
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(_Stub.posts), 1)
        post = _Stub.posts[0]
        self.assertEqual(post["path"], "/api/skill-usage")
        self.assertEqual(post["auth"], "Bearer tok-123")
        self.assertEqual(post["body"], {
            "agent_id": "agent-a", "skill_name": "x", "trigger_type": "skill_read",
            "session_id": "sess-1", "source": "bash_script",
        })

    def test_skill_tool_posts_tool_call(self):
        self._run({"tool_name": "Skill", "tool_input": {"skill": "fleet-helper"}, "session_id": "s",
                   "cwd": os.path.join(self.root, "agents", "agent-a")})
        self.assertEqual(len(_Stub.posts), 1)
        self.assertEqual(_Stub.posts[0]["body"]["trigger_type"], "tool_call")
        self.assertEqual(_Stub.posts[0]["body"]["source"], "skill_tool")

    def test_two_skills_in_one_command_post_twice(self):
        self._run({
            "tool_name": "Bash",
            "tool_input": {"command": "cat .claude/skills/a/SKILL.md && cat .claude/skills/b/SKILL.md"},
            "session_id": "s", "cwd": self.root,
        })
        self.assertEqual([p["body"]["skill_name"] for p in _Stub.posts], ["a", "b"])

    def test_irrelevant_bash_posts_nothing(self):
        r = self._run({"tool_name": "Bash", "tool_input": {"command": "ls ~/.claude/skills"},
                       "session_id": "s", "cwd": self.root})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(_Stub.posts, [])

    def test_no_token_posts_nothing_and_exits_zero(self):
        os.remove(os.path.join(self.root, "store", ".dashboard-token"))
        r = self._run({"tool_name": "Skill", "tool_input": {"skill": "x"}, "session_id": "s", "cwd": self.root})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(_Stub.posts, [])

    def test_dead_dashboard_never_blocks(self):
        self.server.shutdown()
        self.server.server_close()
        r = self._run({"tool_name": "Skill", "tool_input": {"skill": "x"}, "session_id": "s", "cwd": self.root})
        self.assertEqual(r.returncode, 0)
        # setUp's server is closed twice in tearDown; shutdown on a stopped server is a no-op wait
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Stub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def test_slash_prompt_posts_slash_source(self):
        os.makedirs(os.path.join(self.root, "agents", "agent-a", ".claude", "skills", "my-skill"))
        r = self._run({
            "hook_event_name": "UserPromptSubmit",
            "prompt": "/my-skill please",
            "session_id": "sess-9",
            "cwd": os.path.join(self.root, "agents", "agent-a"),
        })
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(_Stub.posts), 1)
        self.assertEqual(_Stub.posts[0]["body"], {
            "agent_id": "agent-a", "skill_name": "my-skill", "trigger_type": "tool_call",
            "session_id": "sess-9", "source": "slash",
        })

    def test_prompt_that_is_a_builtin_or_unknown_posts_nothing(self):
        for prompt in ("/clear", "/no-such-skill", "hello"):
            r = self._run({"hook_event_name": "UserPromptSubmit", "prompt": prompt, "session_id": "s",
                           "cwd": os.path.join(self.root, "agents", "agent-a")})
            self.assertEqual(r.returncode, 0)
        self.assertEqual(_Stub.posts, [])

    def test_garbage_stdin_exits_zero(self):
        env = dict(os.environ, WEB_PORT=str(self.port))
        r = subprocess.run(
            [sys.executable, os.path.join(self.root, "scripts", "hooks", "skill-usage-capture.py")],
            input=b"not json", env=env, timeout=20, capture_output=True,
        )
        self.assertEqual(r.returncode, 0)
        self.assertEqual(_Stub.posts, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
