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


def forms(tree, rel):
    """Every way a path to the protected file `rel` can be spelled for a file tool, from the install root."""
    sym, rsym, hard = tree.links[rel]
    abs_p = tree.p(rel)
    return [abs_p, rel, './' + rel, tree.p('src', '..', rel), tree.p(os.path.dirname(rel) or '.', '.', os.path.basename(rel)),
            tree.p(sym), sym, tree.p(rsym), tree.p(hard), 'work/../' + rel, 'file://' + abs_p, 'FILE://localhost' + tree.p(hard),
            'file://' + tree.p(sym), abs_p.replace(os.path.basename(abs_p), os.path.basename(abs_p).upper())]


class FileToolsOnEveryTokenFile(Tree):
    def test_every_spelling_of_every_file_is_blocked(self):
        for rel in PROTECTED:
            for path in forms(self, rel):
                for tool, ti in [('Read', {'file_path': path}), ('Write', {'file_path': path, 'content': 'x'}),
                                 ('mcp__filesystem__read_text_file', {'path': path}), ('mcp__x__y', {'q': path}),
                                 ('mcp__filesystem__move_file', {'source': self.p('work', 'a.txt'), 'destination': path})]:
                    with self.subTest(file=rel, path=path, tool=tool):
                        self.assert_denied_b(self.run_gate(tool, ti), '%s %s' % (tool, path), os.path.basename(rel))

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

    def test_exclude_of_the_token_name_lets_a_legitimate_search_through(self):
        for cmd, cwd in [('grep -r foo agents/agent-a --exclude=.agent-token', None), ('grep -rn --exclude=.agent-token foo agents', None),
                         ('grep -r --exclude .agent-token foo agents/agent-b', None), ('grep -r foo . --exclude=.agent-token', self.p('agents', 'agent-a')),
                         ('grep -r foo --exclude=.agent-token', self.p('agents', 'agent-a')), ("grep -r --exclude='.agent-*' foo agents", None),
                         ('grep -r --exclude-dir=agents --exclude-dir=store --exclude=.agent-token foo agents/..', None),
                         ('grep -r --exclude-dir=store --exclude-dir=agents --exclude=.agent-token foo .', None), ('rg foo agents', None), ('rg -g "*.md" foo agents', None)]:
            with self.subTest(cmd=cmd, cwd=cwd):
                self.assert_allowed(self.bash(cmd, cwd=cwd), cmd)

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
        for cmd in ['grep -rn --include=*.md --exclude=.agent-token foo agents', 'grep -r --exclude .agent-token --include *.md foo agents',
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


if __name__ == '__main__':
    unittest.main(verbosity=1)
