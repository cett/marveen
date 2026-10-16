#!/usr/bin/env python3
"""Tests for scripts/open-fork-pr.py (opens a pull request on the fork through the GitHub REST API).

The script runs as a subprocess against a stub GitHub on a loopback port (OPEN_FORK_PR_API_BASE) and with a fake
`git` first on PATH that answers `git credential fill`. Both write into one event list, so what was asked, in which
order, and what never happened (a request, a credential lookup) can be asserted. Fixture data only.

  1. The happy path: the request GitHub receives, the one line on stdout.
  2. Every GitHub refusal: non-zero exit, GitHub's own message, no token anywhere in the output.
  3. The credential: what is asked of `git credential fill`, and the failures that send no request.
  4. Usage errors exit 2 and send nothing; the API base override is loopback only.
  5. A redirect is not followed.

Run: python3 <thisfile>   (OPEN_FORK_PR_PATH names a script other than scripts/open-fork-pr.py: mutation runs)
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
SCRIPT = os.environ.get('OPEN_FORK_PR_PATH') or os.path.join(SCRIPTS, 'open-fork-pr.py')

TOKEN = 'tok-fixture-0123456789abcdef'
PR_URL = 'https://github.com/cett/marveen/pull/684'
BODY = 'Fixes the scrub.\n\n- `code` and "quotes" and an accent: árvíztűrő tükörfúrógép\n'

FAKE_GIT = """#!/bin/sh
# fake git: only `git credential fill` is answered; every call is logged
echo "$@" >> "$FAKE_GIT_LOG"
if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then
  cat > "$FAKE_GIT_LOG.stdin"
  echo "prompt=$GIT_TERMINAL_PROMPT" >> "$FAKE_GIT_LOG"
  if [ -n "$FAKE_GIT_FAIL" ]; then exit 1; fi
  printf 'protocol=https\\nhost=github.com\\nusername=someone\\n'
  if [ -n "$FAKE_GIT_TOKEN" ]; then printf 'password=%s\\n' "$FAKE_GIT_TOKEN"; fi
  if [ -n "$FAKE_GIT_EMPTY_PASSWORD" ]; then printf 'password=\\n'; fi
  exit 0
fi
exit 1
"""


class Stub:
    """A stub GitHub: one scripted answer per path, every request recorded."""

    def __init__(self):
        self.requests = []
        self.answer = (201, {'number': 684, 'html_url': PR_URL}, {})
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length)
                stub.requests.append({
                    'path': self.path, 'headers': dict(self.headers), 'raw': raw,
                    'json': json.loads(raw.decode('utf-8')) if raw else None,
                })
                status, payload, headers = stub.answer
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class OpenForkPrTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = Stub()

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()

    def setUp(self):
        self.stub.requests.clear()
        self.stub.answer = (201, {'number': 684, 'html_url': PR_URL}, {})
        self.tmp = tempfile.mkdtemp(prefix='open-fork-pr-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = os.path.join(self.tmp, 'bin')
        os.mkdir(self.bin)
        fake = os.path.join(self.bin, 'git')
        with open(fake, 'w') as handle:
            handle.write(FAKE_GIT)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)
        self.git_log = os.path.join(self.tmp, 'git.log')
        self.body_file = os.path.join(self.tmp, 'body.md')
        with open(self.body_file, 'w', encoding='utf-8') as handle:
            handle.write(BODY)

    def run_script(self, args=None, env_extra=None, api_base=None, token=TOKEN):
        env = {k: v for k, v in os.environ.items()
               if not k.lower().endswith('_proxy') and not k.startswith('FAKE_GIT')
               and k != 'OPEN_FORK_PR_API_BASE'}
        env['PATH'] = self.bin + os.pathsep + '/usr/bin' + os.pathsep + '/bin'
        env['FAKE_GIT_LOG'] = self.git_log
        if token:
            env['FAKE_GIT_TOKEN'] = token
        env['OPEN_FORK_PR_API_BASE'] = api_base or 'http://127.0.0.1:%d' % self.stub.port
        env.update(env_extra or {})
        if args is None:
            args = ['--head', 'feat/x', '--title', 'feat(x): add x', '--body-file', self.body_file]
        done = subprocess.run([sys.executable, SCRIPT] + args, env=env, capture_output=True, text=True, timeout=60)
        return done

    def git_calls(self):
        if not os.path.exists(self.git_log):
            return []
        with open(self.git_log) as handle:
            return handle.read().splitlines()

    def assertNoToken(self, done):
        self.assertNotIn(TOKEN, done.stdout)
        self.assertNotIn(TOKEN, done.stderr)

    # 1. happy path

    def test_opens_the_pull_request_and_prints_number_and_url(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, 'PR 684 %s\n' % PR_URL)
        self.assertEqual(done.stderr, '')
        self.assertEqual(len(self.stub.requests), 1)
        req = self.stub.requests[0]
        self.assertEqual(req['path'], '/repos/cett/marveen/pulls')
        self.assertEqual(req['json'], {'title': 'feat(x): add x', 'head': 'feat/x', 'base': 'develop', 'body': BODY})
        self.assertEqual(req['headers']['Authorization'], 'Bearer ' + TOKEN)
        self.assertEqual(req['headers']['Accept'], 'application/vnd.github+json')
        self.assertTrue(req['headers']['User-Agent'])
        self.assertNoToken(done)

    def test_base_can_be_chosen_and_defaults_to_develop(self):
        done = self.run_script(['--head', 'feat/x', '--title', 't', '--body-file', self.body_file, '--base', 'main'])
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.stub.requests[0]['json']['base'], 'main')

    def test_body_is_sent_as_utf8_and_the_file_is_left_alone(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.stub.requests[0]['json']['body'], BODY)
        with open(self.body_file, encoding='utf-8') as handle:
            self.assertEqual(handle.read(), BODY)

    # 2. every refusal

    def test_validation_error_shows_githubs_own_messages(self):
        self.stub.answer = (422, {
            'message': 'Validation Failed',
            'errors': [{'resource': 'PullRequest', 'code': 'custom',
                        'message': 'A pull request already exists for cett:feat/x.'}],
        }, {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stdout, '')
        self.assertIn('GitHub 422', done.stderr)
        self.assertIn('Validation Failed', done.stderr)
        self.assertIn('A pull request already exists', done.stderr)
        self.assertNoToken(done)

    def test_errors_without_a_message_are_described_by_resource_field_code(self):
        self.stub.answer = (422, {'message': 'Validation Failed',
                                  'errors': [{'resource': 'PullRequest', 'field': 'head', 'code': 'invalid'}]}, {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertIn('PullRequest head invalid', done.stderr)

    def test_bad_credentials_fail(self):
        self.stub.answer = (401, {'message': 'Bad credentials'}, {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertIn('GitHub 401: Bad credentials', done.stderr)
        self.assertNoToken(done)

    def test_a_token_that_comes_back_in_the_answer_is_starred_out(self):
        self.stub.answer = (403, {'message': 'Resource not accessible with %s' % TOKEN}, {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertIn('Resource not accessible with ***', done.stderr)
        self.assertNoToken(done)

    def test_a_non_json_answer_is_shown_short(self):
        self.stub.answer = (502, b'<html>' + b'bad gateway ' * 400 + b'</html>', {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertIn('GitHub 502', done.stderr)
        self.assertLess(len(done.stderr), 800)

    def test_a_success_without_number_and_url_is_a_failure(self):
        self.stub.answer = (201, {'id': 1}, {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stdout, '')
        self.assertIn('without a pull request number and URL', done.stderr)

    def test_a_success_without_a_url_is_a_failure(self):
        self.stub.answer = (201, {'number': 684}, {})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stdout, '')

    def test_an_unreachable_github_is_a_failure(self):
        dead = Stub()
        port = dead.port
        dead.close()
        done = self.run_script(api_base='http://127.0.0.1:%d' % port)
        self.assertEqual(done.returncode, 1)
        self.assertIn('could not reach GitHub', done.stderr)
        self.assertNoToken(done)

    # 3. the credential

    def test_the_credential_is_asked_for_github_without_prompting(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('credential fill', self.git_calls())
        self.assertIn('prompt=0', self.git_calls())
        with open(self.git_log + '.stdin') as handle:
            asked = handle.read()
        self.assertIn('protocol=https', asked)
        self.assertIn('host=github.com', asked)

    def test_no_password_in_the_answer_sends_no_request(self):
        done = self.run_script(token='')
        self.assertEqual(done.returncode, 1)
        self.assertIn('no password', done.stderr)
        self.assertEqual(self.stub.requests, [])

    def test_an_empty_password_sends_no_request(self):
        done = self.run_script(token='', env_extra={'FAKE_GIT_EMPTY_PASSWORD': '1'})
        self.assertEqual(done.returncode, 1)
        self.assertIn('no password', done.stderr)
        self.assertEqual(self.stub.requests, [])

    def test_a_failing_credential_helper_sends_no_request(self):
        done = self.run_script(env_extra={'FAKE_GIT_FAIL': '1'})
        self.assertEqual(done.returncode, 1)
        self.assertIn('no GitHub credential', done.stderr)
        self.assertEqual(self.stub.requests, [])

    # 4. usage errors send nothing

    def test_missing_arguments_exit_2(self):
        for args in ([], ['--head', 'x'], ['--head', 'x', '--title', 't'], ['--title', 't', '--body-file', 'b']):
            done = self.run_script(args)
            self.assertEqual(done.returncode, 2, args)
        self.assertEqual(self.stub.requests, [])
        self.assertEqual(self.git_calls(), [])

    def test_unreadable_body_file_exits_2(self):
        done = self.run_script(['--head', 'x', '--title', 't', '--body-file', os.path.join(self.tmp, 'nope.md')])
        self.assertEqual(done.returncode, 2)
        self.assertIn('cannot read the body file', done.stderr)
        self.assertEqual(self.stub.requests, [])
        self.assertEqual(self.git_calls(), [])

    def test_empty_head_or_title_exits_2(self):
        for args in (['--head', ' ', '--title', 't', '--body-file', self.body_file],
                     ['--head', 'x', '--title', '', '--body-file', self.body_file]):
            done = self.run_script(args)
            self.assertEqual(done.returncode, 2, args)
        self.assertEqual(self.stub.requests, [])

    def test_the_api_base_override_is_loopback_http_only(self):
        for base in ('https://evil.example', 'http://evil.example', 'https://127.0.0.1:1', 'http://127.0.0.1.evil.example'):
            done = self.run_script(api_base=base)
            self.assertEqual(done.returncode, 2, base)
            self.assertIn('loopback', done.stderr)
        # the credential was never looked up for any of them
        self.assertEqual(self.git_calls(), [])
        self.assertEqual(self.stub.requests, [])

    # 5. redirects

    def test_a_redirect_is_not_followed(self):
        self.stub.answer = (301, b'', {'Location': 'http://127.0.0.1:%d/elsewhere' % self.stub.port})
        done = self.run_script()
        self.assertEqual(done.returncode, 1)
        self.assertIn('GitHub 301', done.stderr)
        self.assertEqual(len(self.stub.requests), 1)
        self.assertNoToken(done)


if __name__ == '__main__':
    unittest.main(verbosity=1)
