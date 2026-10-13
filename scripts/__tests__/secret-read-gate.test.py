#!/usr/bin/env python3
"""Tests for scripts/hooks/secret-read-gate.py (the PreToolUse read guard for store/.claim-signing-key).

The gate runs as a subprocess inside a throw-away install tree (its own store/ with a key file, a symlink to the
key, a symlink to the store directory, a hard link to the key), fed a JSON hook payload on stdin. Every refusal
is checked for exit 2 AND the reason on stderr; every allow for exit 0 and an empty stderr.

  1. Bash: the name in every spelling, globs, recursive readers, paths that resolve to the key.
  2. Read / Edit / Write / NotebookEdit / Grep / Glob: direct, via a symlink, a hard link, `..` segments, globs.
  3. Calls that are not about the key pass.
  4. Fail closed: bad input, an internal error, a part that does not load; no switch relaxes it.

Run: python3 <thisfile>   (SECRET_GATE_PATH names a gate file other than scripts/hooks/secret-read-gate.py)
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
GATE_SRC = os.environ.get('SECRET_GATE_PATH') or os.path.join(SCRIPTS, 'hooks', 'secret-read-gate.py')
KEY = 'a1' * 32
NAME = '.claim-signing-key'


class GateCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = os.path.realpath(tempfile.mkdtemp(prefix='secret-gate-'))
        for rel in ('scripts/hooks', 'store', 'src', 'work'):
            os.makedirs(os.path.join(cls.root, rel))
        shutil.copy(GATE_SRC, os.path.join(cls.root, 'scripts/hooks/secret-read-gate.py'))
        cls.gate = os.path.join(cls.root, 'scripts/hooks/secret-read-gate.py')
        cls.write('store/' + NAME, KEY)
        cls.write('store/rules.json', '{}')
        cls.write('scripts/gmail-send.py', '# claims an approval\n')
        cls.write('src/a.ts', 'export const claim = 1\n')
        os.symlink(os.path.join(cls.root, 'store', NAME), os.path.join(cls.root, 'work', 'keylink'))
        os.symlink('../store', os.path.join(cls.root, 'work', 'storelink'))
        os.symlink(os.path.join(cls.root, 'store'), os.path.join(cls.root, 'work', 'storelink-abs'))
        os.link(os.path.join(cls.root, 'store', NAME), os.path.join(cls.root, 'work', 'innocent-name.txt'))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    @classmethod
    def write(cls, rel, text):
        with open(os.path.join(cls.root, rel), 'w', encoding='utf-8') as fh:
            fh.write(text)

    def run_gate(self, tool, tool_input, cwd=None, raw=None, extra_env=None):
        payload = raw if raw is not None else json.dumps({'tool_name': tool, 'tool_input': tool_input, 'cwd': cwd or self.root})
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.root}
        env.update(extra_env or {})
        p = subprocess.run([sys.executable, self.gate], input=payload.encode(), capture_output=True, env=env, timeout=30)
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')

    def bash(self, command, cwd=None):
        return self.run_gate('Bash', {'command': command}, cwd=cwd)

    def assert_denied(self, result, label=''):
        rc, out, err = result
        self.assertEqual(rc, 2, '%s: expected a block, got rc=%s stderr=%r' % (label, rc, err))
        self.assertEqual(out, '')
        self.assertIn('SECRET READ GATE: BLOCKED', err)
        self.assertNotIn(KEY, err)

    def assert_allowed(self, result, label=''):
        rc, out, err = result
        self.assertEqual((rc, out, err), (0, '', ''), label)


class BashReads(GateCase):
    def test_every_reader_of_the_file_is_blocked(self):
        for cmd in ['cat store/' + NAME, 'head -c 5 store/' + NAME, 'less store/' + NAME, 'base64 store/' + NAME, 'xxd store/' + NAME,
                    'tail -n1 ' + os.path.join('store', NAME), 'cat ' + os.path.join('%ROOT%', 'store', NAME), 'awk 1 store/' + NAME,
                    "python3 -c \"print(open('store/%s').read())\"" % NAME, "node -e \"console.log(require('fs').readFileSync('store/%s','utf8'))\"" % NAME,
                    'cp store/%s /tmp/x' % NAME, 'ln -s store/%s /tmp/k' % NAME, 'sed -n p store/' + NAME, 'strings store/' + NAME,
                    'env FOO=1 cat store/' + NAME, 'echo hi; cat store/' + NAME, 'true && cat store/' + NAME, 'cat < store/' + NAME,
                    'echo $(cat store/%s)' % NAME, 'xargs cat <<< store/' + NAME]:
            cmd = cmd.replace('%ROOT%', self.root)
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_globs_that_can_match_the_file_are_blocked(self):
        for cmd in ['cat store/.claim*', 'cat store/.c*', 'cat store/.[c]*', 'cat store/.*', 'cat store/*', 'cat store/.claim?signing*', 'cat store/.cl?im-sig*',
                    'cat *signing-key*', 'cat store/*key', 'cat store/.{claim-signing-key,x}', 'cat store/.[a-z]*', 'cat ../store/.cl*',
                    'cat store/.claim-signing-ke?', 'cat .claim-signing-key', 'cat ./store/./.c*', 'cat store//.claim*']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_bash_only_bracket_spellings_that_can_match_the_file_are_blocked(self):
        # bash negates a bracket with ^ as well as !, and knows POSIX classes; fnmatch knows neither
        for cmd in ['cat store/.[^x]*', 'cat store/.[^a-b]l*', 'cat store/.[!x]*', 'cat store/.[[:lower:]]*', 'cat store/[[:punct:]][[:lower:]]*',
                    'cat ../store/.[^x]*', 'cat -- store/.[^x]*', 'cat store/.cl[^x]im-signing-key']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        self.assert_allowed(self.bash('cat store/rules.[^x]son'))      # cannot select the key

    def test_quoted_escaped_and_concatenated_name_fragments_are_blocked(self):
        for cmd in ["cat store/.claim-sig''ning-key", 'cat store/.claim-sig""ning-key', 'cat "store/.claim-sign"\'ing-key\'',
                    'cat store/.claim\\-signing-key', 'cat store/.cl""aim-signing-key', 'cat store/$\'.claim-signing-key\'',
                    "python3 -c \"print(open('store/'+'.claim-'+'signing-key').read())\"",
                    "python3 -c \"print(open('store/'+'%s'[::-1]).read())\"" % NAME[::-1],
                    'cat store/`echo .claim-signing-key`', "cat store/'.'claim-signing-key", 'cat store/.CLAIM-SIGNING-KEY']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_hex_and_base64_spellings_of_the_name_are_blocked(self):
        hexed = NAME.encode().hex()
        for cmd in ["python3 -c \"print(open(bytes.fromhex('%s').decode()).read())\"" % hexed,
                    "python3 -c \"print(open(bytes.fromhex('%s').decode()).read())\"" % hexed.upper(),
                    'printf "\\x2e\\x63\\x6c\\x61\\x69\\x6d-signing-key"']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        for pad in (0, 1, 2):
            enc = base64.b64encode(b'\x00' * pad + NAME.encode()).decode()
            with self.subTest(pad=pad):
                self.assert_denied(self.bash('echo %s | base64 -d | xargs cat' % enc), 'base64 pad %d' % pad)
        urlsafe = base64.urlsafe_b64encode(b'xx' + NAME.encode()).decode()
        self.assert_denied(self.bash('echo %s | base64 -d' % urlsafe), 'urlsafe')

    def test_a_path_that_resolves_to_the_key_is_blocked(self):
        for cmd in ['cat work/keylink', 'cat work/innocent-name.txt', 'cat work/storelink/.c*', 'cat work/storelink/.*', 'cat work/storelink-abs/.*',
                    'cat work/storelink/' + NAME, 'cat work/../store/.cl*', 'ls work/keylink && cat work/*link']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_a_relative_path_is_taken_from_the_calls_cwd(self):
        sub = os.path.join(self.root, 'scripts')
        self.assert_denied(self.bash('cat ../store/.cl*', cwd=sub), 'glob from scripts/')
        self.assert_denied(self.bash('cat ../work/keylink', cwd=sub), 'symlink from scripts/')
        self.assert_denied(self.bash('cat ../work/innocent-name.txt', cwd=sub), 'hard link from scripts/')
        self.assert_denied(self.bash('cat .claim*', cwd=os.path.join(self.root, 'store')), 'from store/')
        self.assert_allowed(self.bash('cat gmail-send.py', cwd=sub), 'an ordinary file from scripts/')

    def test_recursive_readers_over_a_directory_that_holds_the_store_are_blocked(self):
        for cmd in ['grep -r foo store', 'grep -rn foo .', 'grep -R foo ' + '%ROOT%', 'grep -r foo', 'grep --recursive foo .', 'grep -d recurse foo .',
                    'egrep -ri foo store/', 'grep -r foo *', 'cp -r store /tmp/copy', 'cp -a . /tmp/copy', 'tar cf - store', 'tar czf /tmp/a.tgz .',
                    'rsync -a . /tmp/y', 'zip -r a.zip .', 'find . -exec cat {} +', 'find store -exec cat {} ;', 'rg --hidden foo .', 'rg -uu foo store',
                    'rg --no-ignore foo %ROOT%', 'ag --unrestricted foo .']:
            cmd = cmd.replace('%ROOT%', self.root)
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_the_same_readers_over_other_directories_pass(self):
        for cmd in ['grep -rn claim src', 'grep -r foo scripts', 'grep -rn claim src scripts', 'rg claim src', 'rg --hidden foo src', 'tar cf x.tar scripts',
                    'cp -r scripts /tmp/y', 'find . -name "*.py"', 'find src -exec cat {} +', 'grep -r --exclude-dir=store foo .',
                    'grep -r --exclude-dir store foo .', 'rsync -a --exclude=store . /tmp/y', 'rg foo .', 'grep -n claim scripts/gmail-send.py',
                    'cp scripts/gmail-send.py /tmp/y']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_other_commands_pass(self):
        for cmd in ['ls store', 'ls -la store', 'ls -la store/', 'cat store/rules.json', 'cat store/*.json', 'cat scripts/gmail-send.py', 'cat scripts/hooks/*.py',
                    'git log --oneline -3', 'python3 scripts/gmail-send.py --help', 'curl -s localhost:3420/api/approvals/claim',
                    'grep -n claim scripts/gmail-send.py', 'cat src/a.ts', 'echo claim', 'echo "the claim route"', 'python3 -c "print(self.claim)"',
                    'npx vitest run src/__tests__/approvals-consume-routes.test.ts --silent', 'wc -c store/rules.json', 'stat store', 'du -sh store']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)


class FileTools(GateCase):
    def p(self, *parts):
        return os.path.join(self.root, *parts)

    def test_read_edit_write_notebook_on_the_key_are_blocked(self):
        for tool, key in [('Read', 'file_path'), ('Edit', 'file_path'), ('Write', 'file_path'), ('MultiEdit', 'file_path'), ('NotebookEdit', 'notebook_path')]:
            for path in [self.p('store', NAME), 'store/' + NAME, './store/' + NAME, self.p('store', '..', 'store', NAME), self.p('work', 'keylink'),
                         self.p('work', 'storelink', NAME), 'work/storelink-abs/' + NAME, self.p('work', 'innocent-name.txt'),
                         self.p('src', '..', 'store', NAME), self.p('store') + '//' + NAME, self.p('work', '..', 'work', 'keylink')]:
                with self.subTest(tool=tool, path=path):
                    self.assert_denied(self.run_gate(tool, {key: path}), '%s %s' % (tool, path))

    def test_a_relative_path_is_taken_from_the_cwd(self):
        self.assert_denied(self.run_gate('Read', {'file_path': '../store/' + NAME}, cwd=self.p('scripts')), 'from scripts/')
        self.assert_denied(self.run_gate('Read', {'file_path': NAME}, cwd=self.p('store')), 'from store/')
        self.assert_denied(self.run_gate('Read', {'file_path': '../work/keylink'}, cwd=self.p('work', 'storelink')), 'through a symlinked cwd')

    def test_grep_over_the_store_or_with_a_glob_that_selects_the_key_is_blocked(self):
        for ti in [{'pattern': 'a', 'path': self.p('store')}, {'pattern': 'a', 'path': 'store'}, {'pattern': 'a', 'path': self.p('store', NAME)},
                   {'pattern': 'a', 'path': self.p('work', 'storelink')}, {'pattern': 'a', 'path': self.p('work', 'storelink-abs')},
                   {'pattern': 'a', 'path': self.p('work', 'keylink')}, {'pattern': 'a', 'path': self.p('store', '..', 'store')},
                   {'pattern': 'a', 'glob': '.claim*'}, {'pattern': 'a', 'glob': NAME}, {'pattern': 'a', 'glob': '.*'}, {'pattern': 'a', 'glob': '*'},
                   {'pattern': 'a', 'glob': '.[c]*'}, {'pattern': 'a', 'glob': '{*.ts,.*}'}, {'pattern': 'a', 'glob': '*key'},
                   {'pattern': 'a', 'glob': 'store/.*'}, {'pattern': 'a', 'glob': '**/.claim*'}, {'pattern': 'a', 'glob': '.claim?signing*'},
                   {'pattern': 'a', 'glob': 'store/**'}, {'pattern': 'a', 'glob': '**'}]:
            with self.subTest(ti=ti):
                self.assert_denied(self.run_gate('Grep', ti), 'Grep %s' % ti)

    def test_glob_that_selects_the_key_is_blocked(self):
        for ti in [{'pattern': 'store/.claim*'}, {'pattern': 'store/.*'}, {'pattern': 'store/*'}, {'pattern': 'store/.[c]*'}, {'pattern': '**/.claim-signing-key'},
                   {'pattern': '**/.*'}, {'pattern': '**/*'}, {'pattern': '**'}, {'pattern': 'store/**'}, {'pattern': 'store/**/.c*'}, {'pattern': '*/.claim*'},
                   {'pattern': '*/.*'}, {'pattern': '{store,src}/.c*'}, {'pattern': 'store/.claim?signing*'}, {'pattern': self.p('store', '.*')},
                   {'pattern': self.p('store', '*')}, {'pattern': '**/*key'}, {'pattern': '*', 'path': self.p('store')}, {'pattern': '.*', 'path': 'store'},
                   {'pattern': '*', 'path': self.p('work', 'storelink')}, {'pattern': '.claim*', 'path': self.p('store')}, {'pattern': '.*', 'path': self.p('scripts')[:-7] + 'store'},
                   {'pattern': '../store/.c*', 'path': self.p('scripts')}, {'pattern': 'store/../store/.*'}]:
            with self.subTest(ti=ti):
                rc = self.run_gate('Glob', ti)
                self.assert_denied(rc, 'Glob %s' % ti)

    def test_other_file_tool_calls_pass(self):
        for tool, ti in [('Read', {'file_path': self.p('store', 'rules.json')}), ('Read', {'file_path': 'scripts/gmail-send.py'}),
                         ('Read', {'file_path': self.p('src', 'a.ts'), 'offset': 1, 'limit': 5}), ('Edit', {'file_path': self.p('src', 'a.ts'), 'old_string': 'a', 'new_string': 'b'}),
                         ('Write', {'file_path': self.p('work', 'notes.txt'), 'content': 'claim'}), ('NotebookEdit', {'notebook_path': self.p('work', 'n.ipynb')}),
                         ('Grep', {'pattern': 'claim', 'path': self.p('src')}), ('Grep', {'pattern': 'claim', 'path': 'scripts', 'glob': '*.py'}),
                         ('Grep', {'pattern': '\\.claim-signing-key', 'path': self.p('src')}),   # a regular expression is content, not a file selector
                         ('Grep', {'pattern': 'claim'}), ('Grep', {'pattern': 'claim', 'glob': '*.ts'}), ('Grep', {'pattern': 'claim', 'glob': 'src/**/*.ts'}),
                         ('Glob', {'pattern': 'src/**/*.ts'}), ('Glob', {'pattern': 'scripts/**/*.py'}), ('Glob', {'pattern': '**/*.ts'}), ('Glob', {'pattern': '*.json', 'path': self.p('scripts')}),
                         ('Glob', {'pattern': 'store/*.json'}), ('Glob', {'pattern': 'store/rules.json'}), ('Glob', {'pattern': 'work/*'}),
                         ('Glob', {'pattern': self.p('src', '*.ts')}), ('WebFetch', {'url': 'https://example.test/'}), ('Task', {'prompt': 'claim'})]:
            with self.subTest(tool=tool, ti=ti):
                self.assert_allowed(self.run_gate(tool, ti), '%s %s' % (tool, ti))


class AnyTool(GateCase):
    """The tool name decides nothing: the MCP file tools and tools that do not exist yet are judged by their strings."""

    def p(self, *parts):
        return os.path.join(self.root, *parts)

    def test_mcp_file_tools_on_the_key_are_blocked(self):
        key, via_link, hard = self.p('store', NAME), self.p('work', 'keylink'), self.p('work', 'innocent-name.txt')
        cases = []
        for path in (key, 'store/' + NAME, via_link, hard, self.p('work', 'storelink', NAME), 'file://' + key, 'file://' + hard, 'file://' + via_link):
            cases += [('mcp__filesystem__read_text_file', {'path': path}), ('mcp__filesystem__read_file', {'path': path, 'head': 3}),
                      ('mcp__filesystem__read_media_file', {'path': path}), ('mcp__filesystem__write_file', {'path': path, 'content': 'x'}),
                      ('mcp__filesystem__edit_file', {'path': path, 'edits': [{'oldText': 'a', 'newText': 'b'}]}),
                      ('mcp__filesystem__get_file_info', {'path': path}),
                      ('mcp__filesystem__move_file', {'source': path, 'destination': self.p('work', 'moved.txt')}),
                      ('mcp__filesystem__move_file', {'source': self.p('work', 'a.txt'), 'destination': path}),
                      ('mcp__filesystem__read_multiple_files', {'paths': [self.p('src', 'a.ts'), path]}),
                      ('mcp__google-drive__uploadFile', {'localPath': path}),
                      ('mcp__plugin_telegram_telegram__reply', {'chat_id': '1', 'text': 'hi', 'files': [path]})]
        for tool, ti in cases:
            with self.subTest(tool=tool, ti=ti):
                self.assert_denied(self.run_gate(tool, ti), tool)

    def test_a_tool_that_does_not_exist_yet_is_judged_by_its_strings(self):
        key = self.p('store', NAME)
        for ti in ({'path': key}, {'file': key}, {'target_file': key}, {'paths': [key]}, {'items': [{'location': key}]}, {'a': {'b': {'c': [key]}}},
                   {'x': 'store/' + NAME}, {'whatever': key}, {'filename': 'store/.claim*'}, {'dir': 'store', 'files': ['.claim-signing-key']},
                   {key: 'content'}, {'uri': 'file://' + key}, {'sources': ['a', {'path': key}]}):
            with self.subTest(ti=ti):
                self.assert_denied(self.run_gate('mcp__x__y', ti), str(ti))

    def test_the_cwd_is_used_for_relative_paths_of_any_tool(self):
        self.assert_denied(self.run_gate('mcp__x__y', {'path': NAME}, cwd=self.p('store')), 'from store/')
        self.assert_denied(self.run_gate('mcp__x__y', {'p': '../store/' + NAME}, cwd=self.p('work')), 'odd field name, short string')

    def test_calls_that_are_not_about_the_key_pass(self):
        for tool, ti in [('mcp__filesystem__read_text_file', {'path': self.p('store', 'rules.json')}),
                         ('mcp__filesystem__write_file', {'path': self.p('work', 'notes.txt'), 'content': 'the key is ' + NAME + ' and stays in store/'}),
                         ('mcp__filesystem__edit_file', {'path': self.p('src', 'a.ts'), 'edits': [{'oldText': NAME, 'newText': 'x'}]}),
                         ('mcp__filesystem__move_file', {'source': self.p('work', 'a.txt'), 'destination': self.p('work', 'b.txt')}),
                         ('mcp__filesystem__read_multiple_files', {'paths': [self.p('src', 'a.ts'), self.p('scripts', 'gmail-send.py')]}),
                         ('mcp__filesystem__list_directory', {'path': self.p('src')}), ('mcp__x__y', {'query': 'claim', 'limit': 5, 'flag': True, 'n': None}),
                         ('mcp__plugin_telegram_telegram__reply', {'chat_id': '1', 'text': 'see ' + NAME + '\nline two'}),
                         ('mcp__x__y', {'text': ('a long text about ' + NAME + ' ') * 200}), ('mcp__x__y', {})]:
            with self.subTest(tool=tool, ti=ti):
                self.assert_allowed(self.run_gate(tool, ti), tool)

    def test_a_pathological_argument_is_a_block_not_a_hang(self):
        deep = cur = {}
        for _ in range(40):
            cur['n'] = {}
            cur = cur['n']
        self.assert_denied(self.run_gate('mcp__x__y', deep), 'too deep')
        self.assert_denied(self.run_gate('mcp__x__y', {'items': ['a'] * 6000}), 'too many strings')


class FailClosed(GateCase):
    def test_bad_input_is_a_block(self):
        for raw in ['', 'not json', '[]', '"x"', '{}', '{"tool_name": "Bash"}', '{"tool_name": "Bash", "tool_input": []}', '{"tool_name": 5, "tool_input": {}}',
                    '{"tool_name": "Bash", "tool_input": {"command": 5}}', '{"tool_name": "Bash", "tool_input": {"command": null}}',
                    '{"tool_name": "Read", "tool_input": {"file_path": 5}}', '{"tool_name": "Grep", "tool_input": {"pattern": "a", "glob": 5}}',
                    '{"tool_name": "Read", "tool_input": {"file_path": ["a"]}}', '\x00\xff']:
            with self.subTest(raw=raw[:40]):
                self.assert_denied(self.run_gate(None, None, raw=raw), raw[:40])

    def test_a_part_that_does_not_load_is_a_block_with_exit_2_not_1(self):
        broken = os.path.realpath(tempfile.mkdtemp(prefix='secret-gate-broken-'))
        try:
            os.makedirs(os.path.join(broken, 'scripts/hooks'))
            os.makedirs(os.path.join(broken, 'store'))
            shutil.copy(GATE_SRC, os.path.join(broken, 'scripts/hooks/secret-read-gate.py'))
            with open(os.path.join(broken, 'scripts/hooks/shlex.py'), 'w') as fh:     # the script's own directory comes first on sys.path
                fh.write('raise RuntimeError("broken")\n')
            payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': 'ls'}})
            p = subprocess.run([sys.executable, os.path.join(broken, 'scripts/hooks/secret-read-gate.py')], input=payload.encode(), capture_output=True, timeout=30)
            self.assertEqual(p.returncode, 2, p.stderr)
            self.assertIn(b'BLOCKED', p.stderr)
        finally:
            shutil.rmtree(broken, ignore_errors=True)

    def test_an_internal_error_is_a_block(self):
        # a payload that makes the checker itself fail: a cwd that is not a usable path
        rc, out, err = self.run_gate('Bash', {'command': 'cat x'}, cwd='\x00bad')
        self.assertEqual(rc, 2, err)
        self.assertIn('BLOCKED', err)

    def test_no_environment_variable_relaxes_it(self):
        for name in ['SECRET_READ_GATE_OFF', 'SECRET_READ_GATE_SHADOW', 'SECRET_READ_GATE_DISABLE', 'GATE_DISABLE', 'DISABLE_HOOKS', 'CLAUDE_SECRET_GATE', 'SHADOW_MODE', 'MARVEEN_STORE_DIR']:
            with self.subTest(name=name):
                self.assert_denied(self.run_gate('Bash', {'command': 'cat store/' + NAME}, extra_env={name: '1'}), name)
                self.assert_denied(self.run_gate('Read', {'file_path': self.root + '/store/' + NAME}, extra_env={name: '/tmp'}), name)

    def test_the_refusal_never_prints_the_key(self):
        rc, out, err = self.bash('cat store/' + NAME)
        self.assertNotIn(KEY, out + err)

    def test_the_gate_is_stateless_about_the_key_file_it_guards(self):
        # the block does not depend on the key file existing: a key not yet created is still guarded
        other = os.path.realpath(tempfile.mkdtemp(prefix='secret-gate-nokey-'))
        try:
            os.makedirs(os.path.join(other, 'scripts/hooks'))
            os.makedirs(os.path.join(other, 'store'))
            shutil.copy(GATE_SRC, os.path.join(other, 'scripts/hooks/secret-read-gate.py'))
            for ti in [('Read', {'file_path': os.path.join(other, 'store', NAME)}), ('Bash', {'command': 'cat store/' + NAME})]:
                p = subprocess.run([sys.executable, os.path.join(other, 'scripts/hooks/secret-read-gate.py')],
                                   input=json.dumps({'tool_name': ti[0], 'tool_input': ti[1], 'cwd': other}).encode(), capture_output=True, timeout=30)
                self.assertEqual(p.returncode, 2, p.stderr)
        finally:
            shutil.rmtree(other, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=1)
