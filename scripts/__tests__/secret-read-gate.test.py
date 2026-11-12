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
        os.symlink('../store/' + NAME, os.path.join(cls.root, 'work', 'relkey'))      # a relative symlink to the key

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

    def test_a_link_to_the_key_next_to_a_glob_alternative_in_a_brace_word_is_blocked(self):
        # a brace alternative without a glob is judged as a plain path: a symlink or a hard link to the key is the key
        for link in ('keylink', 'innocent-name.txt'):
            for alts in ('%s,x*', 'x*,%s', '%s,y?', '[a]*,%s'):
                cmd = 'cat work/{%s}' % (alts % link)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)
        for cmd in ['cat src/{a.ts,b*}', 'cat src/{b*,a.ts}', 'cat work/{x,y*}', 'echo \'{"a": 1, "b": "*"}\'']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_a_brace_word_without_a_glob_is_judged_alternative_by_alternative(self):
        # the shell turns a brace word into several paths; each one is checked as a path: the name, a symlink (absolute, relative),
        # a hard link, in either order, nested, behind a redirection, from a directory above or beside it
        links = ['keylink', 'relkey', 'innocent-name.txt']
        cmds = ['cat store/{%s,x}' % NAME, 'cat store/{x,%s}' % NAME, 'cat {store/%s,x}' % NAME, 'cat store/.claim-signing-ke{y..y}', 'cat store/{x,{y,%s}}' % NAME,
                'cat store/{{x,y},%s}' % NAME, 'cat {store,x}/%s' % NAME, 'cat {store,work}/{x,%s}' % NAME]
        for link in links:
            cmds += ['cat work/{%s,x}' % link, 'cat work/{x,%s}' % link, 'cat {work/%s,x}' % link, 'cat {x,work/%s}' % link, 'cat work/{x,y,%s}' % link,
                     'cat work/{x,{y,%s}}' % link, 'cat work/{{x,y},%s}' % link, 'cat {work,src}/{x,%s}' % link, 'cat < work/{%s,x}' % link,
                     'head -c 5 work/{%s,x}' % link, 'cat work/{%s,%s}' % (link, link)]
        for cmd in cmds:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        # from a directory beside the key
        self.assert_denied(self.bash('cat {%s,x}' % NAME, cwd=os.path.join(self.root, 'store')), 'cat {key,x} from store/')
        self.assert_denied(self.bash('cat {../store/%s,x}' % NAME, cwd=os.path.join(self.root, 'src')), 'cat {../store/key,x} from src/')

    def test_a_brace_word_without_a_glob_that_names_no_protected_file_passes(self):
        for cmd in ['echo src/{a,b}.ts', 'cat src/{a.ts,x}', 'cat src/{x,a.ts}', 'cat store/{x,rules.json}', 'cat {src/a.ts,x}', 'echo \'{"a": 1, "b": 2}\'',
                    'echo {1..3}', 'echo {a..e}', 'echo {01..03}', 'echo {a,b}{c,d}', 'cat work/{x,y}', 'echo ${HOME}', 'echo ${A,B}', 'echo {x}', 'echo {}',
                    'curl -s -X POST localhost:3420/api/messages -d \'{"from":"agent-a","to":"agent-b","content":"hi"}\'',
                    'grep -r foo {src,scripts}', 'find {src,scripts} -exec cat {} +', 'cp -r {src,scripts} /tmp/y']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_brace_expansion_also_reaches_the_recursive_readers_and_the_find_roots(self):
        for cmd in ['grep -r foo {store,src}', 'grep -r foo {src,store}', 'grep -r foo {x,{src,store}}', 'cp -r {store,src} /tmp/y', 'tar cf - {src,store}',
                    'find {store,src} -exec cat {} +', 'find {src,store} -type f | xargs cat', 'rg --hidden foo {src,store}', 'grep --rec foo {store,x}',
                    # a brace PATTERN is one operand: it must not make the cwd (which holds the store) go unlooked
                    'grep -r {a,b}']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def oracle_expansion(self, words):
        """What the real shells make of `words` (bash and, where there is one, zsh): the lines `printf '%s\\n' WORDS` prints in the
        install root. The gate must refuse exactly the commands whose expansion holds a protected path."""
        out = {}
        for shell in ('bash', 'zsh'):
            exe = shutil.which(shell)
            if exe:
                r = subprocess.run([exe, '-c', "printf '%s\\n' " + words], cwd=self.root, capture_output=True, timeout=30)
                out[shell] = r.stdout.decode().split('\n')
        return out

    def test_brace_expansion_is_quote_aware_and_judged_against_the_real_shells(self):
        # (word as typed, expected: does the shell expand it to the link `work/keylink`?)
        cells = [('work/{keylink,q}', True), ('work/{q,keylink}', True), ('{work/keylink,q}', True), ('"work"/{keylink,q}', True), ('"work/"{keylink,q}', True),
                 ("work/{'keylink',q}", True), ('work/{"key"link,q}', True), ("wor'k'/{keylink,q}", True), ('work/{keylink,q}{,}', True),
                 # quoted or escaped braces are literal to the shell
                 ("'work/{keylink,q}'", False), ('"work/{keylink,q}"', False), ("work/'{keylink,q}'", False), ('work/\\{keylink,q\\}', False),
                 ('work/\\{keylink,q}', False), ('work/"{"keylink,q}', False), ('work/{keylink,q"}"', False),
                 ('$HOME/{x,y}', False), ('work/${x}', False), ('work/{x}', False), ('work/{keylink}', False)]
        for word, expands in cells:
            cmd = 'cat ' + word
            seen = self.oracle_expansion(word)
            for shell, lines in seen.items():
                with self.subTest(word=word, shell=shell):
                    self.assertEqual('work/keylink' in lines, expands, 'the oracle: %s expands %r to %r' % (shell, word, lines[:4]))
            with self.subTest(cmd=cmd):
                (self.assert_denied if expands else self.assert_allowed)(self.bash(cmd), cmd)

    def test_brace_expansion_caps_count_the_unquoted_expansion_only(self):
        eleven = '{a,b}' * 11                           # 2048 alternatives, over the cap
        # a) unquoted: refused
        for cmd in ['echo ' + eleven, 'cat src/%s' % eleven, 'cat src/{1..2000}', 'cat src/{a..z}{a..z}{a..z}', 'cat %s%s' % ('a' * 2100, '{x,y}')]:
            with self.subTest(cmd=cmd[:60]):
                self.assert_denied(self.bash(cmd), cmd[:60])
        # b) the same text in single quotes (the shell prints it as it is): allowed
        self.assert_allowed(self.bash("echo '" + eleven + "'"), 'quoted eleven groups')
        # c) the playing pattern: eleven groups, a group with a QUOTED space, and the real group. No text exception: refused
        for cmd in ['cat work/' + eleven + '{"x y",z}{keylink,q}', 'cat work/' + eleven + "{'x y',z}{keylink,q}"]:
            with self.subTest(cmd=cmd[:60]):
                self.assert_denied(self.bash(cmd), cmd[:60])
        # d) a large JSON body in single quotes: allowed, and so is the same in double quotes
        body = '{"items":[' + '{"a":1,"b":2},' * 3000 + '{}]}'
        self.assertGreater(len(body), 40000)
        self.assert_allowed(self.bash("curl -s -X POST localhost:3420/api/messages -d '" + body + "'"), 'large JSON in single quotes')
        self.assert_allowed(self.bash('curl -s -X POST localhost:3420/api/messages -d "' + body.replace('"', '\\"') + '"'), 'large JSON in double quotes')
        # e) a quoted path part in front of the real group still expands it
        for cmd in ['cat "work"/{keylink,q}', 'cat "wo"rk/{keylink,q}', "cat 'work'/{keylink,q}"]:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        # f) escaped braces around the name: literal
        self.assert_allowed(self.bash('cat work/\\{keylink,q\\}'), 'escaped braces')
        # at the cap it is still looked through: 1000 alternatives, none of them protected
        self.assert_allowed(self.bash('cat src/{1..1000}'), 'cat src/{1..1000}')

    def test_a_brace_group_in_a_word_whose_quoting_cannot_be_read_is_refused(self):
        # the line does not parse (an apostrophe): its words carry no quote state, and a brace group in one is not guessed at
        for cmd in ["echo it's {a,b}", "echo it's work/{keylink,q}"]:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        # no group in the unreadable word: nothing to guess
        self.assert_allowed(self.bash("echo it's fine"), "echo it's fine")

    def test_the_brace_search_is_linear_and_the_caps_come_before_it(self):
        import resource
        import time
        bodies = [('echo "' + '{' * 20000, 'opening braces, unterminated quote'), ('echo ' + '{' * 20000, 'opening braces'), ('echo ' + '}' * 50000, 'closing braces'),
                  ('echo ' + '{a,' * 20000, 'nested open groups'), ('echo ' + '{a,' * 20000 + '}' * 20000, 'nested groups'),
                  ('echo ' + '{' * 2000 + ',a', 'braces under the word cap, no group'), ("echo '" + '{' * 20000 + "'", 'quoted braces'),
                  ('echo "$(' * 5000, 'open substitutions')]
        for cmd, label in bodies:
            before, t0 = resource.getrusage(resource.RUSAGE_CHILDREN), time.time()
            rc, out, err = self.bash(cmd)
            used = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu = (used.ru_utime + used.ru_stime) - (before.ru_utime + before.ru_stime)
            with self.subTest(label=label):
                self.assertIn(rc, (0, 2), label)      # a verdict, whichever it is
                self.assertLess(cpu, 2.0, '%s: %.2fs of CPU' % (label, cpu))
                self.assertLess(time.time() - t0, 4.0, label)
        # past the word cap an unquoted brace is refused without a search, a quoted one is not looked at
        self.assert_denied(self.bash('echo ' + '{' * 3000 + ',a}'), 'long word with unquoted braces')
        self.assert_allowed(self.bash("echo '" + '{' * 3000 + ",a}'"), 'long word with quoted braces')

    def test_many_words_just_under_the_word_cap_are_searched_in_linear_time(self):
        # the cells the single long word cannot be: the search for a group in the quadratic form took 0.1 s per word of 2000
        # opening braces, 5.8 s for 50 of them (and the caps cannot answer them first: each word is under the word cap and
        # the characters of the command are under the work cap). No brace closes, so nothing expands: the verdict is allow.
        import resource
        import time
        cells = [('echo ' + ' '.join(['{' * 2000 + ',a'] * 50), '50 words of 2000 opening braces'),
                 ('echo ' + ' '.join(['{' * 400 + ',a'] * 400), '400 words of 400 opening braces'),
                 ('echo ' + ' '.join(['{' * 1000 + ',a' + '}' * 1000] * 20), '20 words of 1000 nested groups')]
        for cmd, label in cells:
            before, t0 = resource.getrusage(resource.RUSAGE_CHILDREN), time.time()
            rc, out, err = self.bash(cmd)
            used = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu = (used.ru_utime + used.ru_stime) - (before.ru_utime + before.ru_stime)
            with self.subTest(label=label):
                self.assertLess(cpu, 2.0, '%s: %.2fs of CPU (the quadratic search needs about 5 s for the first cell)' % (label, cpu))
                self.assertLess(time.time() - t0, 4.0, label)
                self.assertIn(rc, (0, 2), label)
        # the verdicts: no brace closes in the first two, nothing expands, nothing is read
        self.assert_allowed(self.bash(cells[0][0]), cells[0][1])
        self.assert_allowed(self.bash(cells[1][0]), cells[1][1])

    def test_command_bodies_are_judged_in_linear_time(self):
        # nested, sibling and unterminated bodies: every one is refused (the depth cap, the work budget, the scanner), fast
        import resource
        import time
        cells = [('echo ' + '$(' * 20000 + 'a' + ')' * 20000, '20000 nested substitutions'), ('echo ' + '$(a) ' * 20000, '20000 sibling substitutions'),
                 ('echo ' + '$(' * 50000, '50000 unterminated substitutions'), ('(' * 20000 + 'a' + ')' * 20000, '20000 nested subshells'),
                 ('echo ' + '`a` ' * 20000, '20000 backtick pairs'), ('echo ' + '`' * 20000, '20000 backticks'), ('echo ' + '"$(' * 5000, '5000 open double-quoted substitutions')]
        # CPU and wall ceilings per cell, 2.0 s and 4.0 s unless listed. The two 20000-word cells cost 2.1-2.7 s (siblings) and 3.8-3.9 s
        # (backtick pairs) of CPU on a quiet machine and scale linearly (5000 -> 10000 -> 20000: 1.0 -> 1.3 -> 2.3 s and 1.2 -> 2.1 -> 3.9 s,
        # measured on this gate and on the one before it, the same): the old ceilings sat at their cost and passed or failed with the speed
        # of the runner. A quadratic shape costs tens of seconds on them, so 6.0 s of CPU and 8.0 s of wall still tell the two apart.
        cpu_limits = {'20000 sibling substitutions': 6.0, '20000 backtick pairs': 6.0}
        wall_limits = {'20000 sibling substitutions': 8.0, '20000 backtick pairs': 8.0}
        for cmd, label in cells:
            before, t0 = resource.getrusage(resource.RUSAGE_CHILDREN), time.time()
            rc, out, err = self.bash(cmd)
            used = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu = (used.ru_utime + used.ru_stime) - (before.ru_utime + before.ru_stime)
            with self.subTest(label=label):
                self.assertEqual(rc, 2, label)      # refused, not crashed into silence
                self.assertLess(cpu, cpu_limits.get(label, 2.0), '%s: %.2fs of CPU' % (label, cpu))
                self.assertLess(time.time() - t0, wall_limits.get(label, 4.0), label)
        # and a command with a few bodies is neither refused nor slow
        self.assert_allowed(self.bash('echo ' + '$(date) ' * 100), '100 sibling substitutions')

    def test_comments_here_documents_and_old_arithmetic_are_scanned_in_linear_time(self):
        # the scanner skips comments, here-document bodies and `$[ ]` spans: none of them may cost more than one pass
        import resource
        import time
        # (sizes: what the rest of the gate takes per word is the larger part of the cost; an unclosed `$[` run is quadratic
        # in the word code that was there before and is kept small)
        cells = [('echo ' + '$[' * 3000, '3000 unclosed old arithmetic brackets'), ('echo ' + '$[1] ' * 5000, '5000 old arithmetic spans'),
                 (': ' + '# it\'s\n' * 10000, '10000 comment lines'), ('echo $(' + '# it\'s\n' * 5000 + ')', '5000 comment lines in a substitution'),
                 ('cat ' + '<<E ' * 5000 + '\n' + 'E\n' * 5000, '5000 here-documents on one line'),
                 ('cat ' + '<<E ' * 5000 + '\nnever ends\n' * 5000, '5000 here-documents that never end'),
                 ('cat <<EOF\n' + 'a $(date) it\'s\n' * 5000 + 'EOF', '5000 substitutions in a here-document'),
                 ('cat <<\'EOF\'\n' + 'a $(date) it\'s\n' * 5000 + 'EOF', '5000 lines in a quoted here-document'),
                 ('echo ' + '<<' * 20000, '20000 shift operators'), ('echo ${ ' * 5000, '5000 funsubs'),
                 # the text another shell is handed (commit 2)
                 ('eval ' + 'a' * 100000, '100000 character eval argument'), ('eval "' + 'a b ' * 5000 + '"', '10000 words in an eval string'),
                 ('bash ' * 20000, '20000 shell words'),
                 ('bash -c ' * 5000, '5000 unfinished bash -c'), ('eval ' * 20000, '20000 eval words'),
                 ('bash -c "' * 3000, '3000 unterminated bash -c strings'), (': ' + '((' * 5000, '5000 arithmetic openers'),
                 ('echo ' + '(( 1 << 2 )) ' * 3000, '3000 arithmetic commands')]
        nest = 'ls docs'
        for _ in range(14):
            nest = 'bash -c "%s"' % nest.replace('\\', '\\\\').replace('"', '\\"')
        cells.append((nest, '14 nested bash -c with escaped quotes'))
        for cmd, label in cells:
            before, t0 = resource.getrusage(resource.RUSAGE_CHILDREN), time.time()
            rc, out, err = self.bash(cmd)
            used = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu = (used.ru_utime + used.ru_stime) - (before.ru_utime + before.ru_stime)
            with self.subTest(label=label):
                self.assertIn(rc, (0, 2), label)      # a verdict, not a crash
                self.assertLess(cpu, 2.0, '%s: %.2fs of CPU' % (label, cpu))
                self.assertLess(time.time() - t0, 4.0, label)

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
                    'rg --no-ignore foo %ROOT%', 'ag --unrestricted foo .',
                    # rsync takes values through --filter / -e / --files-from, so its --exclude is no longer trusted as a filter
                    'rsync -a --exclude=store . /tmp/y']:
            cmd = cmd.replace('%ROOT%', self.root)
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    # find start directories and whether a reader that gets the file list reaches the store: (find words, denied)
    FIND_ROOTS = [('find .', True), ('find store', True), ('find store/', True), ('find', True), ('find -type f', True), ('find -name x', True),
                  ('find -L .', True), ('find -H store', True), ('find . store', True), ('find *', True), ('find . -name "*.py"', True),
                  ('find src', False), ('find scripts', False), ('find src scripts', False), ('find . -prune', False),
                  ('find . -path ./store -prune -o -type f -print', False), ('find /nonexistent', False)]

    def test_find_exec_and_find_pipe_into_xargs_are_judged_by_the_same_decision(self):
        # 1:1 cells: every find prefix gets the verdict of its -exec form AND its xargs form, and both equal the expectation
        for find, denied in self.FIND_ROOTS:
            for tail in (' -exec cat {} +', ' -exec cat {} ;', ' -execdir head {} ;', ' | xargs cat', ' | xargs -0 cat', ' | parallel cat {}'):
                cmd = find + tail
                with self.subTest(cmd=cmd):
                    (self.assert_denied if denied else self.assert_allowed)(self.bash(cmd), cmd)

    def test_find_piped_into_a_reader_launcher_is_blocked(self):
        for tail in ['xargs cat', 'xargs -0 cat', 'xargs -n1 head', 'xargs -n 1 head', 'xargs -I{} cat {}', 'xargs -I {} cat {}', 'xargs -P4 -0 tail', 'xargs -0r cat', 'xargs --null cat',
                     'xargs --max-args=1 cat', 'xargs --max-args 1 cat', 'xargs -- cat', 'xargs /bin/cat', 'xargs env cat', 'xargs grep foo', 'xargs sed -n p', 'xargs awk 1',
                     'xargs strings', 'xargs base64', 'xargs xxd', 'xargs cp -t /tmp', 'xargs tar cf /tmp/a.tar', 'xargs gzip -c', 'xargs diff x', 'xargs rg foo', 'xargs less',
                     'xargs sh -c "cat \\"$0\\""', 'xargs bash -c cat', 'xargs python3 -c 1', 'xargs node -e 1', 'xargs perl -ne print', 'xargs ruby -e 1',
                     'parallel cat', 'parallel -j4 cat {}', 'parallel --jobs 2 grep foo', 'parallel -k head']:
            for find in ('find store -type f', 'find . -type f', 'find -type f'):
                cmd = '%s | %s' % (find, tail)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)

    def test_find_pipe_through_other_segments_and_the_pipe_ampersand_is_blocked(self):
        for cmd in ['find store -type f | sort | xargs cat', 'find store -type f | head -3 | xargs cat', 'find store -type f |& xargs cat', 'find store -type f -print0 | xargs -0 cat',
                    'sudo find store -type f | xargs cat', 'find store -type f | sudo xargs cat', 'find store -type f | nohup xargs cat']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_find_pipe_an_undecidable_launcher_is_blocked_fail_closed(self):
        for tail in ['xargs $READER', 'xargs "$(echo cat)"', 'xargs `echo cat`', 'xargs -Z cat', 'xargs --bogus cat', 'xargs --max-arg=1 cat', 'xargs nice -n5 cat',
                     'xargs sudo -u x cat', 'xargs c*t', 'xargs ./c[a]t', 'parallel --bogus cat', 'parallel -Z cat']:
            cmd = 'find store -type f | ' + tail
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_find_pipe_into_a_command_that_is_no_reader_passes(self):
        for tail in ['xargs wc -l', 'xargs ls', 'xargs ls -la', 'xargs stat', 'xargs file', 'xargs du -h', 'xargs basename', 'xargs dirname', 'xargs echo', 'xargs printf "%s\\n"',
                     'xargs test -e', 'xargs', 'xargs -0', 'xargs -n1', 'xargs -I{} echo {}', 'parallel wc -l', 'parallel', 'wc -l', 'sort', 'head -3', 'cat']:
            cmd = 'find store -type f | ' + tail
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_find_pipe_that_does_not_start_the_pipeline_or_is_not_a_pipe_passes(self):
        # accepted limits: only a find that STARTS the pipeline is followed (a separator ends the pipeline)
        for cmd in ['find store ; xargs cat', 'find store && xargs cat', 'find store || xargs cat', 'echo store | xargs cat', 'ls store | xargs cat',
                    'find src -type f | xargs cat', 'find scripts | sort | xargs grep foo']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_find_pipe_into_xargs_cat_really_reads_the_key_and_the_gate_blocks_it(self):
        # the real tools (BSD or GNU find and xargs): the command prints the key, and the gate refuses that very command
        cmd = 'find store -type f -name ".c*" | xargs cat'
        shown = subprocess.run(['/bin/sh', '-c', cmd], cwd=self.root, capture_output=True, timeout=30)
        self.assertIn(KEY.encode(), shown.stdout, 'the positive control: the pipe reads the key')
        self.assert_denied(self.bash(cmd), cmd)
        # the real tool, the same pipe over a directory without the store, prints and the gate lets it
        ok = 'find src -type f | xargs cat'
        shown = subprocess.run(['/bin/sh', '-c', ok], cwd=self.root, capture_output=True, timeout=30)
        self.assertIn(b'export const claim', shown.stdout)
        self.assert_allowed(self.bash(ok), ok)

    DIRECTORIES_RECURSE = ['--directories=recurse', '--directories recurse', '--dir=recurse', '-d recurse', '-drecurse']

    def test_grep_directories_recurse_in_every_spelling_over_the_store_is_blocked(self):
        # the long option and its abbreviations, the short one attached or apart, with a directory that holds the store
        for opt in self.DIRECTORIES_RECURSE:
            for target in ('store', 'store/', '.', '%ROOT%'):
                cmd = 'grep %s foo %s' % (opt, target)
                cmd = cmd.replace('%ROOT%', self.root)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)

    def test_grep_directories_other_abbreviations_clusters_and_unknown_values_are_blocked(self):
        for cmd in ['grep --d=recurse foo store', 'grep --di=recurse foo store', 'grep --direc recurse foo store', 'grep --directori=recurse foo .',
                    'grep -nd recurse foo store', 'grep -ndrecurse foo store', 'grep -in --directories=recurse foo .', 'egrep --dir=recurse foo store',
                    # an unknown or missing ACTION is not read / skip: fail closed
                    'grep --directories=recurs foo store', 'grep --directories=RECURSE foo store', 'grep -d bogus foo store', 'grep --directories= foo store',
                    # the ACTION word is the option value, so the directory without an operand is the cwd
                    'grep -d recurse foo', 'grep --directories recurse foo', 'grep --dir=recurse foo']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_grep_directories_read_and_skip_do_not_recurse(self):
        for cmd in ['grep -d read foo store', 'grep -d skip foo store', 'grep -dskip foo store', 'grep --directories=skip foo store',
                    'grep --directories read foo store', 'grep --dir=skip foo .', 'grep -nd skip foo .', 'grep -d skip foo',
                    # `d` after a value-taking letter is that letter's value (the pattern `d`), not the option
                    'grep -ed store', 'grep -ed foo store/rules.json']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    RECURSIVE_LONG_PREFIXES = ['--recursive', '--recursiv', '--recurs', '--recur', '--recu', '--rec', '--dereference-recursive', '--dereference-recursiv',
                               '--dereference-r', '--dereference', '--dereferenc', '--derefer', '--dere', '--der']

    def test_grep_abbreviated_long_recursive_options_over_the_store_are_blocked(self):
        # the real grep reads a unique prefix of a long option as the option; every one of them is a recursive read
        for opt in self.RECURSIVE_LONG_PREFIXES:
            for target in ('store', 'store/', '.', '%ROOT%'):
                cmd = ('grep %s foo %s' % (opt, target)).replace('%ROOT%', self.root)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)
        for cmd in ['grep --rec foo', 'grep --dere foo', 'egrep --rec foo store', 'grep -n --rec foo .', 'grep --rec=x foo store',
                    # a prefix two options share: grep itself stops with an error, the gate does not guess (fail closed)
                    'grep --r foo store', 'grep --re foo store', 'grep --d foo store', 'grep --de foo store']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_grep_long_option_resolution_cells_over_the_store_are_blocked(self):
        # the cells of the one resolver (GNU + BSD names, exact or prefix): the --recursive and the --directories branch together.
        # On the real BSD grep (macOS) --rec, --recur and --recurs READ the tree (the token and the key included); --re, --r, --d
        # are ambiguous there (grep stops), --dere / --dereference-rec are unrecognised there but work on GNU grep. The rule does not
        # depend on the host: any candidate that is recursive, or --directories with an ACTION other than read/skip, is refused.
        for opt in ['--rec', '--recur', '--recurs', '--recursive', '--dereference-recursive', '--dereference-rec', '--dere', '--directories=recurse', '--dir=recurse', '--d=recurse']:
            for target in ('store', 'store/', '.'):
                cmd = 'grep %s foo %s' % (opt, target)
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)

    def test_grep_unknown_long_option_over_a_directory_with_the_store_is_blocked(self):
        # a name that is no option and no prefix of one (`--recursively` is LONGER than --recursive): the reach is not decided
        for cmd in ['grep --bogus foo store', 'grep --recursively foo .', 'grep --recursivee foo store/', 'egrep --nonesuch=1 foo store']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)
        for cmd in ['grep --bogus foo src', 'grep --recursively foo src scripts', 'grep --bogus claim scripts/gmail-send.py', 'grep --bogus claim store/rules.json']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_whatever_the_host_grep_reads_the_gate_refuses(self):
        # the real grep of this host: when a spelling prints the key, the gate must refuse that very command
        for opt in ['--rec', '--recur', '--recurs', '--recursive', '--dereference-recursive', '--dereference-rec', '--dere', '--directories=recurse', '--dir=recurse', '--directories recurse']:
            cmd = 'grep %s -h a1a1 store' % opt
            shown = subprocess.run(['/bin/sh', '-c', cmd], cwd=self.root, capture_output=True, timeout=30)
            if KEY.encode() in shown.stdout:
                with self.subTest(cmd=cmd):
                    self.assert_denied(self.bash(cmd), cmd)
        # the control that this host reads at least with the full long name
        full = subprocess.run(['/bin/sh', '-c', 'grep --recursive -h a1a1 store'], cwd=self.root, capture_output=True, timeout=30)
        self.assertIn(KEY.encode(), full.stdout)

    def test_grep_abbreviated_long_recursive_with_a_store_exclude_is_not_trusted(self):
        for cmd in ['grep --rec --exclude-dir=store foo .', 'grep --dere --exclude-dir store foo .']:
            with self.subTest(cmd=cmd):
                self.assert_denied(self.bash(cmd), cmd)

    def test_grep_abbreviated_long_recursive_over_other_directories_and_other_long_options_pass(self):
        for cmd in ['grep --rec foo src', 'grep --recur foo src scripts', 'grep --dere foo src', 'grep --dereference-recursive foo src',
                    'grep --regexp=claim scripts/gmail-send.py', 'grep --reg=claim scripts/gmail-send.py', 'grep --regexp claim src/a.ts',
                    'grep --no-messages claim scripts/gmail-send.py', 'grep --line-number claim src/a.ts', 'grep --devices=skip claim src/a.ts',
                    # after `--` every word is an operand
                    'grep -n claim -- src/a.ts']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_grep_directories_recurse_over_other_directories_passes(self):
        for cmd in ['grep --directories=recurse foo src', 'grep --dir=recurse foo scripts', 'grep -d recurse foo src scripts',
                    'grep -d recurse --exclude-dir=store foo src']:
            with self.subTest(cmd=cmd):
                self.assert_allowed(self.bash(cmd), cmd)

    def test_the_same_readers_over_other_directories_pass(self):
        for cmd in ['grep -rn claim src', 'grep -r foo scripts', 'grep -rn claim src scripts', 'rg claim src', 'rg --hidden foo src', 'tar cf x.tar scripts',
                    'cp -r scripts /tmp/y', 'find . -name "*.py"', 'find src -exec cat {} +', 'grep -r --exclude-dir=store foo .',
                    'grep -r --exclude-dir store foo .', 'rg foo .', 'grep -n claim scripts/gmail-send.py',
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
        for path in (key, 'store/' + NAME, via_link, hard, self.p('work', 'storelink', NAME), 'file://' + key, 'file://' + hard, 'file://' + via_link, 'FILE://' + hard,
                     'file://localhost' + hard, 'File://' + via_link):
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

    def test_a_glob_with_more_than_500_matches_still_finds_the_key(self):
        big = self.p('work', 'big')
        os.makedirs(big)
        for i in range(600):
            self.write('work/big/f%03d' % i, 'x')
        try:
            self.assert_allowed(self.run_gate('mcp__x__y', {'q': big + '/*'}), 'no key among 600 files')
            os.link(self.p('store', NAME), os.path.join(big, 'zzz'))
            self.assert_denied(self.run_gate('mcp__x__y', {'q': big + '/*'}), 'lenient field')
            self.assert_denied(self.bash('cat ' + big + '/*'), 'bash')
        finally:
            shutil.rmtree(big, ignore_errors=True)

    def test_a_long_path_in_an_odd_field_is_still_judged(self):
        long_path = self.p('work', 'storelink') + '/' + NAME      # resolves to the key, but the text is plain
        self.assert_denied(self.run_gate('mcp__x__y', {'q': '/' * 2000 + long_path}), 'padded with slashes')

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
