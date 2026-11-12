#!/usr/bin/env python3
"""Tier B of scripts/hooks/secret-read-gate.py: the token files.

Tier A (the claim signing key) is covered by secret-read-gate.test.py and stays strict. Tier B is every token file
an agent has no business reading or overwriting:

    store/.operator-token  store/.dashboard-token  store/.claude-oauth-token  store/.claude-oauth-token.verified
    <install>/.agent-token                       (the main agent's)
    <install>/agents/<id>/.agent-token           (every id, the caller's own included; enumerated at decision time)

The gate runs as a subprocess inside a throw-away install tree, fed a JSON hook payload on stdin. Every refusal is
checked for exit 2 and the tier B reason on stderr (the file NAME only, generic wording, never a path or a token);
every allow for exit 0 and an empty stderr. Neutral fixtures only (agent-a, agent-b, ...).

  1. Every protected file x every way of reaching it: path, relative path, `..` segments, symlink, relative symlink,
     hard link, file:// URL, the file name from the caller's own cwd, a glob, a recursive reader over its directory.
  2. What must stay allowed: the DOTLESS spelling of a name, a name inside quoted free text or a grep pattern,
     `--exclude=<the name>` over a directory that holds only that token, the daily read commands over the tree.
  3. Fail closed: an unreadable agents directory, more entries than the bound, agents appearing between two calls.
  4. Tier A did not slip: its message and its strict text rule are unchanged.

Run: python3 <thisfile>   (SECRET_GATE_PATH names a gate file other than scripts/hooks/secret-read-gate.py)
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
GATE_SRC = os.environ.get('SECRET_GATE_PATH') or os.path.join(SCRIPTS, 'hooks', 'secret-read-gate.py')
TOKEN = 'tok-' + 'c3' * 16
KEY = 'a1' * 32
KEY_NAME = '.claim-signing-key'
GENERIC = 'a token file is not for an agent to read or change'

STORE_TOKENS = ['store/.operator-token', 'store/.dashboard-token', 'store/.claude-oauth-token', 'store/.claude-oauth-token.verified']
AGENT_DIRS = ['agent-a', 'agent-b', 'agent c d', '-dash', 'ünï', "o'q"]
AGENT_TOKENS = ['.agent-token'] + ['agents/%s/.agent-token' % d for d in AGENT_DIRS]
PROTECTED = STORE_TOKENS + AGENT_TOKENS          # relative to the install root
GHOST = 'agents/ghost'                             # an agent directory whose token file does not exist (yet)

MAX_AGENTS = int(re.search(r'^MAX_AGENTS = (\d+)', open(GATE_SRC, encoding='utf-8').read(), re.M).group(1))


def sh_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


class Tree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = os.path.realpath(tempfile.mkdtemp(prefix='secret-tokens-'))
        for rel in ['scripts/hooks', 'store', 'src', 'work', 'docs', GHOST] + ['agents/' + d for d in AGENT_DIRS]:
            os.makedirs(os.path.join(cls.root, rel))
        shutil.copy(GATE_SRC, os.path.join(cls.root, 'scripts/hooks/secret-read-gate.py'))
        cls.gate = os.path.join(cls.root, 'scripts/hooks/secret-read-gate.py')
        cls.write('store/' + KEY_NAME, KEY)
        for rel in PROTECTED:
            cls.write(rel, TOKEN)
        for rel, txt in [('store/rules.json', '{}'), ('src/a.ts', 'export const a = 1\n'), ('docs.md', 'the dashboard-token and agent-token docs\n'),
                         ('docs/agent-token.md', 'notes\n'), ('scripts/gmail-send.py', '# x\n'), ('agents/agent-a/CLAUDE.md', 'persona\n'),
                         ('agents/agent-b/CLAUDE.md', 'persona\n'), ('agents/agent-a/notes.txt', 'n\n')]:
            cls.write(rel, txt)
        cls.links = {}
        for i, rel in enumerate(PROTECTED):
            abs_p = os.path.join(cls.root, rel)
            sym, rsym, hard = 'work/sym-%d' % i, 'work/rsym-%d' % i, 'work/hard-%d.txt' % i
            os.symlink(abs_p, os.path.join(cls.root, sym))
            os.symlink(os.path.relpath(abs_p, os.path.join(cls.root, 'work')), os.path.join(cls.root, rsym))
            os.link(abs_p, os.path.join(cls.root, hard))
            cls.links[rel] = (sym, rsym, hard)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    @classmethod
    def write(cls, rel, text):
        with open(os.path.join(cls.root, rel), 'w', encoding='utf-8') as fh:
            fh.write(text)

    def p(self, *parts):
        return os.path.join(self.root, *parts)

    def run_gate(self, tool, tool_input, cwd=None, gate=None):
        payload = json.dumps({'tool_name': tool, 'tool_input': tool_input, 'cwd': cwd or self.root})
        p = subprocess.run([sys.executable, gate or self.gate], input=payload.encode(), capture_output=True,
                           env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.root}, timeout=30)
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')

    def bash(self, command, cwd=None):
        return self.run_gate('Bash', {'command': command}, cwd=cwd)

    def assert_denied_b(self, result, label='', name=None):
        rc, out, err = result
        self.assertEqual(rc, 2, '%s: expected a block, got rc=%s stderr=%r' % (label, rc, err))
        self.assertEqual(out, '')
        self.assertIn('SECRET READ GATE: BLOCKED', err)
        self.assertIn(GENERIC, err, label)
        if name:
            self.assertIn(name, err, label)
        # the reason carries the file NAME only: no path, no agent id, no content
        self.assertNotIn(self.root, err)
        self.assertNotIn(TOKEN, err)
        self.assertNotIn('agent-a', err)

    def assert_denied(self, result, label=''):
        rc, out, err = result
        self.assertEqual(rc, 2, '%s: expected a block, got rc=%s stderr=%r' % (label, rc, err))
        self.assertIn('SECRET READ GATE: BLOCKED', err)

    def assert_allowed(self, result, label=''):
        rc, out, err = result
        self.assertEqual((rc, out, err), (0, '', ''), label)


def upper_form(tree, rel):
    """The absolute path of the protected file `rel` with its file NAME upper-cased."""
    abs_p = tree.p(rel)
    return abs_p.replace(os.path.basename(abs_p), os.path.basename(abs_p).upper())


def fs_is_case_insensitive(tree, rel):
    """Probe, not a guess: does the fixture's own file system find the protected file `rel` under its upper-cased name?
    True on a default macOS volume (the upper-cased spelling is the SAME inode), False on Linux and on a case-sensitive
    volume (there it is a different file that does not exist)."""
    return os.path.lexists(upper_form(tree, rel))


def expects_block(tool, path, upper, insensitive):
    """Is the call expected to be blocked? The upper-cased spelling under a GENERIC key (`mcp__x__y {q: path}`, a key that
    is not path-like) is judged by realpath / device-inode resolution only, so it is the protected file only where the file
    system is case-insensitive; on a case-sensitive one it names a file that does not exist and is ALLOWED. Under a
    path-like key (`file_path`, `path`, `source`, ...) the dotted-name rule is case-insensitive and blocks it on either file
    system, and every other spelling resolves to the file everywhere."""
    return not (tool == 'mcp__x__y' and path == upper and not insensitive)


def forms(tree, rel):
    """Every way a path to the protected file `rel` can be spelled for a file tool, from the install root."""
    sym, rsym, hard = tree.links[rel]
    abs_p = tree.p(rel)
    return [abs_p, rel, './' + rel, tree.p('src', '..', rel), tree.p(os.path.dirname(rel) or '.', '.', os.path.basename(rel)),
            tree.p(sym), sym, tree.p(rsym), tree.p(hard), 'work/../' + rel, 'file://' + abs_p, 'FILE://localhost' + tree.p(hard),
            'file://' + tree.p(sym), upper_form(tree, rel)]


class FileToolsOnEveryTokenFile(Tree):
    def test_every_spelling_of_every_file_is_blocked(self):
        for rel in PROTECTED:
            upper, insensitive = upper_form(self, rel), fs_is_case_insensitive(self, rel)
            for path in forms(self, rel):
                for tool, ti in [('Read', {'file_path': path}), ('Write', {'file_path': path, 'content': 'x'}),
                                 ('mcp__filesystem__read_text_file', {'path': path}), ('mcp__x__y', {'q': path}),
                                 ('mcp__filesystem__move_file', {'source': self.p('work', 'a.txt'), 'destination': path})]:
                    with self.subTest(file=rel, path=path, tool=tool):
                        if expects_block(tool, path, upper, insensitive):
                            self.assert_denied_b(self.run_gate(tool, ti), '%s %s' % (tool, path), os.path.basename(rel))
                        else:
                            self.assert_allowed(self.run_gate(tool, ti), '%s %s (case-sensitive file system: another, missing file)' % (tool, path))

    def test_the_expectation_for_an_upper_cased_name_follows_the_file_system(self):
        # both branches of expects_block, without needing the two kinds of file system: only the generic key + the
        # upper-cased spelling + a case-sensitive file system flips to "allowed"
        up = '/t/.AGENT-TOKEN'
        self.assertTrue(expects_block('mcp__x__y', up, up, True))
        self.assertFalse(expects_block('mcp__x__y', up, up, False))
        for tool in ('Read', 'Write', 'mcp__filesystem__read_text_file', 'mcp__filesystem__move_file'):
            self.assertTrue(expects_block(tool, up, up, False), tool)      # a path-like key blocks on either file system
        self.assertTrue(expects_block('mcp__x__y', '/t/.agent-token', up, False))      # the lower-case spelling is the file itself

    def test_the_file_name_from_the_callers_own_cwd(self):
        for rel in PROTECTED:
            cwd = self.p(os.path.dirname(rel)) if os.path.dirname(rel) else self.root
            name = os.path.basename(rel)
            for tool, ti in [('Read', {'file_path': name}), ('Read', {'file_path': './' + name}), ('mcp__x__y', {'q': name}),
                             ('Edit', {'file_path': name, 'old_string': 'a', 'new_string': 'b'})]:
                with self.subTest(file=rel, tool=tool, ti=ti):
                    self.assert_denied_b(self.run_gate(tool, ti, cwd=cwd), '%s from %s' % (tool, cwd), name)

    def test_another_agents_token_from_an_agents_cwd(self):
        self.assert_denied_b(self.run_gate('Read', {'file_path': '../agent-b/.agent-token'}, cwd=self.p('agents', 'agent-a')), 'sibling')
        self.assert_denied_b(self.run_gate('Read', {'file_path': '../../.agent-token'}, cwd=self.p('agents', 'agent-a')), 'the main agent')
        self.assert_denied_b(self.run_gate('Read', {'file_path': '../../store/.operator-token'}, cwd=self.p('agents', 'agent-a')), 'store')

    def test_the_dotted_name_anywhere_is_blocked_for_file_tools_even_when_the_path_resolves_nowhere(self):
        for name in ('.operator-token', '.dashboard-token', '.claude-oauth-token', '.claude-oauth-token.verified', '.agent-token'):
            for path in ('/tmp/some-other-tree/' + name, 'nowhere/' + name, '../' + name.upper(), 'file:///tmp/x/' + name):
                for tool, ti in [('Read', {'file_path': path}), ('mcp__x__y', {'path': path}), ('Write', {'file_path': path, 'content': 'x'})]:
                    with self.subTest(tool=tool, path=path):
                        self.assert_denied_b(self.run_gate(tool, ti, cwd=self.p('src')), '%s %s' % (tool, path), name)

    def test_an_agent_id_with_unusual_characters(self):
        for d in ['agent c d', '-dash', 'ünï', "o'q"]:
            with self.subTest(agent=d):
                self.assert_denied_b(self.run_gate('Read', {'file_path': self.p('agents', d, '.agent-token')}), d)
                self.assert_denied_b(self.run_gate('Read', {'file_path': '.agent-token'}, cwd=self.p('agents', d)), d + ' from its cwd')
                self.assert_denied_b(self.bash('cat ' + sh_quote('agents/%s/.agent-token' % d)), d + ' bash')
                self.assert_denied_b(self.bash('grep -r x ' + sh_quote('agents/' + d)), d + ' recursive')

    def test_a_grep_or_glob_that_selects_a_token_file_is_blocked(self):
        for ti in [{'pattern': 'a', 'path': self.p('agents', 'agent-a'), 'glob': '.agent-token'}, {'pattern': 'a', 'path': 'agents', 'glob': '.agent-*'},
                   {'pattern': 'a', 'glob': '**/.agent-token'}, {'pattern': 'a', 'glob': '.*token'}, {'pattern': 'a', 'glob': '.agent-token', 'path': self.root},
                   {'pattern': 'a', 'path': self.p('agents', 'agent-a', '.agent-token')}, {'pattern': 'a', 'path': self.p('store'), 'glob': '.op*'},
                   {'pattern': 'a', 'path': self.p('agents', 'ghost'), 'glob': '.agent-t*'}]:
            with self.subTest(ti=ti):
                self.assert_denied(self.run_gate('Grep', ti), 'Grep %s' % ti)
        for ti in [{'pattern': 'agents/*/.agent-token'}, {'pattern': 'agents/**/.agent-*'}, {'pattern': '**/.agent-token'}, {'pattern': '*/.agent-token', 'path': self.p('agents', 'agent-a', '..')},
                   {'pattern': '.agent-*', 'path': self.p('agents', 'agent-a')}, {'pattern': self.p('agents', '*', '.agent-token')}, {'pattern': '.agent-token'},
                   {'pattern': 'agents/ghost/.agent-token'}, {'pattern': '../agents/agent-a/.agent-token', 'path': self.p('src')}]:
            with self.subTest(ti=ti):
                self.assert_denied(self.run_gate('Glob', ti, cwd=self.root), 'Glob %s' % ti)

    def test_ordinary_file_tool_calls_pass(self):
        for tool, ti in [('Read', {'file_path': self.p('agents', 'agent-a', 'CLAUDE.md')}), ('Read', {'file_path': 'agents/agent-b/CLAUDE.md'}),
                         ('Read', {'file_path': self.p('docs', 'agent-token.md')}), ('Read', {'file_path': self.p('docs.md'), 'offset': 1, 'limit': 5}),
                         ('Edit', {'file_path': self.p('src', 'a.ts'), 'old_string': 'a', 'new_string': 'b'}),
                         ('Write', {'file_path': self.p('work', 'notes.txt'), 'content': 'see .agent-token and .operator-token in the docs'}),
                         ('Grep', {'pattern': '.agent-token', 'path': self.p('src')}), ('Grep', {'pattern': 'dashboard-token', 'path': self.p('agents', 'agent-a')}),
                         ('Grep', {'pattern': 'a', 'path': self.p('agents', 'agent-a'), 'glob': '*.md'}), ('Grep', {'pattern': 'a', 'glob': 'src/**/*.ts'}),
                         ('Glob', {'pattern': 'agents/*/CLAUDE.md'}), ('Glob', {'pattern': 'agents/**/*.md'}), ('Glob', {'pattern': 'src/**/*.ts'}),
                         ('mcp__filesystem__list_directory', {'path': self.p('agents')}), ('mcp__filesystem__read_text_file', {'path': self.p('agents', 'agent-a', 'notes.txt')}),
                         ('mcp__x__y', {'text': 'the .agent-token file lives in each agent directory'}), ('mcp__x__y', {'q': 'dashboard-token'}),
                         ('mcp__plugin_telegram_telegram__reply', {'chat_id': '1', 'text': 'rotate the .operator-token\nlater'})]:
            with self.subTest(tool=tool, ti=ti):
                self.assert_allowed(self.run_gate(tool, ti), '%s %s' % (tool, ti))


class BashOnEveryTokenFile(Tree):
    def test_every_reader_of_every_file_is_blocked(self):
        for rel in PROTECTED:
            sym, rsym, hard = self.links[rel]
            q = sh_quote(rel)
            for cmd in ['cat ' + q, 'head -c 5 ' + q, 'base64 ' + q, 'cp %s /tmp/x' % q, 'echo x > ' + q, 'echo x >> ' + q, 'cat < ' + q, 'cat <' + q,
                        'echo $(cat %s)' % q, 'env X=1 cat ' + q, 'true && cat ' + q, 'xargs cat <<< ' + q, "python3 -c \"print(open('%s').read())\"" % rel,
                        'cat ' + sym, 'cat ' + rsym, 'cat ' + hard, 'cat work/../' + rel, 'cat ./' + rel, 'cat ' + self.p(rel), 'sed -n p ' + sym,
                        'cat file://' + self.p(rel), 'FILE=%s; true' % q, 'tar cf - ' + q, 'ln -s %s /tmp/k' % q]:
                with self.subTest(file=rel, cmd=cmd):
                    self.assert_denied_b(self.bash(cmd), cmd, os.path.basename(rel))

    def test_quoted_escaped_and_concatenated_name(self):
        for cmd in ["cat store/.operator-tok''en", 'cat store/.dashboard-""token', "cat store/.claude-oauth-'token'", 'cat store/.claude-oauth-token.ver\\ified',
                    "cat agents/agent-a/.agent-tok''en", 'cat "agents/agent-a/.agent-"\'token\'', 'cat agents/agent-a/.agent\\-token', 'cat agents/agent-a/.AGENT-TOKEN',
                    "cat agents/agent-a/$'.agent-token'"]:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_the_dotted_name_anywhere_is_blocked_even_when_the_path_resolves_nowhere(self):
        for cmd in ['cat nowhere/.agent-token', 'cat /tmp/some-other-tree/.operator-token', 'cat .dashboard-token', 'cat ../.claude-oauth-token.verified',
                    'cat "/tmp/x y/.agent-token"', 'echo .agent-token', 'cat .agent-token/', 'ls -l /nonexistent/.claude-oauth-token']:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_the_name_from_the_callers_own_cwd(self):
        for rel in PROTECTED:
            cwd = self.p(os.path.dirname(rel)) if os.path.dirname(rel) else self.root
            name = os.path.basename(rel)
            for cmd in ['cat ' + name, 'cat ./' + name, 'head -1 ' + sh_quote(name), 'cat < ' + name]:
                with self.subTest(file=rel, cmd=cmd):
                    self.assert_denied_b(self.bash(cmd, cwd=cwd), cmd, name)

    def test_globs_that_can_select_a_token_file_are_blocked(self):
        for cmd in ['cat store/.*', 'cat store/.[o]*', 'cat store/.op*', 'cat store/.[a-z]*-token', 'cat store/.claude-oauth-token*', 'cat store/.dashboard-?oken',
                    'cat agents/*/.agent-*', 'cat agents/agent-a/.agent-t*', 'cat agents/*/.*', 'cat .agent-*', 'cat agents/agent-?/.agent-token', 'cat agents/**/.agent-token',
                    'cat agents/*/.[[:lower:]]*', 'cat agents/ghost/.agent-*', 'cat agents/{agent-a,agent-b}/.agent-token', 'cat agents/ghost/.[a]gent-token',
                    'cat ./agents/*/.agent-token', 'cat ../agents/*/.agent-token', 'cat %s/agents/*/.agent-*' % self.root, 'cat agents/*/.[^x]*', 'cat store/.[!x]*-token',
                    'cat agents/*/*', 'cat store/*']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd, cwd=self.root if '..' not in cmd else self.p('src')), cmd)

    def test_globs_that_cannot_select_a_token_file_pass(self):
        for cmd in ['cat agents/*/CLAUDE.md', 'cat agents/agent-a/*.md', 'cat agents/*/notes.txt', 'cat src/*.ts', 'cat docs/*.md', 'cat store/rules.[^x]son',
                    'cat agents/agent-?/CLAUDE.md', 'cat agents/agent-[ab]/CLAUDE.md', 'ls agents/*', 'cat docs/agent-*.md']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_the_dotless_name_and_quoted_free_text_pass(self):
        for cmd in ['grep -rn dashboard-token src', 'grep -rn agent-token src docs', 'cat docs/agent-token.md', 'echo operator-token', 'echo dashboard-token agent-token',
                    'git log --grep=agent-token', 'git log --grep=.agent-token', 'git commit --dry-run -m "mention .agent-token and .dashboard-token in the docs"',
                    "grep -n '.agent-token' docs.md", 'grep -e .operator-token docs.md', 'grep -rn --include=.agent-token foo src', 'grep -rn -e .agent-token src',
                    "echo 'the .claude-oauth-token file is not for agents'", 'rg .agent-token src', 'rg -e .dashboard-token src docs', 'grep -rn "\\.agent-token" src',
                    'grep -c token docs.md', 'git log --oneline -3 -- docs/agent-token.md', 'curl -s localhost:3420/api/health']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_ten_daily_read_commands_over_the_tree_pass(self):
        for cmd, cwd in [('grep -rn foo src', None), ('grep -rn foo src scripts', None), ('git log --oneline -3', None), ('git show HEAD:docs.md', None),
                         ('sed -n 1,5p docs.md', None), ('cat agents/agent-a/CLAUDE.md', None), ('ls agents', None), ('ls -la agents/agent-a', None),
                         ('wc -l docs.md', None), ('find src -name "*.ts"', None), ('rg foo agents', None), ('cat store/rules.json', None),
                         ('grep -rn foo src', self.p('agents', 'agent-a')), ('ls', self.p('agents', 'agent-a')), ('cat CLAUDE.md', self.p('agents', 'agent-a')),
                         ('grep -n persona CLAUDE.md notes.txt', self.p('agents', 'agent-a')), ('git status --short', self.p('agents', 'agent-a')),
                         ('python3 scripts/gmail-send.py --help', None), ('bash scripts/agent-api.sh --token main GET /api/blackboard', None)]:
            with self.subTest(cmd=cmd, cwd=cwd):
                self.assert_allowed(self.bash(cmd, cwd=cwd), cmd)

    def test_recursive_readers_over_a_directory_that_holds_a_token_are_blocked(self):
        for cmd, cwd in [('grep -r foo agents', None), ('grep -rn foo agents/agent-a', None), ('grep -R foo agents/agent-b', None), ('grep -r foo .', self.p('agents', 'agent-a')),
                         ('grep -r foo', self.p('agents', 'agent-a')), ('grep -rn foo ..', self.p('agents', 'agent-a')), ('grep -r foo .', None), ('grep -r foo ' + self.root, None),
                         ('grep --recursive foo agents/agent-a', None), ('grep -d recurse foo agents', None), ('egrep -ri foo agents', None), ('grep -r foo agents/*', None),
                         ('cp -r agents /tmp/y', None), ('cp -a agents/agent-a /tmp/y', None), ('tar cf - agents', None), ('tar czf a.tgz agents/agent-b', None),
                         ('rsync -a agents /tmp/y', None), ('zip -r a.zip agents/agent-a', None), ('find agents -exec cat {} +', None), ('find . -exec cat {} +', self.p('agents', 'agent-a')),
                         ('rg --hidden foo agents', None), ('rg -uu foo agents/agent-a', None), ('rg --no-ignore foo agents', None), ('ag --unrestricted foo agents', None),
                         ('grep -r foo store', None), ('grep -rn foo src agents', None)]:
            with self.subTest(cmd=cmd, cwd=cwd):
                self.assert_denied(self.bash(cmd, cwd=cwd), cmd)

    def test_grep_directories_recurse_in_every_spelling_over_a_token_directory_is_blocked(self):
        for opt in ('--directories=recurse', '--directories recurse', '--dir=recurse', '-d recurse', '-drecurse', '--d=recurse', '-nd recurse'):
            for target in ('agents', 'agents/', 'agents/agent-a', '.'):
                cmd = 'grep %s foo %s' % (opt, target)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)
        # no operand: the ACTION word is the option value and the cwd holds a token
        for cmd in ('grep -d recurse foo', 'grep --directories recurse foo', 'grep --dir=recurse foo'):
            with self.subTest(cmd=cmd, cwd='agent-a'):
                self.assert_denied(self.bash(cmd, cwd=self.p('agents', 'agent-a')), cmd)
        for cmd in ('grep --directories=recurs foo agents', 'grep -d bogus foo agents', 'grep --directories= foo agents'):
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_a_brace_word_with_a_star_and_an_alternative_without_a_glob_does_not_crash(self):
        # `_tier_b_glob_selects` expands the braces and used to take the `*` position of EVERY alternative: an alternative with
        # no glob raised AttributeError, which the gate turns into an "internal error" block (a false block for a JSON text)
        for cmd in ('echo \'{"a": 1, "b": "*"}\'', 'echo \'{"k": "*", "n": 2}\'', 'echo {x,y}*z',
                    'curl -s -X POST localhost:3420/api/messages -d \'{"from":"agent-a","content":"1 * 2, x"}\'',
                    'echo {a,b}', 'echo {a,b} *.md'):
            with self.subTest(cmd=cmd):
                rc, out, err = self.bash(cmd)
                self.assertNotIn('internal error', err, cmd)
                self.assert_allowed((rc, out, err), cmd)
        # the real token shapes next to such an alternative are still refused, by the rule and not by a crash
        # a bare `*` alternative is judged by the rule like the bare `*` word (the install root of this fixture holds a token file)
        for cmd in ('echo "{a,b,*}"', 'echo {a,b,*}', 'cat agents/agent-a/{*,.agent-token}', 'cat agents/agent-a/{x,.agent-t*}', 'cat agents/agent-a/{x,.agent-token}*',
                    'cat agents/*/{x,.agent-token}', 'cat agents/agent-a/.agent-t*', 'cat agents/*/.agent-token'):
            with self.subTest(cmd=cmd):
                rc, out, err = self.bash(cmd)
                self.assertNotIn('internal error', err, cmd)
                self.assert_denied((rc, out, err), cmd)

    def test_a_brace_word_without_a_glob_is_judged_alternative_by_alternative(self):
        # every token file x the name, in either order, nested, as a sequence, from the directory itself; the prefix is quoted like a
        # user would (a directory with a space or a quote in its name), the braces are not
        for rel in PROTECTED:
            d, name = os.path.split(rel)
            pre = shlex.quote(d + '/') if d else ''
            seq = name[:-1] + '{' + name[-1] + '..' + name[-1] + '}'
            cmds = ['cat %s{%s,x}' % (pre, name), 'cat %s{x,%s}' % (pre, name), 'cat %s{x,{y,%s}}' % (pre, name), 'cat %s{{x,y},%s}' % (pre, name),
                    'cat %s%s' % (pre, seq), 'head -c 5 %s{%s,x,y}' % (pre, name), 'cat < %s{%s,x}' % (pre, name)]
            if d:
                cmds += ['cat %s{%s,x}' % (shlex.quote(os.path.dirname(d) + '/') if os.path.dirname(d) else '', os.path.basename(d) + '/' + name)]
            for cmd in cmds:
                with self.subTest(cmd=cmd, protected=rel):
                    rc, out, err = self.bash(cmd)
                    self.assertNotIn('internal error', err, cmd)
                    self.assert_denied((rc, out, err), cmd)
            with self.subTest(cmd='cat {name,x}', cwd=d):
                self.assert_denied(self.bash('cat {%s,x}' % name, cwd=os.path.join(self.root, d)), 'cat {name,x} from %s' % d)

    def test_a_link_to_a_protected_file_in_a_glob_less_brace_word_is_blocked(self):
        for rel, (sym, rsym, hard) in self.links.items():
            for link in (sym, rsym, hard):
                d, name = os.path.split(link)
                for cmd in ('cat %s/{%s,x}' % (d, name), 'cat %s/{x,%s}' % (d, name), 'cat {%s,x}' % link, 'cat {x,%s}' % link, 'cat %s/{x,{y,%s}}' % (d, name),
                            'cat {%s,src}/{x,%s}' % (d, name)):
                    with self.subTest(cmd=cmd, protected=rel):
                        self.assert_denied(self.bash(cmd), cmd)

    def test_a_command_substitution_inside_double_quotes_opens_an_unquoted_context(self):
        # in bash and zsh the text of $( ... ) and `...` inside double quotes is a command of its own: its braces expand
        T = 'agents/agent-a/.agent-token'
        cells = [('echo "$(cat agents/agent-a/{.agent-token,x})"', True), ('echo "`cat agents/agent-a/{.agent-token,x}`"', True),
                 ('echo "$(echo "$(cat agents/agent-a/{.agent-token,x})")"', True), ('echo "$(echo $(cat agents/agent-a/{.agent-token,x}))"', True),
                 ('echo "x $(cat agents/agent-a/{.agent-token,x}) y"', True), ('echo "$(cat \\"agents/agent-a/{.agent-token,x}\\")"', True),
                 ("echo \"$(cat 'agents/agent-a/{.agent-token,x}')\"", False), ('echo "${v:-agents/agent-a/{.agent-token,x}}"', False),
                 ('echo "agents/agent-a/{.agent-token,x}"', False), ('echo "$(date) agents/agent-a/{.agent-token,x}"', False)]
        for cmd, reads in cells:
            probe = cmd.replace('cat ', 'echo ')      # the oracle: the shell only prints what it would have read
            for shell in ('bash', 'zsh'):
                exe = shutil.which(shell)
                if exe:
                    out = subprocess.run([exe, '-c', probe], cwd=self.root, capture_output=True, timeout=30).stdout.decode()
                    with self.subTest(cmd=cmd, shell=shell):
                        self.assertEqual(T in out, reads, 'the oracle: %s printed %r' % (shell, out[:90]))
            with self.subTest(cmd=cmd):
                (self.assert_denied if reads else self.assert_allowed)(self.bash(cmd), cmd)
        # an unterminated substitution: the rest is judged as unquoted
        self.assert_denied(self.bash('echo "$(cat agents/agent-a/{.agent-token,x}"'), 'unterminated $(')

    def test_a_quoted_or_escaped_brace_group_is_literal_and_an_unquoted_one_next_to_a_quoted_space_expands(self):
        # what the shell prints is the oracle: a quoted brace group stays as typed, so it is no read of the token
        for word, expands in [("'agents/agent-a/{.agent-token,x}'", False), ('"agents/agent-a/{.agent-token,x}"', False), ('agents/agent-a/\\{.agent-token,x\\}', False),
                              ('agents/agent-a/{.agent-token,x}', True), ('"agents/agent-a/"{.agent-token,x}', True), ('agents/"agent c d"/{.agent-token,x}', True),
                              ("agents/{'agent c d',agent-a}/.agent-token", True), ('agents/agent-a/{".agent-token",x}', True)]:
            lines = subprocess.run(['bash', '-c', "printf '%s\\n' " + word], cwd=self.root, capture_output=True, timeout=30).stdout.decode().split('\n')
            self.assertEqual(any(l.endswith('/.agent-token') for l in lines), expands, 'the oracle for %r' % word)
            with self.subTest(word=word):
                (self.assert_denied if expands else self.assert_allowed)(self.bash('cat ' + word), 'cat ' + word)

    def test_a_brace_word_without_a_glob_that_names_no_protected_file_passes(self):
        for cmd in ['echo src/{a,b}.ts', 'cat src/{a.ts,x}', 'cat {src/a.ts,x}', 'cat docs/{x,agent-token.md}', 'echo \'{"a": 1, "b": 2}\'', 'echo {1..3}', 'echo {a..e}',
                    'echo ${HOME}', 'echo {x}', 'cat agents/agent-a/{CLAUDE.md,notes.txt}', 'cat agents/{agent-a,agent-b}/CLAUDE.md', 'grep -r foo {src,scripts}',
                    'curl -s -X POST localhost:3420/api/messages -d \'{"from":"agent-a","to":"agent-b","content":"hi"}\'']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_a_link_to_a_protected_file_next_to_a_glob_alternative_is_blocked_whatever_the_order(self):
        # the alternative without a glob is judged as a plain path of EITHER tier: a symlink (absolute or relative) or a hard link to a
        # token file, and to the claim signing key, in a brace word with a glob alternative, in both orders
        for rel, (sym, rsym, hard) in self.links.items():
            for link in (sym, rsym, hard):
                d, name = os.path.split(link)
                for alts in ('%s,x*', 'x*,%s', '%s,y?', '[a]*,%s'):
                    cmd = 'cat %s/{%s}' % (d, alts % name)
                    with self.subTest(cmd=cmd, protected=rel):
                        rc, out, err = self.bash(cmd)
                        self.assertNotIn('internal error', err, cmd)
                        self.assert_denied((rc, out, err), cmd)
        # a benign alternative next to a glob passes
        for cmd in ('cat src/{a.ts,b*}', 'cat src/{b*,a.ts}', 'cat work/{x,y*}', 'cat docs/{x,y}*'):
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_grep_abbreviated_long_recursive_options_over_a_token_directory_are_blocked(self):
        for opt in ('--recursive', '--recursiv', '--recur', '--rec', '--dereference-recursive', '--dereference-r', '--dereference', '--dere', '--der'):
            for target in ('agents', 'agents/', 'agents/agent-a', '.'):
                cmd = 'grep %s foo %s' % (opt, target)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)
        for cmd in ('grep --rec foo', 'grep --dere foo'):
            with self.subTest(cmd=cmd, cwd='agent-a'):
                self.assert_denied(self.bash(cmd, cwd=self.p('agents', 'agent-a')), cmd)
        # an abbreviated option is not a known no-value one: the exclude parse voids, so even the token-name exclude does not let it through
        for cmd in ('grep --rec --exclude=.agent-token foo agents', 'grep --dere foo agents --exclude=.agent-token'):
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        for cmd in ('grep --rec foo src', 'grep --dere foo src', 'grep --regexp=foo notes.txt', 'grep --reg=foo notes.txt'):
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_grep_long_option_resolution_cells_over_a_token_directory_are_blocked(self):
        # the cells of the one resolver (see the tier A test): --rec, --recur, --recurs read on the real BSD grep
        for opt in ('--rec', '--recur', '--recurs', '--recursive', '--dereference-recursive', '--dereference-rec', '--dere', '--directories=recurse', '--dir=recurse', '--d=recurse'):
            for target in ('agents', 'agents/', 'agents/agent-a', '.'):
                cmd = 'grep %s foo %s' % (opt, target)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)
        for cmd in ('grep --bogus foo agents', 'grep --recursively foo agents/agent-a', 'grep --bogus foo .'):
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        for cmd in ('grep --bogus foo src', 'grep --bogus foo notes.txt'):
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_find_over_a_token_directory_piped_into_a_reader_is_blocked_like_find_exec(self):
        # 1:1 with the -exec cells: the same find words get the same verdict through -exec and through xargs
        for find, cwd, denied in [('find agents -type f', None, True), ('find agents/agent-a', None, True), ('find . -type f', None, True),
                                  ('find -type f', self.p('agents', 'agent-a'), True), ('find . -type f', self.p('agents', 'agent-a'), True),
                                  ('find src -type f', None, False), ('find agents -prune', None, False)]:
            for tail in (' -exec cat {} +', ' | xargs cat', ' | xargs -0 head', ' | parallel cat'):
                cmd = find + tail
                with self.subTest(cmd=cmd, cwd=cwd):
                    (self.assert_denied if denied else self.assert_allowed)(self.bash(cmd, cwd=cwd), cmd)
        for cmd in ('find agents -type f | xargs wc -l', 'find agents -type f | xargs ls', 'find agents -type f | xargs'):
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_grep_directories_recurse_with_a_token_exclude_is_not_trusted(self):
        # the option is not a known no-value one, so the exclude parse voids (fail closed), exactly as for `-d recurse` before
        for cmd in ('grep --directories=recurse --exclude=.agent-token foo agents', 'grep --dir=recurse foo agents --exclude=.agent-token'):
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_grep_directories_read_and_skip_over_a_token_directory_pass(self):
        for cmd in ('grep -d skip foo agents', 'grep --directories=read foo agents', 'grep --dir=skip foo agents/agent-a', 'grep -dskip foo agents', 'grep -ed agents'):
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)
        for opt in ('--directories=recurse', '-d recurse'):
            cmd = 'grep %s foo src' % opt
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_exclude_of_the_token_name_lets_a_legitimate_search_through(self):
        for cmd, cwd in [('grep -r foo agents/agent-a --exclude=.agent-token', None), ('grep -rn --exclude=.agent-token foo agents', None),
                         ('grep -r --exclude .agent-token foo agents/agent-b', None), ('grep -r foo . --exclude=.agent-token', self.p('agents', 'agent-a')),
                         ('grep -r foo --exclude=.agent-token', self.p('agents', 'agent-a')),
                         ('grep -r --exclude=.agent-token --exclude=.agent-token foo agents', None), ('egrep -r foo agents --exclude=.agent-token', None),
                         ('rg foo agents', None), ('rg -g "*.md" foo agents', None)]:
            with self.subTest(cmd=cmd, cwd=cwd):
                self.assert_allowed(self.bash(cmd, cwd=cwd), cmd)

    # The six real spellings (plus brace expansion) that read the tokens through the exclude carve-out. Each one was run
    # against the system BSD grep 2.6.0-FreeBSD in a throw-away tree with agents/agent-a/.agent-token and
    # agents/agent-b/.agent-token: every command of the next three tests (F1, F2, F3) printed the token content (the
    # `command grep` and `egrep` spellings behave as the plain one). A wrapper `grep` on a host can be ugrep, which ignores
    # the include / exclude order: do not trust it for the check. The carve-out counts ONE shape only:
    # `--exclude=<the exact dotted name>` and nothing else.
    def test_an_include_after_the_exclude_re_includes_the_token(self):      # F1
        for cmd in ['grep -r x agents --exclude=.agent-token --include=.agent-token', "grep -r x agents --exclude=.agent-token --include='*'",
                    'grep -r x agents --exclude .agent-token --include .agent-token', 'command grep -r x agents --exclude=.agent-token --include=.agent-token',
                    'egrep -r x agents --exclude=.agent-token --include=.agent-token',
                    # the include BEFORE the exclude is safe in grep, the gate does not depend on the order: refused as well
                    "grep -r x agents --include='*' --exclude=.agent-token"]:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_an_exclude_that_does_not_match_the_file_name_exactly_excludes_nothing(self):      # F2
        for cmd in ['grep -r x agents --exclude=.agent-token/', 'grep -r x agents --exclude-dir=.agent-token', 'grep -r x agents --exclude-dir .agent-token',
                    "grep -r x agents --exclude='.agent-*'", 'grep -r x agents --exclude=./.agent-token', 'grep -r x agents --exclude=.AGENT-TOKEN',
                    "grep -r x agents --exclude='*'", 'grep -r x agents --exclude=agent-token']:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_a_word_that_is_resolved_at_run_time_could_carry_an_include(self):      # F3
        for cmd in ['grep -r x agents --exclude=.agent-token $EXTRA', "grep -r x agents --exclude=.agent-token $(echo --include='*')",
                    "grep -r x agents --exclude=.agent-token `echo --include='*'`", 'grep -r x agents --exclude=.agent-token "$EXTRA"',
                    # brace expansion: bash turns the word into `--include=.agent-token` (no glob character, so the glob rules do not see it)
                    'grep -r x agents --exclude=.agent-token {--include=.agent-token,--include=x}',
                    'grep -r x agents --exclude=.agent-token ${EXTRA}']:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_a_command_outside_the_one_exclude_shape_is_refused_although_grep_would_honour_it(self):
        # these do NOT read the token in the system BSD grep (a second exclude of another name, a directory exclude, an
        # include of a directory, a variable as the pattern); the gate refuses them anyway: it does not read the order in
        # which an implementation applies include and exclude, and it does not guess what a variable holds
        for cmd in ['grep -r x agents --exclude=.agent-token --include-dir=agents', 'grep -r x agents --exclude=.agent-token --exclude=CLAUDE.md',
                    'grep -r x agents --exclude=.agent-token --exclude-dir=agents', 'grep -r x agents --exclude-dir=agents --exclude=.agent-token',
                    'grep -r $PATTERN agents --exclude=.agent-token', 'grep -r x agents --exclude=.agent-token `a`',
                    'grep -r x agents --exclude=.agent-token {--include=a,--include=b}',
                    'grep -r --exclude-dir=agents --exclude-dir=store --exclude=.agent-token foo agents/..',
                    'grep -r --exclude-dir=store --exclude-dir=agents --exclude=.agent-token foo .']:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_a_word_that_is_a_file_is_never_guessed_to_be_the_pattern(self):
        # `-er` is `-e` with the attached pattern `r`: the next word is a FILE; `-f`, `-m 5`, `-A1` take values too
        for cmd in ['grep -er .agent-token', 'grep -A1 .agent-token', 'grep -m 1 .agent-token', 'grep -f pats.txt .agent-token', 'grep -e x -- .agent-token',
                    'grep -rne x .agent-token', 'grep -nf pats.txt .operator-token', 'rg --max-count 1 .agent-token', 'grep -x foo .agent-token',
                    'grep foo .agent-token', 'grep -e x store/.dashboard-token', 'grep --file=pats.txt .agent-token', 'grep --fil=pats.txt .agent-token',
                    'grep --reg=x .agent-token', 'grep --color=never foo .agent-token', 'grep -- -e .agent-token', 'tar -cf --exclude=.agent-token x.tar agents',
                    'tar czf --exclude=.agent-token x.tgz agents', 'grep -rA2 --exclude=.agent-token foo agents']:
            with self.subTest(cmd=cmd):
                self.assert_denied_b(self.bash(cmd), cmd)

    def test_an_exclude_that_is_not_an_option_of_the_command_excludes_nothing(self):
        for cmd in ['find agents --exclude=.agent-token -exec cat {} +', 'cp -r --exclude=.agent-token agents /tmp/y', 'zip -r a.zip agents --exclude=.agent-token',
                    'grep -e --exclude=.agent-token -r foo agents', 'grep -r foo agents -- --exclude=.agent-token', 'grep -f --exclude=.agent-token -r foo agents']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_an_exclude_counts_only_when_every_option_of_the_command_is_understood(self):
        # an option with a value and no `=` (`--label X`, `--group-separator X`), an abbreviated or unknown long option
        # and rsync (its own value-taking options) can swallow the word the parse took for the exclude: fail closed
        for cmd in ['grep -r --label x --exclude=.agent-token foo agents', 'grep -r --group-separator x --exclude=.agent-token foo agents',
                    'rsync -a --exclude=.agent-token agents /tmp/y', 'grep -r --label --exclude=.agent-token foo agents',
                    'grep -r --reg x --exclude=.agent-token foo agents', 'grep -r --color=never --exclude=.agent-token foo agents',
                    'grep -r --exclude=.agent-token --max-count 1 foo agents', 'grep -r --exclude=.agent-token --recursive=x foo agents',
                    'grep -r -A2 --exclude=.agent-token foo agents', 'grep -r -5 --exclude=.agent-token foo agents',
                    'grep -r --exclude-from=x --exclude=.agent-token foo agents', 'grep -r -+ --exclude=.agent-token foo agents']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        # the same understood options keep the exclude working: known no-value options, `=` and space forms, -e / --regexp
        for cmd in ['grep -rn --exclude=.agent-token foo agents', 'grep -r --exclude .agent-token foo agents',
                    'grep -r -e foo --exclude=.agent-token agents', 'grep -r --regexp foo --exclude=.agent-token agents',
                    'grep -r --ignore-case --line-number --exclude=.agent-token foo agents', 'grep -r --exclude=.agent-token foo agents -']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_exclude_of_another_name_does_not(self):
        for cmd, cwd in [('grep -r foo agents/agent-a --exclude=.other-token', None), ('grep -r foo agents --exclude=CLAUDE.md', None),
                         ('grep -r --exclude=.agent-tokens foo agents/agent-b', None), ('grep -r foo . --exclude=.operator-token', self.p('agents', 'agent-a')),
                         ('grep -r --exclude-dir=agent-b foo agents', None), ('grep -r foo . --exclude=.agent-token', None),
                         ('grep -r --exclude-dir=store foo .', None), ('rsync -a --exclude=store agents /tmp/y', None)]:
            with self.subTest(cmd=cmd, cwd=cwd):
                self.assert_denied(self.bash(cmd, cwd=cwd), cmd)

    def test_the_same_readers_over_directories_without_a_token_pass(self):
        for cmd in ['grep -rn foo src', 'grep -r foo docs', 'tar cf x.tar src docs', 'cp -r src /tmp/y', 'rsync -a docs /tmp/y', 'find src -exec cat {} +',
                    'grep -r foo agents/ghost', 'cp -r agents/ghost /tmp/y', 'find agents -name CLAUDE.md','find agents -prune -exec cat {} +', 'rg --hidden foo src', 'zip -r a.zip src']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)


class Enumeration(Tree):
    def test_an_agent_that_appears_between_two_calls_is_protected_and_one_that_goes_away_is_not(self):
        new_dir = self.p('agents', 'new-agent')
        link = self.p('work', 'new-hard.txt')
        try:
            self.assert_allowed(self.bash('ls agents'), 'before')
            os.makedirs(new_dir)
            with open(os.path.join(new_dir, '.agent-token'), 'w') as fh:
                fh.write(TOKEN)
            os.link(os.path.join(new_dir, '.agent-token'), link)
            self.assert_denied_b(self.bash('cat work/new-hard.txt'), 'a hard link to the token of an agent that appeared')
            self.assert_denied_b(self.bash('grep -r foo agents/new-agent'), 'the new directory')
            self.assert_denied_b(self.run_gate('Read', {'file_path': link}), 'file tool')
        finally:
            for path in (link,):
                if os.path.lexists(path):
                    os.unlink(path)
            shutil.rmtree(new_dir, ignore_errors=True)
        self.assert_allowed(self.bash('cat work/notes-after.txt'), 'after')
        self.assert_allowed(self.bash('grep -r foo agents/agent-a --exclude=.agent-token'), 'the others still work')

    def test_a_missing_agents_directory_protects_the_rest(self):
        other = os.path.realpath(tempfile.mkdtemp(prefix='secret-tokens-noagents-'))
        try:
            os.makedirs(os.path.join(other, 'scripts/hooks'))
            os.makedirs(os.path.join(other, 'store'))
            shutil.copy(GATE_SRC, os.path.join(other, 'scripts/hooks/secret-read-gate.py'))
            gate = os.path.join(other, 'scripts/hooks/secret-read-gate.py')
            self.assert_denied_b(self.run_gate('Read', {'file_path': os.path.join(other, 'store', '.dashboard-token')}, cwd=other, gate=gate), 'store token')
            self.assert_denied_b(self.run_gate('Bash', {'command': 'cat .agent-token'}, cwd=other, gate=gate), 'main agent token')
            self.assert_allowed(self.run_gate('Bash', {'command': 'ls -la'}, cwd=other, gate=gate), 'ordinary')
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_an_unreadable_agents_directory_is_a_refusal_not_a_pass(self):
        other = os.path.realpath(tempfile.mkdtemp(prefix='secret-tokens-unreadable-'))
        try:
            os.makedirs(os.path.join(other, 'scripts/hooks'))
            os.makedirs(os.path.join(other, 'store'))
            os.makedirs(os.path.join(other, 'agents/agent-a'))
            os.makedirs(os.path.join(other, 'src'))
            shutil.copy(GATE_SRC, os.path.join(other, 'scripts/hooks/secret-read-gate.py'))
            gate = os.path.join(other, 'scripts/hooks/secret-read-gate.py')
            self.assert_allowed(self.run_gate('Read', {'file_path': os.path.join(other, 'src', 'a.ts')}, cwd=other, gate=gate), 'readable: allowed')
            os.chmod(os.path.join(other, 'agents'), 0)
            try:
                if os.access(os.path.join(other, 'agents'), os.R_OK):
                    self.skipTest('the agents directory stays readable (running as root)')
                for tool, ti in [('Read', {'file_path': os.path.join(other, 'src', 'a.ts')}), ('Bash', {'command': 'grep -r foo agents'}),
                                 ('Bash', {'command': 'cat docs.md'}), ('mcp__x__y', {'q': 'x'})]:
                    with self.subTest(tool=tool):
                        rc, out, err = self.run_gate(tool, ti, cwd=other, gate=gate)
                        self.assertEqual(rc, 2, err)
                        self.assertIn('BLOCKED', err)
                        self.assertNotIn(other, err)
            finally:
                os.chmod(os.path.join(other, 'agents'), 0o755)
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_more_entries_than_the_bound_is_a_refusal_and_exactly_the_bound_is_not(self):
        other = os.path.realpath(tempfile.mkdtemp(prefix='secret-tokens-bound-'))
        try:
            os.makedirs(os.path.join(other, 'scripts/hooks'))
            os.makedirs(os.path.join(other, 'store'))
            shutil.copy(GATE_SRC, os.path.join(other, 'scripts/hooks/secret-read-gate.py'))
            gate = os.path.join(other, 'scripts/hooks/secret-read-gate.py')
            for i in range(MAX_AGENTS):
                os.makedirs(os.path.join(other, 'agents', 'a%05d' % i))
            self.assert_allowed(self.run_gate('Bash', {'command': 'ls -la'}, cwd=other, gate=gate), 'exactly the bound')
            os.makedirs(os.path.join(other, 'agents', 'one-too-many'))
            rc, out, err = self.run_gate('Bash', {'command': 'ls -la'}, cwd=other, gate=gate)
            self.assertEqual(rc, 2, err)
            self.assertIn('BLOCKED', err)
            self.assertNotIn(other, err)
        finally:
            shutil.rmtree(other, ignore_errors=True)


class TierAUnchanged(Tree):
    def test_tier_a_keeps_its_message_and_its_strict_text_rule(self):
        rc, out, err = self.bash('cat store/' + KEY_NAME)
        self.assertEqual(rc, 2)
        self.assertIn('The key store/%s is not for an agent to read or change.' % KEY_NAME, err)
        self.assertNotIn(GENERIC, err)
        self.assertNotIn(KEY, err)
        # the strict text rule: a fragment of the name, anywhere in the text, even as free text
        for cmd in ['echo claim-signing', 'echo "the signing-key file"', 'git commit --dry-run -m "rotate claim_signing material"']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        # and the tier B names are NOT strict: the same free-text mention is fine
        self.assert_allowed(self.bash('echo "the dashboard-token and agent-token files"'), 'free text')

    def test_the_key_and_a_token_in_one_call_report_the_key(self):
        rc, out, err = self.bash('cat store/%s store/.dashboard-token' % KEY_NAME)
        self.assertEqual(rc, 2)
        self.assertIn('claim signing key', err)


def shell_words(shell, word, cwd):
    """The words `shell` makes of `word` (what it would hand a command as arguments): `printf` is the only thing that runs,
    PATH is empty, so a command substitution in the word runs nothing. None when the shell is not installed."""
    exe = shutil.which(shell)
    if not exe:
        return None
    p = subprocess.run([exe, '-c', 'eval "printf \'%s\\0\' $1"', 'x', word], cwd=cwd, capture_output=True, timeout=30, stdin=subprocess.DEVNULL,
                       env={'PATH': '/nonexistent', 'HOME': cwd, 'LC_ALL': 'C'})
    return [w.decode('utf-8', 'replace') for w in p.stdout.split(b'\0') if w]


class BraceFixupTwo(Tree):
    """PR 878, second fixup: where a brace group starts and ends is decided the way the shell decides it, and the quote
    state of a command substitution inside double quotes is read the way the shell reads it."""

    def reads(self, shell, word, rel):
        """Does `shell` expand `word` to a path that is the protected file `rel` (or a link to it)? None: no such shell."""
        out = shell_words(shell, word, self.root)
        if out is None:
            return None
        target = os.path.realpath(self.p(rel))
        return any(os.path.realpath(os.path.join(self.root, w)) == target for w in out)

    def test_quotes_inside_a_command_substitution_inside_double_quotes_are_the_shells_own(self):
        # F1: `"$(cat "agents/a/"{x,y})"` is the idiom `"$(cmd "arg")"`. The inner quotes open spans of their own, so a newer
        # bash and zsh expand the braces in the unquoted part; bash 3.2 expands them textually and toggles at EVERY double
        # quote, so it also expands a group between the inner quotes. The gate expands wherever either reading leaves a
        # brace unquoted. (The first inner quote used to end the span, and the quote parity flipped for good.)
        T = 'agents/agent-a/.agent-token'
        cells = [('echo "$(cat "agents/agent-a/"{.agent-token,x})"', True),
                 ('echo "$(cat "a" agents/agent-a/{.agent-token,x})"', True),
                 ('echo "$(cat \'agents/agent-a/\'{.agent-token,x})"', True),
                 ('echo "$(echo "x" "$(cat "agents/agent-a/"{.agent-token,x})")"', True),
                 ('echo "x $(cat "q" "agents/agent-a/"{.agent-token,x}) y"', True),
                 ('echo "$(cat "agents/agent-a/{.agent-token,x}")"', True),      # bash 3.2 reads it, see above
                 # the same quoting, no protected path: the idiom stays allowed
                 ('echo "$(cat "src/"{a.ts,b.ts})"', False),
                 ('echo "$(echo "x" src/{a.ts,b})"', False),
                 ('echo "$(echo \'{a,b}\')"', False),
                 ('echo "${v:-agents/agent-a/{.agent-token,x}}"', False)]
        for cmd, must_deny in cells:
            probe = cmd.replace('cat ', 'echo ')      # the oracle prints what the command would have read
            for shell in ('bash', 'zsh'):
                out = shell_words(shell, probe, self.root)
                if out is not None and any(T in w.split() for w in out):
                    with self.subTest(cmd=cmd, shell=shell):
                        self.assertTrue(must_deny, '%s reads the token, the cell says it may pass' % shell)
            with self.subTest(cmd=cmd):
                (self.assert_denied if must_deny else self.assert_allowed)(self.bash(cmd), cmd)
        # at least one installed shell reads the token in the first cell: the cells are not vacuous
        probe = 'echo "$(echo "agents/agent-a/"{.agent-token,x})"'
        self.assertTrue(any(T in w.split() for sh in ('bash', 'zsh') for w in (shell_words(sh, probe, self.root) or [])), 'no shell reads the first cell')

    def test_a_brace_pair_in_front_of_the_commas_does_not_close_the_group(self):
        # F2: bash closes a group at the first `}` AFTER a comma, so `{b}` in front of the commas belongs to the first
        # alternative and the real group runs on to a later `}`. The leaks of the review, plus a link to the key
        T = '.agent-token'
        link = self.links[T][0]
        cells = ['cat agents/agent-a/{b},.agent-token,{}}', 'cat agents/agent-a/{b},,.agent-token}', 'cat agents/agent-a/{x},.agent-token,{y}}',
                 'cat {b},.agent-token,{}}', 'cat work/{b},%s,{}}' % os.path.basename(link), 'cat agents/agent-a/{},.agent-token}']
        for cmd in cells:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        # bash 3.2 (and the versions that pair the same way) does expand the first cell to the token; where it does not, the
        # verdict is still deny: the gate judges the bash pairing AND the nesting one, a superset on purpose
        if self.reads('bash', 'agents/agent-a/{b},.agent-token,{}}', 'agents/agent-a/' + T) is False:
            print('note: this bash nests the braces, it does not expand the review shape to the token', file=sys.stderr)

    def test_how_many_words_a_word_may_expand_to(self):
        # F4: the cap counts the words of the FINAL expansion. 26 * 26 = 676 is under it, 1024 is the last that passes
        passes = ['echo {a..z}{a..z}', 'echo {1..32}{1..32}', 'echo ' + '{a,b}' * 10, 'echo {1..1024}']
        refused = ['echo {1..33}{1..32}', 'echo {a..z}{a..z}{a..z}', 'echo ' + '{a,b}' * 11, 'echo {1..1025}', 'echo {a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b}']
        for cmd in passes:
            with self.subTest(cmd=cmd[:40]):
                self.assert_allowed(self.bash(cmd), cmd[:40])
        for cmd in refused:
            with self.subTest(cmd=cmd[:40]):
                rc, out, err = self.bash(cmd)
                self.assertEqual(rc, 2, cmd[:40])
                self.assertIn('more paths than the gate can look through', err)


class BraceDifferential(Tree):
    """The gate against real shells over random words: if a shell's brace expansion of a word is a protected file (or a link
    to one), the gate must refuse the command that names the word. The words are built from the shapes of the review
    (a stray `}` or a balanced `{b}` in front of the commas, quotes, backslash, dollar, parentheses) and a planted token
    path; the seed is fixed. A shell that is not installed is skipped (bash is always there). The oracle runs one shell
    for the whole batch (`eval` in a subshell per word, an empty PATH so nothing but builtins can run).

    Left out of the comparison, as a different class of its own: a word with a variable or a command substitution, whose
    value the gate cannot know (`$a{x,y}`, `$(){x,y}`)."""
    SEED, CASES = 878, 12000
    PLANTS = ['agents/agent-a/', 'agents/agent-a/.agent-token', 'store/', '.operator-token', 'agents/']
    ATOMS = list('abx01,.-{}\'"\\$()`') + ['..', '{a,b}', ',', '{', '}', '{}', '"', "'"]
    JUNK = ['', '', '', '{b}', '{}', '}', '{', "'", '"', '\\', '$', '$(', ')', '(', '`', '..', ',', 'a', 'x', '-', '0', '{a,b}', '${', '"x"', "'y'"]
    CLEAN = ['', '', '', '{b}', '{}', '}', '{', 'a', 'x', ',', '..', '-', '0', '{a,b}', '{x}', ',,']
    ITEMS = ['.agent-token', '.agent-token', 'x', 'b', '', '{b}', '{}', '}', '{', '{x}', '{y,z}', '"', "'", '$(', ')', '..', '\\', '.agent-', 'token']
    DRIVER = 'cd "$1"\nwhile IFS= read -r w; do\n  ( eval "printf \'%s\\0\' $w" ) 2>/dev/null </dev/null\n  printf \'\\001\'\ndone < "$2"\n'
    VARIABLE = re.compile(r'\$[A-Za-z0-9_{*@#?!(-]|`')

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib.util
        spec = importlib.util.spec_from_file_location('gate_under_test_brace', cls.gate)
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    def make_words(self):
        import random
        rng = random.Random(self.SEED)

        def junk():
            pool = self.CLEAN if rng.random() < 0.65 else self.JUNK
            return ''.join(rng.choice(pool) for _ in range(rng.randint(0, 3)))

        words = []
        for _ in range(self.CASES):
            if rng.random() < 0.35:
                out = [rng.choice(self.ATOMS) for _ in range(rng.randint(2, 12))]
                out.insert(rng.randint(0, min(2, len(out))), 'agents/agent-a/')
                out.insert(rng.randint(0, len(out)), '.agent-token')
                words.append(''.join(out))
                continue
            items = [rng.choice(self.ITEMS) for _ in range(rng.randint(1, 4))]
            if '.agent-token' not in items:
                items.insert(rng.randint(0, len(items)), '.agent-token')
            body = ','.join(items) if rng.random() < 0.9 else '..'.join(items)
            pre = 'agents/agent-a/' if rng.random() < 0.9 else rng.choice(self.PLANTS)
            lead = junk() if rng.random() < 0.3 else ''
            mid = junk() if rng.random() < 0.2 else ''
            tail = junk() if rng.random() < 0.2 else ''
            if rng.random() < 0.3:      # a balanced stray pair in front of the commas: the shape of the F2 leaks
                body = rng.choice(['{b}', '{}', '{x}', 'b}', '{']) + ',' + body
            words.append(lead + pre + mid + '{' + body + '}' + tail)
        return words

    def expansions(self, shell, words):
        exe = shutil.which(shell)
        if not exe:
            return None
        inp = os.path.join(self.root, 'work', 'words-%s.txt' % shell)
        env = {'PATH': '/nonexistent', 'HOME': self.root, 'LC_ALL': 'C'}

        def run(ws):
            with open(inp, 'w', encoding='utf-8') as fh:
                fh.write('\n'.join(ws) + '\n')
            try:
                p = subprocess.run([exe, '-c', self.DRIVER, 'x', self.root, inp], capture_output=True, timeout=30, env=env, stdin=subprocess.DEVNULL, cwd=self.root)
            except subprocess.TimeoutExpired:
                if len(ws) == 1:
                    return [[]]      # a word the shell hangs on reads nothing
                h = len(ws) // 2
                return run(ws[:h]) + run(ws[h:])
            chunks = p.stdout.split(b'\x01')[:-1]
            self.assertEqual(len(chunks), len(ws), '%s: the oracle lost its place' % shell)
            return [[x.decode('utf-8', 'replace') for x in c.split(b'\0') if x] for c in chunks]

        return run(words)

    def test_the_gate_refuses_every_word_a_shell_expands_to_a_protected_file(self):
        words = self.make_words()
        protected = {os.path.realpath(self.p(r)) for r in PROTECTED}
        shells = {sh: self.expansions(sh, words) for sh in ('bash', 'zsh')}
        shells = {sh: ex for sh, ex in shells.items() if ex is not None}
        self.assertIn('bash', shells)
        positives, leaks, crashes = 0, [], []
        for i, w in enumerate(words):
            if self.VARIABLE.search(w):
                continue
            hit = [sh for sh, ex in shells.items() if any(os.path.realpath(os.path.join(self.root, o)) in protected for o in ex[i])]
            if not hit:
                continue
            positives += 1
            try:
                self.mod.check_bash('cat ' + w, self.root)
            except self.mod.Block:
                continue
            except Exception as exc:      # noqa: BLE001 -- the gate would block on it too, but a crash is a bug of its own
                crashes.append((w, type(exc).__name__))
                continue
            leaks.append((w, hit))
        self.assertGreater(positives, 300, 'the corpus is too thin to prove anything (%d shell-positive words)' % positives)
        self.assertEqual(crashes, [], 'the gate raised on %d words' % len(crashes))
        self.assertEqual(leaks, [], '%d of %d words that a shell expands to a protected file pass the gate (first: %r)' % (len(leaks), positives, leaks[:3]))


class BodiesAreJudged(Tree):
    """The body of a command substitution, a backtick pair, a process substitution, a subshell and the commands behind a
    reserved word (`{ cmd; }`, `if`, `then`, `do`, `!`, `case x in x) cmd`, a function body) are judged by the SAME rules as
    the top-level command. The reader rules (recursive grep, find -exec, archivers, copiers) used to look at the head of a
    top-level piece only. Every deny cell has benign twins; the in-process corpus is the cross product of the wrappers and
    the bodies."""
    DENY = ['grep -rn zzmark .', 'cat agents/agent-a/.agent-token', 'find store -type f -exec cat {} +', 'cp -r store out', 'tar cf - store',
            'cat work/key-link', 'cat work/{key-link,x}', 'cat work/{sym-0,x}', 'rg --hidden zzmark .']
    ALLOW = ['grep -rn zzmark src', 'ls docs', 'date', 'echo hi', 'cat src/a.ts', 'cd docs && ls', 'find src -type f', 'tar cf - src']
    WRAPPERS = ['{}', 'x=$({})', 'echo $({})', 'echo `{}`', 'echo "$({})"', 'echo "`{}`"', '({})', '{{ {}; }}', 'if true; then {}; fi', 'for i in 1; do {}; done',
                'while true; do {}; done', 'until false; do {}; done', '! {}', 'case x in x) {} ;; esac', 'f() {{ {}; }}; f', 'function f {{ {}; }}; f',
                'echo <({})', 'echo $(( $({}) + 1 ))', 'echo "x $(echo "y" "$({})")"', 'echo $(echo $({}))', 'time {}', 'if {}; then echo; fi',
                'echo "a" | ({})', '$({})']

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        os.symlink(cls.p_abs('store/' + KEY_NAME), cls.p_abs('work/key-link'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('gate_under_test_bodies', cls.gate)
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    @classmethod
    def p_abs(cls, rel):
        return os.path.join(cls.root, rel)

    def verdict(self, cmd):
        try:
            self.mod.check_bash(cmd, self.root)
        except self.mod.Block:
            return 'DENY'
        return 'ALLOW'

    def test_the_cross_product_of_wrappers_and_bodies(self):
        wrong, n = [], 0
        for wrapper in self.WRAPPERS:
            for bodies, expect in ((self.DENY, 'DENY'), (self.ALLOW, 'ALLOW')):
                for body in bodies:
                    # the doubled braces of a wrapper are literal braces
                    cmd = wrapper.replace('{{', '\x00').replace('}}', '\x01').replace('{}', body).replace('\x00', '{').replace('\x01', '}')
                    n += 1
                    got = self.verdict(cmd)
                    if got != expect:
                        wrong.append((expect, cmd))
        self.assertGreaterEqual(n, 300)
        self.assertEqual(wrong, [], '%d of %d cells differ, first: %r' % (len(wrong), n, wrong[:4]))

    def test_the_reason_does_not_quote_the_body(self):
        for cmd in ['x=$(grep -rn zzmark .)', 'echo "`grep -rn zzmark .`"', '(grep -rn zzmark .)', '{ grep -rn zzmark .; }']:
            rc, out, err = self.bash(cmd)
            with self.subTest(cmd=cmd):
                self.assertEqual(rc, 2)
                self.assertNotIn('zzmark', err)
                self.assertNotIn(self.root, err)

    def test_a_body_that_does_not_parse_is_refused(self):
        for cmd in ['echo $(grep -rn zzmark src', 'echo `ls docs', 'echo $(echo "unterminated)', '(ls docs', 'echo <(ls docs']:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'DENY')

    def test_the_depth_cap(self):
        ok = 'echo ' + '$(echo ' * 8 + 'hi' + ')' * 8
        too_deep = 'echo ' + '$(echo ' * 9 + 'hi' + ')' * 9
        self.assertEqual(self.verdict(ok), 'ALLOW')
        self.assertEqual(self.verdict(too_deep), 'DENY')
        # the reader at the bottom of the deepest allowed nesting is still found
        self.assertEqual(self.verdict('echo ' + '$(' * 7 + 'grep -rn zzmark .' + ')' * 7), 'DENY')

    def test_a_single_quoted_span_is_a_literal_and_the_name_rules_still_see_the_text(self):
        self.assertEqual(self.verdict("echo '$(grep -rn zzmark .)'"), 'ALLOW')
        self.assertEqual(self.verdict('x=$(cat agents/agent-a/.agent-token)'), 'DENY')

    def test_the_link_cells_with_the_shell_as_oracle(self):
        link = os.path.basename(self.links['agents/agent-a/.agent-token'][0])
        cmd = 'echo "$(echo work/{%s,x})"' % link
        for shell in ('bash', 'zsh'):
            out = shell_words(shell, cmd, self.root)
            if out is not None:
                with self.subTest(shell=shell):
                    self.assertIn('work/' + link, ' '.join(out).split())
        self.assertEqual(self.verdict('echo "$(cat work/{%s,x})"' % link), 'DENY')
        self.assertEqual(self.verdict('echo "$(cat src/{a.ts,x})"'), 'ALLOW')

    # Three ways the scanner could lose its place in a text (commit 1, review): a comment, a here-document, and the bash 5.3
    # `${ cmd; }`. READER is the command the gate refuses; ORACLE stands in for it when a shell runs the cell: `printf %s%s ORA CLE`
    # prints ORACLE only when it RUNS (the literal text of a quoted here-document holds the words, never the joined marker).
    # The marker used to be the number 42 (`expr 40 + 2`), which the output of a `$(date)` in a cell holds at minute 42, second 42
    # or in an epoch time: an unexplained red run of a cell that no shell runs, once an hour.
    READER, ORACLE = 'grep -rn foo .', 'printf %s%s ORA CLE >&2'
    # the body RUNS in a shell (at least one of bash and zsh proves it below) and the gate refuses it
    RUNS = ["x=$(R)", ": # it's\n x=$(R)\n : # don't", 'echo $( # it\'s\n R) # don\'t', 'echo "$( # it\'s\n R) # don\'t"', '(  # it\'s\n R\n) # don\'t',
            'echo a\\ #b $(R)', 'echo "a"#b $(R)', 'echo $(true)#y $(R)', 'echo ${X#*/} $(R)', 'echo $# #x it\'s\n $(R)',
            "cat <<EOF\nit's\n$(R)\nit's\nEOF", "cat <<-EOF\n\tit's\n\t$(R)\n\tit's\n\tEOF", "cat <<EOF\nit's `R`\nit's\nEOF",
            "x=$(cat <<EOF\nit's\n$(R)\nit's\nEOF\n)", 'cat <<EOF\nEOF\nx=$(R)', "cat <<'EOF'\nit's\nEOF\nx=$(R)", "cat <<A <<'B'\nit's $(R)\nA\nit's\nB",
            'x=$((1<<"2"))\n y=$(R)', 'echo $[1<<"2"]\n $(R)', '(( x = 1 <<"2" ))\n $(R)', 'cat <<< "x"\n $(R)', 'x=$(cat <<\'EOF\'\nit\'s\nEOF\nR)',
            'echo "$(cat <<EOF\nit\'s\n$(R)\nEOF\n)"', "echo ${X//<<'E'/y}\n $(R)", "echo ${X//<<'E'/y}\n `R`", "cat <<EOF # note\nit's\n$(R)\nit's\nEOF", "x=$(cat <<EOF # note\nit's\n$(R)\nit's\nEOF\n)"]
    # literal text: no shell runs it and the gate lets it pass
    LITERAL = ["echo a#b '$(R)'", ": # it's $(R)\n echo ok", ": # it's (maybe)\n echo ok", "cat <<'EOF'\nit's $(R)\nEOF", 'cat <<"EOF"\nit\'s $(R)\nEOF',
               "cat <<\\EOF\nit's $(R)\nEOF", "cat <<EOF\nit's \\$(R)\nEOF", "cat <<A <<'B'\nit's ok\nA\nit's $(R)\nB", "x=$(cat <<'EOF'\nit's fine\nEOF\n)",
               'echo "$(cat <<\'EOF\'\nit\'s fine\nEOF\n)"', "x=$(cat <<'EOF'\nit's $(R) it's\nEOF\n)", 'echo $((1<<2)) $[1<<2]', 'cat <<< "it\'s $(echo hi)"',
               'echo ${X:-a} ${X} ${#X} ${X#a} ${X:- b}', "echo '${ R; }'", "cat <<EOF\nit's ok\nEOF", "cat <<-EOF\n\tit's ok\n\tEOF",
               # the delimiter line of `<<-` may start with tabs; after it the apostrophes pair up again and the text is a literal
               "cat <<-EOF\n\tx\n\tEOF\necho it's $(R) don't",
               # a comment in a substitution holds a quote and a parenthesis
               "echo $( # it's here\n date)", "echo $( # ) it's\n date)",
               # a comment after the operator of a here-document: the body still starts on the next line
               "x=$(cat <<EOF # note\nit's fine\nEOF\n)", "cat <<EOF # note\nit's fine\nEOF"]
    # bash 5.3 only (the local bash is 3.2 and zsh has no such form): the gate refuses them, no oracle
    FUNSUB = ['x=${ R; }', 'x=${| R; }', 'echo "${ R; }"', 'echo $(echo ${ R; })', 'cat <<EOF\n${ R; }\nEOF', 'echo ${\n R\n}']

    def ran(self, shell, cmd):
        """Did `shell` run the ORACLE of the cell? None when the shell is not installed."""
        exe = shutil.which(shell)
        if not exe:
            return None
        p = subprocess.run([exe, '-c', cmd], cwd=self.root, capture_output=True, text=True, timeout=30,
                           stdin=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'HOME': self.root, 'LC_ALL': 'C'})
        return 'ORACLE' in p.stdout + p.stderr

    def cell(self, template, reader):
        """The template with the reader placed in it (a lone `R` stands for it)."""
        return re.sub(r'(?<![A-Za-z0-9_$%])R(?![A-Za-z0-9_])', lambda _m: reader, template)

    def test_a_comment_a_here_document_and_a_shift_do_not_hide_a_body(self):
        for tmpl in self.RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                # the cell is a real one: a shell runs the body (bash 3.2 mishandles two here-documents on one line)
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)

    def test_literal_text_in_a_comment_and_a_here_document_still_passes(self):
        for tmpl in self.LITERAL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')
                for sh in ('bash', 'zsh'):
                    if '$(R)' in tmpl or 'R;' in tmpl:
                        self.assertIn(self.ran(sh, self.cell(tmpl, self.ORACLE)), (False, None), '%s ran the text of %r' % (sh, tmpl))

    # F1 (review of the fixup): a `#` right behind a redirection operator is not a comment for bash 3.2 (the reviewer's
    # oracle runs the body there; the local /bin/bash 3.2.57 and zsh call these a syntax error, so no oracle here): refused.
    HASH_AFTER_REDIRECT = ['echo >#x $(R)', 'echo 2>#x $(R)', 'echo >&#x $(R)', 'echo a >>#x $(R)', 'echo a &>#x $(R)', 'echo a >|#x $(R)', 'echo a <>#x $(R)',
                           'echo a <#x $(R)', 'echo a <<<#x $(R)', 'cat <<EOF>#x $(R)\nbody\nEOF', 'echo x |&#x $(R)', 'echo ${X}#x $(R)']
    # L2 (review of fixup 2): behind `|`, `||`, `&`, `&&`, `(` and `)` a `#` DOES open a comment (both shells, the oracle below proves
    # it); the text of that comment is no code. Taking it for code opens a here-document or a quote in the comment that swallows the
    # real subshell bodies on the next lines.
    COMMENT_AFTER_CONTROL = ['echo x |#x $(R)', 'echo x &#x $(R)', 'echo x &&#x $(R)', 'echo x ||#x $(R)', '(#x $(R)\n:)', 'echo "a" |#x $(R)',
                             '(echo a)#x $(R)', "echo a &# it's (x)", "echo a |# <<EOF\nit's\nEOF"]
    COMMENT_SWALLOWS_BODY = ['echo a &# <<EOF\n(R)', 'echo a |# <<EOF\n(R)', 'echo a &# <<-EOF\n\t(R)', "echo a &# it's\n(R)\necho it's",
                             "echo a &# '\n(R)\n#'", 'echo a &# "\n(R)\n#"', 'echo &# $<<-EOF\n\t(R)', '(echo a)# <<EOF\n(R)', 'echo a && # <<EOF\n(R)',
                             'false ||# <<EOF\n(R)']
    # L3 (review of fixup 2): the shell removes a backslash-newline pair before it reads a substitution, so `$\<newline>(R)` is `$(R)`
    BACKSLASH_NEWLINE = ['echo "$\\\n(R)"', 'cat <<EOF\n$\\\n(R)\nEOF', 'echo ${X:-"$\\\n(R)"}', 'echo $\\\n(R)', 'echo "`\\\nR`"', 'echo a #\\\n$(R)']
    # R2 (review): the backslash-quote of an ANSI-C string flips the quote state of the finder; the pass without quote state sees the body
    ANSI_C = ["echo $'\\'' $(R) $'a' # '", "echo $'\\'' $(R) $'a'", "echo $'\\'' `R` $'a' # '"]

    def test_a_hash_behind_a_redirection_is_no_comment(self):
        for tmpl in self.HASH_AFTER_REDIRECT:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
        # the twins that really are comments
        for cmd in ["echo hi # it's (x)", "echo a; # it's", "echo a && # it's", "# it's\necho hi", "echo a\n# it's (\necho hi"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'ALLOW')

    def test_a_hash_behind_a_control_operator_is_a_comment(self):
        for tmpl in self.COMMENT_AFTER_CONTROL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')
                if '$(R)' in tmpl:      # the cell is a real one: no shell runs the text of the comment
                    for sh in ('bash', 'zsh'):
                        self.assertIn(self.ran(sh, self.cell(tmpl, self.ORACLE)), (False, None), '%s ran the comment of %r' % (sh, tmpl))

    def test_the_text_of_a_comment_after_a_control_operator_does_not_swallow_a_body(self):
        for tmpl in self.COMMENT_SWALLOWS_BODY:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)

    def test_a_backslash_newline_inside_a_substitution_opener_is_removed_before_the_search(self):
        for tmpl in self.BACKSLASH_NEWLINE:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)
        # a pair in a single-quoted text or in a comment is a literal: the joined text must not allow what the first reading refuses
        self.assertEqual(self.verdict("echo '$\\\n(ls docs)'"), 'ALLOW')
        self.assertEqual(self.verdict("echo a\\\n b"), 'ALLOW')

    # Fixup 6 (found by the mutation fuzz of the reviewer's shapes). A `(` that does not start a command is no subshell to zsh
    # (a glob group, a qualifier, a function header), so the `#x` behind its `)` is a word and the `$(R)` after it runs.
    GLUED_PAREN = ['}(echo a)#x $(R)', 'x(echo a)#x $(R)', 'echo (echo a)#x $(R)', 'echo ${X}(echo a)#x $(R)', 'echo "a"(echo a)#x $(R)',
                   'ech(o a )#x $(R)', 'ec|ho a (echo)#x $(R)']
    # The head of a command may be a substitution that expands to nothing: `$(true) grep -rn foo .` runs the grep, and so does a
    # backtick pair or a run of them, behind an assignment or a wrapper too.
    EMPTY_HEAD = ['$(a) R', '`a` R', '$(:)R', '$(a) $(b) R', 'x=1 $(a) R', 'nice $(a) R', 'echo hi; $(a) R', '$(a) R &', '`a` R `\n`&']

    # bash 3.2 expands the target word of `>&` and `<&` without quote removal, so a single-quoted substitution there runs (found by
    # the `>&` token of the fuzz; the local /bin/bash 3.2.57 runs it, zsh does not)
    # Fixup 8 (reviewer): the quote need not start the word. The whole word behind `>&` (up to an unquoted blank or operator) is
    # expanded that way: after an fd number, a plain word, a double-quoted part, a substitution or a parameter expansion.
    DUP_REDIRECT_RUNS = ["echo >&'$(R)'", ">&'$(R)'", ">& '$(R)'", ">&'`R`'", ">&'x'$(R)", ">&'\"$(R)\"(\"'",
                         "echo >&2'$(R)'", ">&x'$(R)'", '>&"x"\'$(R)\'', ">&$(true)'$(R)'", ">&${X}'$(R)'",
                         ">&${X:-a;b}'$(R)'", ">&${X:-a|b}'$(R)'", ">&x\\ y'$(R)'", ">&'a'b'$(R)'", ">&x'a b'y'$(R)'"]
    # a blank or an operator ends the word: the single-quoted text behind it is a literal (no shell runs it)
    DUP_REDIRECT_LITERAL = [">&x;'$(R)'", ">&x|'$(R)'", ">&x&'$(R)'", ">&x\n'$(R)'", ">&'a' '$(R)'", ">&x '$(R)'", ">&x;echo '$(R)'", ">&x|echo '$(R)'", ">&x&echo '$(R)'", ">&x\necho '$(R)'",
                            "|&'$(R)'", ">|'$(R)'", "echo '$(R)' >&2", "echo >&2 '$(R)'"]

    def test_a_single_quoted_target_of_a_dup_redirect_does_not_hide_a_body(self):
        for tmpl in self.DUP_REDIRECT_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)
        # `<&` is refused the same way though no local shell runs it (the cheaper reading is the safe one)
        self.assertEqual(self.verdict(self.cell("echo a <&'$(R)'", self.READER)), 'DENY')
        self.assertEqual(self.verdict(self.cell("echo a 2>&1'$(R)'", self.READER)), 'DENY')      # no shell runs it (a bad fd), same reading
        # a blank inside the `${ }` of the word does not end it (automated review of fixup 8). bash 3.2 and zsh call these an
        # ambiguous redirect, so none runs the body here; the gate keeps the one reading of the word, which a shell that splits
        # the expansion differently could run
        for tmpl in [">&${X:-a b}'$(R)'", ">&${X:-a\tb}'$(R)'", ">&${X:-a\nb}'$(R)'", ">&${X:-a b}\"x\"'$(R)'"]:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
        for tmpl in self.DUP_REDIRECT_LITERAL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')
                for sh in ('bash', 'zsh'):
                    self.assertIn(self.ran(sh, self.cell(tmpl, self.ORACLE)), (False, None), '%s ran the text of %r' % (sh, tmpl))
        # no body in the target, or no dup redirect: as before
        for cmd in ["echo hi >&'2'", "echo hi 2>&'1' ", ">'$(grep -rn zzmark .)'", "&>'$(grep -rn zzmark .)'", "echo '$(grep -rn zzmark .)' >&2"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'ALLOW')

    # Fixup 10 (reviewer): a `)` inside a `${ }` of the dup-redirect word (its default value, `${Y:-)}`) is not a real paren. The
    # subshell/`$( )`/backtick body-end finder (_bash_subst) had no case for `${ }` or `$[ ]` at all, so such a `)` ended the
    # enclosing body right there: the dup-word state built up inside the cut body was lost, and the single-quoted span after the
    # `}` (never reached inside that body) was read as an ordinary literal. The body is now skipped whole (as the matched-pair
    # scan of bash and zsh does), so the body end-finder sees the real end and the dup-word rule applies throughout.
    DUP_REDIRECT_SUBSHELL_RUNS = ["( echo >&2${Y:-)}'$(R)'\n)", "(echo >&2${Y:-)}'$(R)')", "( echo >&${Y:-)}'$(R)'\n)",
                                  "`echo >&2${Y:-)}'$(R)'`"]

    def test_a_paren_inside_a_braced_word_of_a_dup_redirect_does_not_end_the_subshell(self):
        for tmpl in self.DUP_REDIRECT_SUBSHELL_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)
        # `$( )` stays refused too, though neither local shell runs it (a syntax error): the cheaper reading is the safe one
        self.assertEqual(self.verdict(self.cell("x=$( echo >&2${Y:-)}'$(R)'\n)", self.READER)), 'DENY')
        # the mutant that reverts the fix (the span not skipped) truncates the body: a reader placed right after the closing
        # brace, outside any quote, proves the remainder is read as code either way
        self.assertEqual(self.verdict(self.cell('( echo >&2${Y:-)} ; R\n)', self.READER)), 'DENY')

    # A shell that reads its script from a here-document: the fuzz leaves these shapes out (STDIN_FED, the accepted limit of a
    # shell that reads stdin), so the refusals of today are pinned here. The body is judged line by line like any here-document
    # text (a reader written as text in a here-document is refused, `cat <<EOF` included); a harmless body passes, and
    # `echo B | bash` and `bash <<< B` stay the accepted limit.
    HEREDOC_TO_SHELL = ['bash <<EOF\nR\nEOF', 'bash <<-EOF\n\tR\n\tEOF', 'bash 0<<EOF\nR\nEOF', 'bash <<\\EOF\nR\nEOF', 'bash <<"EOF"\nR\nEOF',
                        "bash <<'EOF'\nR\nEOF", '{ bash; } <<EOF\nR\nEOF', '(bash) <<EOF\nR\nEOF', 'env bash <<EOF\nR\nEOF',
                        'x=1 bash <<EOF\nR\nEOF', 'exec bash <<EOF\nR\nEOF', 'sh -e <<EOF\nR\nEOF', 'dash <<EOF\nR\nEOF', 'ksh <<EOF\nR\nEOF',
                        'zsh <<EOF\nR\nEOF', 'source /dev/stdin <<EOF\nR\nEOF', 'bash <<A <<B\nR\nA\nB', "bash <<E'O'F\nR\nEOF"]

    def test_a_here_document_fed_to_a_shell_with_a_reader_in_it_is_refused(self):
        for tmpl in self.HEREDOC_TO_SHELL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(tmpl.replace('R', 'grep -rn zzmark .')), 'DENY')
                self.assertEqual(self.verdict(tmpl.replace('R', 'date')), 'ALLOW')

    # a `#` inside a `${ }` is no comment (an offset expression, a pattern): the text behind the `}` is code (found by a second seed of the mutation fuzz)
    HASH_IN_BRACES_RUNS = ['echo ${X: # -a}#x $(R)', 'echo $${X: # -a}#x $(R)', 'echo "${X: # -a}"#x $(R)']

    def test_a_hash_inside_a_parameter_expansion_is_no_comment(self):
        for tmpl in self.HASH_IN_BRACES_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
        self.assertTrue(any(self.ran(sh, self.cell(self.HASH_IN_BRACES_RUNS[0], self.ORACLE)) for sh in ('bash', 'zsh')))
        # a comment behind the expansion is still a comment
        for cmd in ['echo ${X} # $(grep -rn zzmark .)', 'echo ${X:-a} #x $(grep -rn zzmark .)', 'echo ${X: -1} # it\'s $(grep -rn zzmark .)']:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'ALLOW')

    def test_a_hash_behind_a_paren_that_starts_no_command_is_no_comment(self):
        for tmpl in self.GLUED_PAREN:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)
        # the twins at the start of a command stay comments (both shells)
        for cmd in ['(echo a)#x $(grep -rn zzmark .)', 'echo a;(echo a)#x $(grep -rn zzmark .)', 'echo a &(echo a)#x $(grep -rn zzmark .)',
                    'echo a\n(echo a)#x $(grep -rn zzmark .)', 'echo a && (echo a)#x $(grep -rn zzmark .)']:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'ALLOW')

    def test_a_head_that_can_expand_to_nothing_leaves_the_next_word_the_head(self):
        for tmpl in self.EMPTY_HEAD:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran %r' % tmpl)
        # a substitution that is an argument, or a head with nothing recursive behind it, keeps its verdict
        for cmd in ['echo $(date) grep -rn zzmark .', 'ls $(pwd)', '$(which ls) docs', '$(date)', 'x=$(date) ls docs']:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'ALLOW')
        # more empty heads than the depth cap: still judged (the last variant has every one dropped)
        self.assertEqual(self.verdict(' '.join(['$(a)'] * 20) + ' grep -rn zzmark .'), 'DENY')

    # Arithmetic (fixup 3, found by the differential fuzz): bash expands `$(( ))`, `$[ ]` and a `(( ))` command like a double-quoted
    # text. A `'` there shields nothing, `<<` is a shift (no delimiter word) and `#` is no comment, so a body stands where the
    # command reading of the same span sees a quote, a here-document or a comment. A `(( ))` command is arithmetic in zsh only.
    ARITH_RUNS = ["x=$(('$(R)'))", "echo $['$(R)']", "echo $[ 1 + '$(R)' ]", "((' $(R) '))", "(( '$(R)' ))", "x=$((1 <<'$(R)'))", 'x=$(( \'`R`\' ))',
                  "x=$(( $(echo 1) + $(( '$(R)' )) ))", "echo $[ $[ '$(R)' ] ]", "echo $[ ']' + '$(R)' ]", "echo $(( ')' + '$(R)' ))",
                  '((<<"$(R)"))', 'x=$((1<<"$(R)"))', "x=$(( <<'EOF'\"$(R)\"#))", "echo $[ 1<<'$(R)' ]",
                  # an arithmetic span inside an arithmetic span, found only by the double-quote reading of the outer one
                  "echo $[ '$(( '$(R)' ))' ]", "echo $(( '$[ '$(R)' ]' ))", "x=$(( 1 + $(( 2 + $(( '$(R)' )) )) ))",
                  # a `]` inside a nested substitution or parameter expansion does not close the `$[` (zsh runs the body behind it)
                  "echo $[ $(echo ]) + '$(R)' ]", "echo $[ `echo ]` + '$(R)' ]", "echo $[ ${x:-]} + '$(R)' ]",
                  # `$[ ]` inside double quotes (fixup 6): a quote in it is a quote to the scan, a literal to the arithmetic
                  'echo "$[ " \'$(R)\' " ]"', 'echo "$[ "\'$(R)\'" ]"', 'echo "$[ 1 + "\'$(R)\'" ]"', 'echo "$[ \'"\'$(R)\'"\' ]"',
                  # the reviewer's forms: an assignment, a word around the span, a parameter default, and the `$(( ))` of a double-quoted text
                  'x="$[ "\'$(R)\'" ]"', 'x="$[ " \'$(R)\' " ]"', 'echo "a $[ "\'$(R)\'" ] b"', 'echo "${X:-$[ "\'$(R)\'" ]}"',
                  'echo "$(( "\'$(R)\'" ))"', 'echo "$(( " \'$(R)\' " ))"', 'x="$(( "\'$(R)\'" ))"', 'echo "a $(( "\'$(R)\'" )) b"',
                  'echo "${X:-$(( "\'$(R)\'" ))}"', 'echo "$(( 1 + "\'$(R)\'" ))"']
    ARITH_LITERAL = ["echo $(( 1 )) '$(R)'", "echo $[ 1 ] '$(R)'", "echo $[ ']' ] '$(R)'", "echo $(( ')' )) '$(R)'", '(( x = 1 + 2 )); echo ok',
                     'echo $(( 1 + $(date +%s) ))', "echo $[ 1 + 2 ] $(( 3 << 1 )) 'it'", "echo $(( 1 << 2 ))'$(R)'", "x=$(( 1 + 2 )) # '$(R)'",
                     "echo $[ $(echo ]) + 1 ] '$(R)'", "echo $[ ${x:-]} + 1 ] '$(R)'",
                     'echo "$[ 1 ]" \'$(R)\'', 'echo "$[ "1" ]" \'$(R)\'', 'echo "$[ 1 + 2 ] $(date)" \'$(R)\'']

    def test_an_arithmetic_span_does_not_hide_a_body(self):
        for tmpl in self.ARITH_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)

    def test_an_arithmetic_span_with_no_body_in_it_still_passes(self):
        for tmpl in self.ARITH_LITERAL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')
                if '$(R)' in tmpl:      # the text after the span is a literal: no shell runs it
                    for sh in ('bash', 'zsh'):
                        self.assertIn(self.ran(sh, self.cell(tmpl, self.ORACLE)), (False, None), '%s ran the text of %r' % (sh, tmpl))

    # A quoted `}` inside `${ }` closes nothing, and no here-document starts inside it: `<<'E'` there is a pattern. The end of the
    # span used to be found by counting braces only, so the `<<'E'` behind a quoted `}` was read as a here-document whose body
    # swallowed the commands behind it (the body of the cell is then on the next line).
    PARAM_RUNS = ["echo ${X//'}'<<'E'/y}\n $(R)", 'echo ${X//"}"<<\'E\'/y}\n $(R)', "echo ${X//\\}<<'E'/y}\n $(R)", "echo ${X:-'}'<<E}\n $(R)",
                  "echo ${X//'}'<<'E'/y}\n `R`", 'x=${X//\'}\'<<"E"/y}\n $(R)', "${X//'}'<<'E'/y}\n $(R)", "echo ${X//'}'<<'E'/y} $(R)"]
    PARAM_LITERAL = ["echo ${X//'}'/y} ok", "cat <<'E'\n${X//'}'<<'E'/y}\nE\necho done", "echo ${X//'}'<<'E'/y}\n echo ok"]

    def test_a_quoted_closer_in_a_parameter_expansion_does_not_start_a_here_document(self):
        for tmpl in self.PARAM_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)
        for tmpl in self.PARAM_LITERAL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')

    # A closer that the plain count of `{` and `}` never reaches: a quoted or escaped opener (`${X:-'{'}`) is no opener to a shell,
    # and a bare one (`${X:-{}`) is none to bash 3.2 (zsh does not run that text), so the span is closed to it and open to the plain count. The end
    # of such a span used to be the end of the TEXT, which turned off the comment and here-document rules behind it: the `'` in
    # a comment (`# it's`) then opened a quote that swallowed the body behind it. The three first cells and the bare ones were
    # allowed by the gate of the previous fixup, and bash and zsh run the body in all of them.
    OPENER_RUNS = ["echo ${X:-'{'}\n# it's\n$(R)\n# '", "echo ${X:-\\{}\n# it's\n$(R)\n# '", 'echo ${X:-"{"}\n# it\'s\n$(R)\n# \'',
                   "echo ${X:-'{'}\n# it's\n`R`\n# '", "echo ${X:-'{'}\ncat <<'E'\nx\nE\n$(R)", "echo ${X:-{}\n# it's\n$(R)\n# '",
                   "echo ${X:-{}\ncat <<'E'\nit's\nE\n$(R)\n# '", "echo ${X:-{ <<'E'}\n$(R)", "echo ${X:-{ <<E}\n$(R)\nE",
                   "echo ${X//{<<'E'/y}\n$(R)", "x=${X:-'{'}\n# it's\n$(R)\n# '",
                   # a `$[ ]` that the plain count closes at a `]` of the text behind: the commands between the two ends are code
                   "echo $[ '[' ]\n(R)\n]", '$[ "[" ]\n(R)\n]', "echo $[ '[' ]\n# it's\n\n(R)\n# '", "$[ \\[ ]\n(R)\n}", "$[ \\[ ]<(R)\nE"]
    # a here-document or a comment behind such a span is still a here-document and a comment: the text in it is a literal
    OPENER_LITERAL = ["echo ${X:-'{'}\ncat <<'E'\n$(R)\nE\necho done", "echo ${X:-'{'}\n# it's $(R)\necho done", "echo ${X:-\\{}\ncat <<'E'\n$(R)\nE\n",
                      'echo ${X:-"{"}\ncat <<\'E\'\n$(R)\nE\n']
    # Nothing closes the span: a syntax error to every shell, nothing behind it runs, and the text behind is read as code
    # from the opener on (it was the end of the text: no comment and no here-document in it)
    UNCLOSED_LITERAL = ["echo ${X:-'{'\ncat <<'E'\n$(R)\nE\necho done", "echo $[ 1 \ncat <<'E'\n$(R)\nE\necho done",
                        "echo ${X\ncat <<'E'\n$(R)\nE\necho done"]

    def test_an_opener_that_the_plain_count_misses_does_not_turn_the_comment_rules_off(self):
        for tmpl in self.OPENER_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the body of %r' % tmpl)
        for tmpl in self.OPENER_LITERAL + self.UNCLOSED_LITERAL:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')
                for sh in ('bash', 'zsh'):
                    self.assertIn(self.ran(sh, self.cell(tmpl, self.ORACLE)), (False, None), '%s ran the text of %r' % (sh, tmpl))

    def test_a_text_that_burns_the_span_budget_is_refused_and_hides_nothing(self):
        # The end finders of the spans share a budget (linear time). A spent budget used to fall back to the end of the text, which
        # turns the comment rules off: a quote in a comment behind it then hid a body. It is a refusal now. (automated review)
        reader = '$(grep -rn zzmark .)'
        for burn in ['${' * 400, '$[ ' * 400, '${X:-\'{\'' * 400, '$[ ${X ] ' * 800, '$[ ' * 1500 + '1' + ' ]' * 1500]:
            with self.subTest(burn=burn[:12]):
                self.assertEqual(self.verdict('echo ' + burn + "\n${Y}\n# it's\n" + reader + "\n# '"), 'DENY')
        # an ordinary text with many closed spans does not come near the budget
        self.assertEqual(self.verdict('echo ' + '${X} $[1] ' * 500 + "# it's"), 'ALLOW')
        self.assertEqual(self.verdict('echo ' + '$[ $[ 1 ] ] ' * 100), 'ALLOW')

    def test_an_arithmetic_span_that_does_not_close_is_refused_when_a_body_in_it_does_not_close(self):
        self.assertEqual(self.verdict("echo $(( 1 + $(date"), 'DENY')
        self.assertEqual(self.verdict("echo $[ 1 + $(date"), 'DENY')

    @unittest.expectedFailure
    def test_an_ansi_c_string_cannot_hide_a_body(self):
        # R2 (review): RED until commit 3 reads a `$'...'` span by bash's rule (a backslash escapes the next character, the quote
        # included) BEFORE the finder runs. The quote-blind pass that had refused these was retracted, and the reviewer decided
        # against an interim rule: the merge criterion is zero expectedFailure here.
        for tmpl in self.ANSI_C:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')

    def test_an_ansi_c_twin_and_a_literal_quoted_substitution_still_pass(self):
        self.assertEqual(self.verdict("echo $'\\'' ls $'a' # '"), 'ALLOW')
        self.assertEqual(self.verdict("echo $'a' $(date)"), 'ALLOW')
        self.assertEqual(self.verdict("echo '$(grep -rn foo .)'"), 'ALLOW')
        # text in a quoted here-document
        self.assertEqual(self.verdict("git commit -m \"$(cat <<'EOF'\nsubject $(grep -rn foo .)\nEOF\n)\""), 'ALLOW')

    def test_a_funsub_is_refused_and_a_plain_expansion_is_not(self):
        for tmpl in self.FUNSUB:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                self.assertEqual(self.verdict(self.cell(tmpl, 'date')), 'DENY')      # whatever it runs: the form is refused
        for cmd in ['echo ${X}', 'echo ${X:-a}', 'echo ${#X}', 'echo "${X:- b}"', 'echo ${X// /}', "echo '${ date; }'", 'echo \\${ date; }']:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.verdict(cmd), 'ALLOW')

    # Commit 2: the text another shell is handed. The string of `bash -c` (sh, zsh, dash, ksh) and the arguments of `eval` are
    # judged like the body of a substitution, wherever the shell word stands (behind a wrapper with options, `xargs`, `find -exec`).
    EXEC_RUNS = ["bash -c 'R'", 'bash -c "R"', "sh -c 'R'", "zsh -c 'R'", 'dash -c "echo hi; R"', "bash -lc 'R'", "bash -ec 'R'", "bash -xc 'R'",
                 "bash -c -l 'R'", "bash -o pipefail -c 'R'", "bash +o history -c 'R'", "bash -O extglob -c 'R'", "bash --norc -c 'R'",
                 "bash --rcfile /dev/null -c 'R'", "bash -c -- 'R'", "bash -c 'R' name arg", "/bin/bash -c 'R'", "env bash -c 'R'", "env -i bash -c 'R'",
                 "nohup sh -c 'R' &", 'eval "R"', 'eval R', "eval -- 'R'", "echo x | xargs sh -c 'R'", "echo x | xargs -I{} bash -c 'R'",
                 "find . -maxdepth 0 -exec sh -c 'R' \\;", "find . -maxdepth 0 -exec sh -c 'R' {} +", "bash -c 'bash -c \"R\"'",
                 'bash -c "bash -c \\"R\\""', "bash -c 'echo $(R)'", "echo ok; bash -c 'R'", "x=$(bash -c 'R')", 'echo "$(bash -c \'R\')"',
                 "bash -c 'R' # it's", "cat <<EOF\nx\nEOF\nbash -c 'R'", "bash -c 'x=1; R'", "bash -c 'echo a | R'",
                 # a shift is no here-document: the line behind it is still read
                 '(( x = 1 <<"2" ))\n bash -c \'R\'', 'echo $[1<<"2"]\n bash -c \'R\'', 'cat <<< "x"\n bash -c \'R\'',
                 # the here-document of the command line ends, the next line is a command again
                 "cat <<'EOF'\nit's\nEOF\nbash -c 'R'", "cat <<-EOF\n\tx\n\tEOF\neval R",
                 # a shift or a pattern in a parameter expansion is no here-document, the lines behind it are read
                 "echo ${X//<<'E'/y}\n bash -c 'R'", "echo ${X//<<E/y}\n bash -c 'R'", "echo ${X:-<<'E'}\n eval R",
                 # the word that would be the shell is a variable or a glob: followed by a -c cluster it is taken for one
                 "sh=bash; $sh -c 'R'", "/bin/ba?h -c 'R'", "sh=bash; $sh -lc 'R'"]
    # no reader: allowed; with a reader in a place that is no command string of a shell: allowed too
    EXEC_PLAIN = ["bash -c 'echo hi'", 'bash -c "grep -rn foo src"', "sh -c 'ls docs'", 'bash script.sh', "bash script.sh -c 'R'", "bash -x script.sh 'R'",
                  'eval echo hi', 'eval "ls docs"', "eval 'echo hi' 'R'", 'xargs -a /dev/null sh -c "ls docs"', 'grep -rn bash src', 'echo eval',
                  'ls bash', "echo it's fine", "bash -c 'echo it'\"'\"'s fine'", "cat <<'EOF'\nbash -c \"R\"\nEOF", 'echo $((1<<2)) $[1<<2] && bash -c "ls docs"',
                  'git commit -m "use sh -c \'R\' here"']

    def test_the_string_of_a_shell_and_the_arguments_of_eval_are_judged(self):
        for tmpl in self.EXEC_RUNS:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran %r' % tmpl)

    def test_an_option_the_gate_does_not_know_leaves_every_later_word_a_text(self):
        # a long option that is no known one may take a value: where the string is, is not decided, so each later word is judged
        # (no local shell takes the option, hence no oracle)
        for tmpl in ["bash --weird -c 'R'", "bash --weird script.sh 'R'", "bash --weird 'R'", "sh --weird=1 -c 'R'", "bash --weird='R'",
                      "fish --init-command='R'", "fish -C 'R'", "ksh -T x -c 'R'", "rbash -c 'R'", "rksh -c 'R'", "busybox sh -c 'R'"]:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
        self.assertEqual(self.verdict("bash --weird script.sh 'ls docs'"), 'ALLOW')

    def test_a_shell_that_runs_a_script_or_a_plain_text_is_not_refused(self):
        for tmpl in self.EXEC_PLAIN:
            with self.subTest(cell=tmpl):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'ALLOW')
                for sh in ('bash', 'zsh'):
                    self.assertIn(self.ran(sh, self.cell(tmpl, self.ORACLE)), (False, None), '%s ran %r' % (sh, tmpl))

    def test_a_string_in_the_string_is_found_to_the_depth_cap(self):
        def nest(inner, levels):
            for _ in range(levels):
                inner = 'bash -c "%s"' % inner.replace('\\', '\\\\').replace('"', '\\"')
            return inner
        self.assertEqual(self.verdict(nest('ls docs', 7)), 'ALLOW')
        self.assertEqual(self.verdict(nest(self.READER, 7)), 'DENY')
        self.assertEqual(self.verdict(nest('ls docs', 14)), 'DENY')      # past the depth cap: refused, never allowed unread
        self.assertEqual(self.verdict(nest(self.READER, 14)), 'DENY')

    def test_too_many_shells_in_one_command_are_refused(self):
        self.assertEqual(self.verdict('echo ' + 'bash ' * 32), 'ALLOW')
        self.assertEqual(self.verdict('echo ' + 'bash ' * 33), 'DENY')

    def test_an_unreadable_text_that_names_a_shell_is_refused(self):
        self.assertEqual(self.verdict("bash -c 'ls docs"), 'DENY')
        self.assertEqual(self.verdict("sh -c \"ls docs"), 'DENY')
        self.assertEqual(self.verdict("echo it's fine"), 'ALLOW')      # plain prose keeps its verdict

    def test_the_reason_of_a_refused_string_does_not_quote_it(self):
        rc, out, err = self.bash("bash -c 'grep -rn zzmark .'")
        self.assertEqual(rc, 2)
        self.assertNotIn('zzmark', err)
        self.assertNotIn(self.root, err)

    def test_a_command_longer_than_the_scan_limit_is_refused(self):
        # every scan stops at MAX_TEXT characters: a reader behind that point was never seen and the text passed on its head
        limit = self.mod.MAX_TEXT
        pad = ' ' * limit
        for tmpl in ['true' + pad + '\nR', 'true' + pad + '; R', 'x=1' + pad + '\nx=$(R)', 'true' + pad + "\nbash -c 'R'"]:
            with self.subTest(cell=tmpl[:6] + '...' + tmpl[-16:]):
                self.assertEqual(self.verdict(self.cell(tmpl, self.READER)), 'DENY')
                shells = [self.ran(sh, self.cell(tmpl, self.ORACLE)) for sh in ('bash', 'zsh')]
                if all(s is None for s in shells):
                    self.skipTest('no shell installed')
                self.assertTrue(any(shells), 'no shell ran the reader behind the limit')

    def test_the_scan_limit_is_exact_and_a_command_under_it_keeps_its_verdict(self):
        limit = self.mod.MAX_TEXT
        self.assertEqual(self.verdict('echo ' + 'a' * (limit - 5)), 'ALLOW')           # exactly the limit
        self.assertEqual(self.verdict('echo ' + 'a' * (limit - 4)), 'DENY')            # one character over
        self.assertEqual(self.verdict('cat <<EOF\n' + 'it is fine\n' * 10000 + 'EOF'), 'ALLOW')      # a long here-document under the limit
        self.assertEqual(self.verdict('echo ' + 'a' * (limit - 5 - 16) + '\ngrep -rn foo .'), 'DENY')      # a reader inside the limit

    def test_the_reason_of_a_command_over_the_limit_does_not_quote_it(self):
        rc, out, err = self.bash('echo zzmark ' + 'a' * self.mod.MAX_TEXT)
        self.assertEqual(rc, 2)
        self.assertNotIn('zzmark', err)

    def test_the_reason_of_a_refused_funsub_does_not_quote_it(self):
        rc, out, err = self.bash('x=${ grep -rn zzmark .; }')
        self.assertEqual(rc, 2)
        self.assertNotIn('zzmark', err)


class ScannerDifferentialFuzz(Tree):
    """Seeded differential fuzz on the alphabet of the body scanner (fixup 2 review rules). Each case is a random string of
    scanner-relevant tokens with ONE body in it, `$(B)` or a backtick pair. The oracle runs the case in bash 3.2 and zsh with
    B = a printer of EXEC; if either shell RUNS it, the gate (B = a recursive grep over the install root) must refuse it.
    Over-refusal is fine, a hole is not. The `$'` token is not in the alphabet before commit 3 (R2 is red until then, see
    test_an_ansi_c_string_cannot_hide_a_body). The printer is `printf %s%s EX EC`: its own text does not contain EXEC, so
    the echo of a never-run text (a "command not found" line, the body of a heredoc that cat prints) cannot pass for a run."""
    SEED, CASES = 20261112, 6000
    TOKENS = ["'", '"', '\\', '#', '$(', ')', '(', '`', '<<EOF', '<<-EOF', "<<'EOF'", '\nEOF\n', '\n', '<', '>', '>#', ' ', ' ', 'a', ';', '|', '&', '{', '}', '${', '$[', ']', '$((', '))', '\t', '\\\n', '<<<', '\n\tEOF\n', '$',
              # fixup 6: a comment opener glued behind an operator, a line continuation on its own and after a `$` or a here-document operator
              '&#', '|#', ')#', ';#', '(#', '$\\\n', '<<EOF\\\n', ' #', '>&', '|&', '&&', '||', '2>', '!']
    BODIES = ['$(B)', '`B`', '"$(B)"', '<(B)', '(B)']
    # contexts that put the body INSIDE another span, so the scanner has to carry a quote / comment / heredoc state into it
    WRAPS = [('$(', ')'), ('$(', ')'), ('"', '"'), ("'", "'"), ('`', '`'), ('<(', ')'), ('(', ')'), ('{ ', '; }'), ('$((', '))'),
             ('<<EOF\n', '\nEOF\n'), ('$(cat <<EOF\n', '\nEOF\n)'), ('$(: ', ')')]

    @classmethod
    def templates(cls, n):
        """n templates, each with exactly one `B` (the body), from a seeded stream: random tokens around the body, in 0 to 2 wrappers."""
        import random
        rng = random.Random(cls.SEED)
        out = []
        for _ in range(n):
            parts = [rng.choice(cls.TOKENS) for _ in range(rng.randint(1, 6))]
            parts.insert(rng.randint(0, len(parts)), rng.choice(cls.BODIES))
            t = ''.join(parts)
            for _ in range(rng.choice((0, 1, 1, 2))):
                o, c = rng.choice(cls.WRAPS)
                t = ''.join(rng.choice(cls.TOKENS) for _ in range(rng.randint(0, 2))) + o + t + c + ''.join(rng.choice(cls.TOKENS) for _ in range(rng.randint(0, 2)))
            if t.count('B') == 1:
                out.append(t)
        return out

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib.util
        spec = importlib.util.spec_from_file_location('gate_under_test_fuzz', cls.gate)
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    def gate_denies(self, cmd):
        try:
            self.mod.check_bash(cmd, self.root)
        except self.mod.Block:
            return True
        return False

    def holes_among(self, templates):
        """(holes, n): the templates that a shell runs the body of and that the gate lets through, and how many ran a body."""
        shells = [s for s in ('bash', 'zsh') if shutil.which(s)]
        holes, ran_n = [], 0
        for template in templates:
            # The printer also prints the subshell level, so `EXEC1` or more is a body that ran and `EXEC0` a stand-in that ran as a
            # command of its own. Only the first counts: a stand-in behind an empty substitution that is glued to it (`$(:)grep ...`
            # runs grep) passes the gate in the base too. That is a word-expansion hole older than the body scanner (parking
            # list), not a body that the scanner hides. B is a word of its own (a space on both sides) for the same reason.
            exec_text = template.replace('B', ' printf %s%s%s%s EX EC $BASH_SUBSHELL $ZSH_SUBSHELL >&2 ')
            ran = False
            for sh in shells:
                # a directory of its own for every run: a redirect in a template creates files, and a later `find .` or `ls` would
                # list the name of one (a name with the marker in it) as if a body had printed it
                with tempfile.TemporaryDirectory() as cwd:
                    try:
                        p = subprocess.run([shutil.which(sh), '-c', exec_text], cwd=cwd, capture_output=True, timeout=10,
                                           stdin=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'HOME': cwd, 'LC_ALL': 'C'})
                    except subprocess.TimeoutExpired:
                        continue
                ran = ran or re.search(rb'EXEC[1-9]', p.stderr + p.stdout) is not None      # bytes: a shell may print a byte that is not UTF-8
            if ran:
                ran_n += 1
                if not self.gate_denies(template.replace('B', ' grep -rn foo . ')):
                    holes.append(template)
        return holes, ran_n

    def test_no_case_that_a_shell_runs_passes_the_gate(self):
        import resource
        if not [s for s in ('bash', 'zsh') if shutil.which(s)]:
            self.skipTest('no bash or zsh installed: the differential fuzz has no oracle')
        before = resource.getrusage(resource.RUSAGE_SELF)
        holes, ran_n = self.holes_among(self.templates(self.CASES))
        used = resource.getrusage(resource.RUSAGE_SELF)
        self.assertGreater(ran_n, 100, 'the fuzz is not exercising the oracle (%d cases ran a body)' % ran_n)
        self.assertEqual(holes, [], '%d of %d cases that a shell runs pass the gate, first: %r' % (len(holes), ran_n, holes[:5]))
        self.assertLess(used.ru_utime + used.ru_stime - before.ru_utime - before.ru_stime, 60.0)

    # Known shapes, mutated (fixup 6): a random token string almost never reaches a 4-6 token shape such as `&#` + a quote + a
    # newline + a body, so the seeds are shapes that a shell is known to run, with one to three atoms inserted or cut out.
    # Left out, as accepted limits of the gate (see _judge): a shell fed through stdin (`echo B | bash`, `bash <<< B`, `source
    # /dev/stdin`), a script written and run in two commands, and a text built at run time (`bash -c "$x"`).
    SEED_SHAPES = [
        '(echo a)#x $(B)',
        'echo $(echo a)#x $(B)',
        'echo `ls`#x $(B)',
        'echo ${X}#x $(B)',
        'echo >&#x $(B)',
        'echo 2>#x $(B)',
        'cat <#x\n$(B)',
        'echo }#x $(B)',
        'echo $((1))#x $(B)',
        'echo ${X:-a}#x $(B)',
        'echo x &&#x $(B)',
        'echo x ||#x $(B)',
        'echo x |&#x $(B)',
        'echo\t#x $(B)',
        'echo "a" \\\n  #x $(B)',
        'cat <(#x\nB)',
        'echo a <#x $(B)',
        'echo a >>#x $(B)',
        'echo a &>#x $(B)',
        'echo a >|#x $(B)',
        'echo a <>#x $(B)',
        'echo a <<<#x $(B)',
        'cat <<EOF>#x $(B)\nEOF',
        'cat <<EOF #x\n$(B)\nEOF',
        'echo a; #x\n$(B)',
        'echo $( #x\nB)',
        'echo x{#x,y} $(B)',
        'echo ~#x $(B)',
        'echo a=#x $(B)',
        'echo x:#x $(B)',
        'echo \\#x $(B)',
        "echo '#'x $(B)",
        'echo "#" $(B)',
        'bash -c "B"',
        "sh -c 'B'",
        'zsh -c "B"',
        'eval "B"',
        'eval B',
        'bash -lc "B"',
        'bash -ec "B"',
        'bash -c "echo a; B"',
        'bash -c "echo a\nB"',
        'env -i bash -c "B"',
        'env FOO=1 bash -c "B"',
        'timeout 5 bash -c "B"',
        'nice bash -c "B"',
        'echo | xargs sh -c "B"',
        'find . -maxdepth 0 -exec sh -c "B" \\;',
        'bash -c "bash -c \\"B\\""',
        'eval "eval \\"B\\""',
        'bash -o pipefail -c "B"',
        'bash +o history -c "B"',
        'bash --norc -c "B"',
        'bash -c "B" _ arg',
        'bash -c -- "B"',
        'bash -c "B" # it\'s',
        'bash -c "echo it\'s; B"',
        'sh -c "echo \'x\'; B"',
        "bash --noprofile --norc -c 'B'",
        "bash --rcfile /dev/null -c 'B'",
        "bash --bogus -c 'B'",
        'bash script.sh -c "B"',
        'echo bash -c "B"',
        'echo hi | sh -c "B"',
        '(bash -c "B")',
        'x=$(bash -c "B")',
        '{ bash -c "B"; }',
        'if true; then eval "B"; fi',
        'bash -c "B" &',
        'eval -- "B"',
        'eval echo a ";" B',
        'cat <<EOF | sh -c "B"\nx\nEOF',
        'echo ${X: # -a}#x $(B)',
        'echo "$[ "\'$(B)\'" ]"',
        'echo "$(( "\'$(B)\'" ))"',
        # the target word of a dup redirect (bash 3.2 keeps its quotes): the quote need not start the word
        "echo >&2'$(B)'",
        ">&x'$(B)'",
        '>&"x"\'$(B)\'',
        ">&$(true)'$(B)'",
        ">&${X:-a b}'$(B)'",
        "echo >&'$(B)'",
    ]
    MUTATION_ATOMS = ["'", '"', "\\", "#", " #", "\n", ";", "|", "&", ">", "<", "<<", "<<EOF\n", "\nEOF\n", ">#x", "<<<", "${", "}", "$(", ")",
                      "(", "`", "$[", "]", "((", "))", "a", " ", "{", "$", "echo ", "<<'E'\n", "\nE\n", " # ", "\\\n", "&&", "||", "<(", ">(",
                      "${X:-", "${X#", "${X//", "'a'", '"a"', '$"', "case x in x) ", ";;", "2>", "<&", ">&", "|&", "{ ", "; }", "! ",
                      "if true; then ", "; fi", "<<-EOF\n\t", "\n\tEOF\n", "\\'", '\\"', "$((", "$( ", " )", "&#", "|#", ")#", "$\\\n", "<<EOF\\\n"]
    MUTATION_CASES = 3000

    @classmethod
    def mutated_templates(cls, n):
        import random
        rng = random.Random(cls.SEED + 1)
        out = []
        for _ in range(n):
            t = rng.choice(cls.SEED_SHAPES)
            for _ in range(rng.randint(1, 3)):
                pos = rng.randint(0, len(t))
                op = rng.random()
                if op < 0.6:
                    t = t[:pos] + rng.choice(cls.MUTATION_ATOMS) + t[pos:]
                elif op < 0.8 and len(t) > 3:
                    q = rng.randint(0, len(t) - 1)
                    t = t[:q] + t[q + 1:]
                else:
                    q = rng.randint(0, len(t))
                    t = t[:min(pos, q)] + t[max(pos, q):]
                if t.count('B') != 1:
                    t = t.replace('B', '') + rng.choice(cls.BODIES)
            # the ANSI-C `$'` is the content of commit 3 (see the class docstring and test_an_ansi_c_string_cannot_hide_a_body)
            if t.count('B') == 1 and "$'" not in t and not cls.STDIN_FED.search(t):
                out.append(t)
        return out

    # a shell that reads its script from stdin (a here-document or here-string to it, a pipe into it) without a `-c` string:
    # the accepted limit above, whatever the mutation made of a seed
    STDIN_FED = re.compile(r'\b(?:ba|z|da|k)?sh\b(?![^\n;|&]*\s-\w*c\b)[^\n;|&]*<<|\|\s*(?:ba|z|da|k)?sh\b(?!\s+-\w*c\b)')

    def test_no_mutated_known_shape_that_a_shell_runs_passes_the_gate(self):
        import resource
        if not [s for s in ('bash', 'zsh') if shutil.which(s)]:
            self.skipTest('no bash or zsh installed: the differential fuzz has no oracle')
        before = resource.getrusage(resource.RUSAGE_SELF)
        holes, ran_n = self.holes_among(self.mutated_templates(self.MUTATION_CASES))
        used = resource.getrusage(resource.RUSAGE_SELF)
        self.assertGreater(ran_n, 100, 'the mutation fuzz is not exercising the oracle (%d cases ran a body)' % ran_n)
        self.assertEqual(holes, [], '%d of %d cases that a shell runs pass the gate, first: %r' % (len(holes), ran_n, holes[:5]))
        self.assertLess(used.ru_utime + used.ru_stime - before.ru_utime - before.ru_stime, 60.0)

if __name__ == '__main__':
    unittest.main(verbosity=1)
