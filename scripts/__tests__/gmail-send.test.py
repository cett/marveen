#!/usr/bin/env python3
"""Tests for scripts/gmail-send.py (the official plain-text sender, bound to one owner approval).

The sender runs as a subprocess inside a throw-away install tree (its own .env, main-agent token, copies
of scripts/lib/email_extract.py and scripts/hooks/agent_token.py), talking to TWO stubs on loopback ports:
a dashboard (claim / request) and a Google (OAuth token + users.messages.send). Both write into one event
list, so the ORDER of the calls is asserted. Fixture data only (example.test).

  1. The happy path: what the claim carries, what reaches Gmail, the order token -> claim -> send.
  2. Every refusal sends nothing and never calls the Gmail send endpoint.
  3. The approval is about this mail: wrong answer fields, an attachment that changed after the hash.
  4. What the agent's environment cannot do: move the dashboard, use a proxy, skip the claim.
  5. Hash parity with the send gate's reader, unreadable input, output hygiene.

Run: python3 <thisfile>   (GMAIL_SEND_PATH names a sender file other than scripts/gmail-send.py: mutation runs)
"""
import email
import email.policy
import hashlib
import hmac
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
SENDER_SRC = os.environ.get('GMAIL_SEND_PATH') or os.path.join(SCRIPTS, 'gmail-send.py')
sys.path.insert(0, os.path.join(SCRIPTS, 'lib'))
import email_extract as E  # noqa: E402

TOKEN = 'tok-main-0123456789abcdef'
ACCESS = 'ya29.access-token-fixture'
MAIN = 'jarvis'
BODY = 'Here are the notes from this week.'
MAIL_ARGS = ['--to', 'ann@example.test', '--subject', 'Weekly notes', '--body', BODY]
CLAIM_KEY = 'a1' * 32          # the dashboard's claim signing key, as the file holds it (64 hex characters)
OTHER_KEY = 'b2' * 32          # a key some other listener made up
CONSUMED_AT = 1760000000


def sign_claim(key_hex, content_hash, category, agent_id, ref, consumed_at):
    """What the dashboard signs: HMAC-SHA256 of v1|hash|category|agent|ref|consumed_at, the key being the bytes of the hex."""
    text = 'v1|%s|%s|%s|%s|%s' % (content_hash, category, agent_id, ref if ref is not None else '', consumed_at)
    return hmac.new(bytes.fromhex(key_hex), text.encode('utf-8'), hashlib.sha256).hexdigest()


def _claim_ok(aid='appr-1', sig_key=CLAIM_KEY, sig_fields=None, sig='auto', **override):
    """The dashboard's 200: the approval row and its signature. sig_key=None answers with no `sig` (a mirror that
    has no key), sig_fields overrides what is signed (not what is shown), sig='...' sends that value as it is."""
    def answer(request):
        row = {'id': aid, 'agent_id': MAIN, 'category': request['category'], 'content_hash': request['content_hash'],
               'status': 'approved', 'consumed_by': MAIN, 'consumed_ref': request['ref'], 'consumed_at': CONSUMED_AT, 'action_payload': '{}'}
        row.update(override)
        body = {'ok': True, 'replayed': False, 'window_s': 1800, 'approval': {k: v for k, v in row.items() if v is not None}}
        signed = dict(row, **(sig_fields or {}))
        if sig != 'auto':
            body['sig'] = sig
        elif sig_key is not None:
            body['sig'] = sign_claim(sig_key, signed['content_hash'], signed['category'], signed['agent_id'], signed['consumed_ref'], signed['consumed_at'])
        return 200, body
    return answer


def _conflict(reason, **extra):
    return 409, dict({'error': 'conflict', 'reason': reason, 'window_s': 1800, 'approval': None}, **extra)


class _Stub:
    """A scripted loopback HTTP server that records every request into `requests` and `events`."""

    def __init__(self, events):
        self.events = events
        self.requests = []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: D401
                pass

            def _do(self):
                n = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(n) if n else b''
                try:
                    parsed = json.loads(body) if body else None
                except ValueError:
                    parsed = body
                stub.requests.append((self.command, self.path, parsed, dict(self.headers)))
                reply = stub.reply(self.command, self.path, parsed, dict(self.headers))
                if reply is None:   # drop the connection without an answer
                    self.close_connection = True
                    return
                status, obj, extra = reply
                data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
                self.send_response(status)
                for k, v in extra.items():
                    self.send_header(k, v)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _do

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reply(self, method, path, body, headers):
        raise NotImplementedError

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def paths(self):
        return [(m, p) for m, p, _, _ in self.requests]


class Dash(_Stub):
    def __init__(self, events):
        super().__init__(events)
        self.claim = _claim_ok()
        self.create = (201, {'id': 'req-1', 'status': 'pending'})
        self.hang = set()
        self.redirect = None
        self.before_claim_answer = None   # a callable run when a claim arrives (the file changes under the sender)

    def reply(self, method, path, body, headers):
        if path == '/api/approvals/claim':
            self.events.append('claim')
            if self.before_claim_answer:
                self.before_claim_answer()
        if path in self.hang:
            time.sleep(6)
        if self.redirect and path == '/api/approvals/claim':
            return 302, b'', {'Location': self.redirect}
        answer = {('POST', '/api/approvals/claim'): self.claim, ('POST', '/api/approvals'): self.create}.get((method, path), (404, {'error': 'not_found'}))
        status, obj = answer(body) if callable(answer) else answer
        return status, obj, {}


class Google(_Stub):
    def __init__(self, events):
        super().__init__(events)
        self.token = (200, {'access_token': ACCESS, 'expires_in': 3600, 'token_type': 'Bearer'})
        self.send = (200, {'id': 'msg-1', 'threadId': 'thr-1', 'labelIds': ['SENT']})
        self.drop_send = False
        self.raw_messages = []

    def reply(self, method, path, body, headers):
        if path == '/token':
            self.events.append('token')
            return self.token[0], self.token[1], {}
        if path == '/gmail/v1/users/me/messages/send':
            self.events.append('send')
            if headers.get('Authorization') != 'Bearer ' + ACCESS:
                return 401, {'error': {'code': 401}}, {}
            import base64
            self.raw_messages.append(base64.urlsafe_b64decode(body['raw'] + '=' * (-len(body['raw']) % 4)))
            if self.drop_send:
                return None
            return self.send[0], self.send[1], {}
        return 404, {'error': 'not_found'}, {}

    def sent_calls(self):
        return [r for r in self.requests if r[1] == '/gmail/v1/users/me/messages/send']


def load_sender_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location('gmail_send_under_test', SENDER_SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Result:
    def __init__(self, rc, out, err):
        self.rc, self.out, self.err = rc, out, err

    @property
    def text(self):
        return self.out + self.err


class SenderCase(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.dash = Dash(self.events)
        self.google = Google(self.events)
        self.root = tempfile.mkdtemp(prefix='gmail-send-')
        for rel in ('scripts/lib', 'scripts/hooks', 'store', 'work', 'cred'):
            os.makedirs(os.path.join(self.root, rel))
        shutil.copy(SENDER_SRC, os.path.join(self.root, 'scripts/gmail-send.py'))
        shutil.copy(os.path.join(SCRIPTS, 'lib/email_extract.py'), os.path.join(self.root, 'scripts/lib/'))
        shutil.copy(os.path.join(SCRIPTS, 'hooks/agent_token.py'), os.path.join(self.root, 'scripts/hooks/'))
        self.write_env()
        self.write('.agent-token', TOKEN)
        self.write('store/.claim-signing-key', CLAIM_KEY)
        self.write('cred/token.json', json.dumps({'refresh_token': 'refresh-fixture'}))
        self.write('cred/credentials.json', json.dumps({'installed': {
            'client_id': 'cid', 'client_secret': 'csecret', 'token_uri': 'http://127.0.0.1:%d/token' % self.google.port}}))
        self.script = os.path.join(self.root, 'scripts/gmail-send.py')

    def tearDown(self):
        self.dash.stop()
        self.google.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, rel, text):
        with open(os.path.join(self.root, rel), 'w', encoding='utf-8') as fh:
            fh.write(text)

    def write_env(self, extra='', gmail=True):
        # The Gmail stand-ins are named in the install's .env: the sender does not read them from the environment.
        lines = 'WEB_PORT=%d\nMAIN_AGENT_ID=%s\n' % (self.dash.port, MAIN)
        if gmail:
            lines += 'GMAIL_CRED_DIR=%s\nGMAIL_SEND_API_BASE=http://127.0.0.1:%d\n' % (os.path.join(self.root, 'cred'), self.google.port)
        self.write('.env', lines + extra)

    def write_bytes(self, rel, data):
        with open(os.path.join(self.root, rel), 'wb') as fh:
            fh.write(data)

    def run_sender(self, args, stdin=None, extra_env=None, cwd=None):
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.root}
        env.update(extra_env or {})
        p = subprocess.run([sys.executable, self.script] + list(args), input=stdin.encode('utf-8') if stdin is not None else None,
                           stdin=None if stdin is not None else subprocess.DEVNULL, capture_output=True, env=env,
                           cwd=cwd or self.root, timeout=40)
        res = Result(p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace'))
        # Output hygiene, in every run: a token or any part of the mail text never reaches the caller.
        for secret in (TOKEN, ACCESS, 'refresh-fixture', 'csecret', BODY):
            self.assertNotIn(secret, res.text)
        return res

    def claims(self):
        return [r for r in self.dash.requests if r[1] == '/api/approvals/claim']

    def expected_hash(self, args=None, stdin_command=None):
        cmd = stdin_command or 'python3 scripts/gmail-send.py ' + ' '.join(shlex.quote(a) for a in (args or MAIL_ARGS))
        built = E.envelope_of_call('Bash', {'command': cmd}, MAIN, self.root)
        self.assertTrue(built['ok'], built)
        return built['hash'], built['canon']

    def assert_nothing_sent(self, res=None, rc=None):
        self.assertEqual(self.google.sent_calls(), [], 'the Gmail send endpoint must not be called')
        self.assertEqual(self.google.raw_messages, [])
        if res is not None and rc is not None:
            self.assertEqual(res.rc, rc, res.text)
            self.assertNotIn('SENT id=', res.out)

    def parsed(self, index=0):
        return email.message_from_bytes(self.google.raw_messages[index], policy=email.policy.default)


def _text_of(msg):
    body = msg if not msg.is_multipart() else msg.get_body(('plain',))
    return body.get_payload(decode=True).decode('utf-8')


class HappyPath(SenderCase):
    def test_sends_the_approved_mail_after_the_token_refresh_and_the_claim(self):
        want, _ = self.expected_hash()
        res = self.run_sender(MAIL_ARGS)
        self.assertEqual((res.rc, res.out.strip(), res.err), (0, 'SENT id=msg-1', ''))
        self.assertEqual(self.events, ['token', 'claim', 'send'], 'refresh first, then spend the approval, then send')
        self.assertEqual(len(self.claims()), 1)
        _, _, body, headers = self.claims()[0]
        self.assertEqual(body['category'], 'email_send')
        self.assertEqual(body['content_hash'], want)
        self.assertEqual(body['consumer'], 'gmail-send')
        self.assertRegex(body['ref'], r'^send-[0-9a-f]{32}$')
        self.assertEqual(set(body), {'category', 'content_hash', 'consumer', 'ref'})
        self.assertEqual(headers.get('Authorization'), 'Bearer ' + TOKEN)
        self.assertEqual(headers.get('X-Agent-Id'), MAIN)
        self.assertEqual(self.dash.paths(), [('POST', '/api/approvals/claim')], 'no request is opened for an approved mail')

    def test_the_raw_message_is_exactly_the_approved_mail(self):
        body = 'Szia!\n\nA heti jegyzetek: árvíztűrő tükörfúrógép.\nVége.\n'
        subject = 'Heti jegyzetek: árvíztűrő tükörfúrógép ' + 'x' * 120
        res = self.run_sender(['--to', 'Ann@Example.TEST', '--to', 'bob@example.test', '--cc', 'cy@example.test', '--bcc', 'di@example.test',
                               '--subject', subject, '--body', body, '--from', 'me@example.test', '--reply-to', 'rep@example.test',
                               '--in-reply-to', '<orig-1@example.test>'])
        self.assertEqual(res.rc, 0, res.text)
        msg = self.parsed()
        self.assertEqual(msg['Subject'], subject)
        self.assertEqual(sorted(a.addr_spec for a in msg['To'].addresses), ['Ann@example.test', 'bob@example.test'])   # the domain is lower-cased by the envelope
        self.assertEqual(msg['Cc'], 'cy@example.test')
        self.assertEqual(msg['Bcc'], 'di@example.test')
        self.assertEqual(msg['From'], 'me@example.test')
        self.assertEqual(msg['Reply-To'], 'rep@example.test')
        self.assertEqual(msg['In-Reply-To'], '<orig-1@example.test>')
        self.assertFalse(msg.is_multipart())
        self.assertEqual(msg.get_content_type(), 'text/plain')
        self.assertEqual(_text_of(msg), body)

    def test_attachments_are_sent_byte_for_byte(self):
        a = bytes(range(256)) * 40
        b = 'tartalom\nsorok\n'.encode('utf-8')
        self.write_bytes('work/data.bin', a)
        self.write_bytes('work/árvíz.txt', b)
        res = self.run_sender(MAIL_ARGS + ['--attach', 'work/data.bin', '--attach', os.path.join(self.root, 'work/árvíz.txt')])
        self.assertEqual(res.rc, 0, res.text)
        msg = self.parsed()
        self.assertEqual(_text_of(msg.get_body(('plain',))), BODY)
        got = {p.get_filename(): p.get_payload(decode=True) for p in msg.iter_attachments()}
        self.assertEqual(got, {'data.bin': a, 'árvíz.txt': b})
        want, _ = self.expected_hash(MAIL_ARGS + ['--attach', 'work/data.bin', '--attach', os.path.join(self.root, 'work/árvíz.txt')])
        self.assertEqual(self.claims()[0][2]['content_hash'], want)

    def test_body_from_a_file_and_from_stdin(self):
        self.write('work/body.txt', 'From a file.\nSecond line.\n')
        res = self.run_sender(['--to', 'ann@example.test', '--subject', 'S', '--body-file', 'work/body.txt'])
        self.assertEqual(res.rc, 0, res.text)
        self.assertEqual(_text_of(self.parsed(0)), 'From a file.\nSecond line.\n')
        res = self.run_sender(['--to', 'ann@example.test', '--subject', 'S'], stdin='From stdin.\nLast.\n')
        self.assertEqual(res.rc, 0, res.text)
        self.assertEqual(_text_of(self.parsed(1)), 'From stdin.\nLast.\n')

    def test_two_runs_use_two_different_references(self):
        self.run_sender(MAIL_ARGS)
        self.run_sender(MAIL_ARGS)
        refs = [c[2]['ref'] for c in self.claims()]
        self.assertEqual(len(set(refs)), 2)

    def test_help_prints_usage_and_touches_nothing(self):
        res = self.run_sender(['--help'])
        self.assertEqual(res.rc, 0)
        self.assertIn('no --html', res.out)
        self.assertEqual((self.dash.requests, self.google.requests), ([], []))

    def test_dry_run_builds_the_hash_and_calls_nothing(self):
        want, _ = self.expected_hash()
        os.remove(os.path.join(self.root, '.agent-token'))   # a dry run needs no token, only the agent id
        res = self.run_sender(MAIL_ARGS, extra_env={'GMAIL_SEND_DRY_RUN': '1'})
        self.assertEqual((res.rc, res.out.strip()), (0, 'DRY-OK hash=' + want[:12]), res.text)
        self.assertEqual((self.dash.requests, self.google.requests, self.events), ([], [], []))


class Refusals(SenderCase):
    def test_no_usable_approval_opens_a_request_and_sends_nothing(self):
        want, canon = self.expected_hash()
        for reason in ('none', 'expired', 'already_consumed', 'rejected', 'not_human_decided'):
            with self.subTest(reason=reason):
                self.dash.requests.clear()
                self.dash.claim = _conflict(reason)
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 3)
                self.assertIn('req-1', res.err)
                self.assertIn(want[:12], res.err)
                self.assertIn('SAME command', res.err)
                self.assertIn(reason, res.err)
                opened = [r for r in self.dash.requests if r[:2] == ('POST', '/api/approvals')]
                self.assertEqual(len(opened), 1)
                body = opened[0][2]
                self.assertEqual(body, {'agent_id': MAIN, 'category': 'email_send', 'content_hash': want, 'action_payload': canon})
                self.assertEqual(opened[0][3].get('Authorization'), 'Bearer ' + TOKEN)

    def test_an_already_open_request_is_reported_as_such(self):
        self.dash.claim = _conflict('none')
        self.dash.create = (200, {'id': 'req-2', 'status': 'pending', 'deduplicated': True})
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 3)
        self.assertIn('req-2', res.err)
        self.assertIn('already open', res.err)

    def test_pending_names_the_request_and_opens_no_second_one(self):
        self.dash.claim = _conflict('pending', approval_id='req-9')
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 3)
        self.assertIn('req-9', res.err)
        self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_unknown_claim_reason_refuses_without_a_request(self):
        for reason in ('wrong_category', 'hash_mismatch', 'surprise', ''):
            with self.subTest(reason=reason):
                self.dash.requests.clear()
                self.dash.claim = _conflict(reason)
                self.assert_nothing_sent(self.run_sender(MAIL_ARGS), 3)
                self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_claim_failures_refuse_and_open_nothing(self):
        for label, answer in [('401', (401, {'error': 'unauthorized'})), ('403', (403, {'error': 'forbidden', 'reason': 'agent_identity_required'})),
                              ('404', (404, {'error': 'not_found'})), ('500', (500, {'error': 'x'})), ('503', (503, {})),
                              ('not json', (200, b'ok')), ('200 without ok', (200, {'approval': {'id': 'a'}})),
                              ('200 ok false', (200, {'ok': False, 'approval': {'id': 'a'}})), ('200 null', (200, b'null')),
                              ('200 ok no approval', (200, {'ok': True})), ('200 approval not an object', (200, {'ok': True, 'approval': 'x'})),
                              ('409 without reason', (409, {'error': 'conflict'})), ('409 not json', (409, b'x')),
                              ('302', (302, {}))]:
            with self.subTest(label):
                self.dash.requests.clear()
                self.dash.claim = answer
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 3)
                self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_a_redirect_is_not_followed(self):
        decoy = Dash(self.events)
        try:
            self.dash.redirect = 'http://127.0.0.1:%d/api/approvals/claim' % decoy.port
            self.assert_nothing_sent(self.run_sender(MAIL_ARGS), 3)
            self.assertEqual(decoy.requests, [])
        finally:
            decoy.stop()

    def test_request_opening_failures_refuse(self):
        self.dash.claim = _conflict('none')
        for label, answer in [('400', (400, {'error': 'invalid_value'})), ('403', (403, {'error': 'forbidden'})),
                              ('409 too many', (409, {'error': 'conflict', 'reason': 'too_many_pending'})), ('500', (500, {})),
                              ('201 without id', (201, {'status': 'pending'})), ('not json', (201, b'x'))]:
            with self.subTest(label):
                self.dash.create = answer
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 3)
                self.assertIn('request_failed', res.err)

    def test_a_dashboard_that_does_not_answer_in_time_refuses(self):
        self.dash.hang = {'/api/approvals/claim'}
        t0 = time.monotonic()
        res = self.run_sender(MAIL_ARGS)
        self.assertLess(time.monotonic() - t0, 6.0)
        self.assert_nothing_sent(res, 3)
        self.assertIn('claim_unavailable', res.err)

    def test_a_dashboard_that_is_down_refuses(self):
        self.dash.stop()
        self.dash = Dash(self.events)   # a fresh port nobody told the sender about
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 3)
        self.assertIn('claim_unavailable', res.err)

    def test_a_claim_answer_about_another_mail_agent_or_use_is_not_a_yes(self):
        for field, wrong in [('content_hash', 'f' * 64), ('category', 'other'), ('agent_id', 'someone-else'), ('status', 'pending'),
                             ('consumed_by', 'someone-else'), ('consumed_ref', 'send-0'), ('consumed_ref', None), ('content_hash', None),
                             ('agent_id', None), ('category', None), ('status', None), ('consumed_by', None)]:
            with self.subTest(field=field, wrong=wrong):
                self.dash.requests.clear()
                self.dash.claim = _claim_ok(**{field: wrong})
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 3)
                self.assertIn('claim_mismatch', res.err)
                self.assertIn(field, res.err)
                self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())
        self.dash.claim = (200, {'ok': True, 'approval': {'id': 'x'}})   # a bare yes
        self.assert_nothing_sent(self.run_sender(MAIL_ARGS), 3)

    def test_a_fully_matching_approval_without_ok_true_is_not_a_yes(self):
        for label, ok in [('ok false', False), ('ok text', 'true'), ('ok one', 1), ('ok missing', None)]:
            with self.subTest(label):
                def answer(request, ok=ok):
                    status, obj = _claim_ok()(request)
                    obj = dict(obj)
                    obj.pop('ok')
                    if ok is not None:
                        obj['ok'] = ok
                    return status, obj
                self.dash.claim = answer
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 3)
                self.assertIn('claim_bad_answer', res.err)


class ClaimSignature(SenderCase):
    """The claim answer must be signed with the key the dashboard keeps in store/.claim-signing-key."""

    def _refused(self, claim=None):
        if claim is not None:
            self.dash.claim = claim
        self.google.requests.clear()
        self.google.raw_messages.clear()
        self.dash.requests.clear()
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 3)
        self.assertIn('REFUSED claim_unsigned', res.err)
        self.assertEqual(len(self.claims()), 1)
        self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_a_signed_answer_sends(self):
        res = self.run_sender(MAIL_ARGS)
        self.assertEqual(res.rc, 0, res.text)
        self.assertIn('SENT id=msg-1', res.out)

    def test_a_mirror_without_the_key_is_refused(self):
        # it echoes hash, category, agent and reference: every echo check passes, it still cannot sign
        self._refused(_claim_ok(sig_key=None))
        self._refused(_claim_ok(sig_key=OTHER_KEY))
        for forged in ('', 'f' * 64, '0' * 64, 'x', None, 12, ['a'], {'a': 1}, True):
            with self.subTest(sig=forged):
                self._refused(_claim_ok(sig=forged))

    def test_a_signature_over_another_value_is_refused(self):
        for field, other in [('content_hash', 'f' * 64), ('category', 'other'), ('agent_id', 'someone-else'),
                             ('consumed_ref', 'send-0'), ('consumed_ref', None), ('consumed_at', CONSUMED_AT + 1)]:
            with self.subTest(field=field):
                self._refused(_claim_ok(sig_fields={field: other}))

    def test_the_signature_must_be_exactly_the_lowercase_hex_digest(self):
        def padded(request):
            status, body = _claim_ok()(request)
            body['sig'] += '\n'
            return status, body
        self._refused(padded)

        def upper(request):
            status, body = _claim_ok()(request)
            body['sig'] = body['sig'].upper()
            return status, body
        self._refused(upper)

    def test_a_missing_or_wrong_type_consumed_at_is_refused(self):
        for bad in (None, '1760000000', 1760000000.0, True, 0, -5, [1], {}):
            with self.subTest(consumed_at=bad):
                self._refused(_claim_ok(consumed_at=bad, sig_fields={'consumed_at': bad}))

    def test_no_usable_key_file_is_a_refusal(self):
        path = os.path.join(self.root, 'store/.claim-signing-key')
        for label, content in [('missing', None), ('empty', ''), ('short', 'ab' * 16), ('not hex', 'zz' * 32), ('upper case', 'AB' * 32),
                               ('trailing junk', CLAIM_KEY + 'ab'), ('binary', '\x00\x01')]:
            with self.subTest(key=label):
                if os.path.isdir(path):
                    os.rmdir(path)
                elif os.path.exists(path):
                    os.remove(path)
                if content is not None:
                    self.write('store/.claim-signing-key', content)
                self._refused(_claim_ok())
        if os.path.exists(path):
            os.remove(path)
        os.mkdir(path)      # a directory where the key should be
        self._refused(_claim_ok())

    def test_a_key_that_is_not_the_one_the_answer_was_signed_with_is_refused(self):
        self.write('store/.claim-signing-key', OTHER_KEY)
        self._refused(_claim_ok())

    def test_the_key_comes_from_the_senders_own_install_not_from_the_environment(self):
        other = tempfile.mkdtemp(prefix='gmail-send-key-')
        try:
            self.dash.claim = _claim_ok(sig_key=OTHER_KEY)
            for name in ('CLAIM_SIGNING_KEY', 'CLAIM_SIGNING_KEY_FILE', 'MARVEEN_STORE_DIR', 'STORE_DIR'):
                self.dash.requests.clear()
                res = self.run_sender(MAIL_ARGS, extra_env={name: OTHER_KEY if 'FILE' not in name and 'DIR' not in name else other})
                self.assertEqual(res.rc, 3, name)
                self.assertIn('claim_unsigned', res.err, name)
                self.assertEqual(self.google.sent_calls(), [])
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_the_refusal_never_prints_the_key_or_the_signature(self):
        self.dash.claim = _claim_ok(sig_key=OTHER_KEY)
        res = self.run_sender(MAIL_ARGS)
        self.assertEqual(res.rc, 3)
        for secret in (CLAIM_KEY, OTHER_KEY, sign_claim(OTHER_KEY, 'x', 'y', 'z', 'r', CONSUMED_AT)):
            self.assertNotIn(secret, res.text)


class TheApprovalIsAboutThisMail(SenderCase):
    def test_an_attachment_that_changed_after_the_hash_is_not_sent(self):
        self.write_bytes('work/report.bin', b'approved bytes')
        args = MAIL_ARGS + ['--attach', 'work/report.bin']
        self.dash.before_claim_answer = lambda: self.write_bytes('work/report.bin', b'swapped bytes!')
        res = self.run_sender(args)
        self.assert_nothing_sent(res, 1)
        self.assertEqual(self.events, ['token', 'claim'])
        self.assertIn('ATTACHMENT_CHANGED', res.err)
        self.assertIn('SPENT', res.err)

    def test_an_attachment_with_the_same_length_but_other_bytes_is_not_sent(self):
        self.write_bytes('work/report.bin', b'AAAA')
        self.dash.before_claim_answer = lambda: self.write_bytes('work/report.bin', b'AAAB')
        self.assert_nothing_sent(self.run_sender(MAIL_ARGS + ['--attach', 'work/report.bin']), 1)

    def test_an_attachment_that_grew_or_vanished_is_not_sent(self):
        self.write_bytes('work/report.bin', b'abc')
        self.dash.before_claim_answer = lambda: self.write_bytes('work/report.bin', b'abcdef')
        self.assert_nothing_sent(self.run_sender(MAIL_ARGS + ['--attach', 'work/report.bin']), 1)
        self.write_bytes('work/report.bin', b'abc')
        self.dash.before_claim_answer = lambda: os.remove(os.path.join(self.root, 'work/report.bin'))
        self.assert_nothing_sent(self.run_sender(MAIL_ARGS + ['--attach', 'work/report.bin']), 1)

    def test_an_unchanged_attachment_is_sent_through_the_same_path(self):
        self.write_bytes('work/report.bin', b'approved bytes')
        self.dash.before_claim_answer = lambda: None
        res = self.run_sender(MAIL_ARGS + ['--attach', 'work/report.bin'])
        self.assertEqual(res.rc, 0, res.text)

    def test_a_body_file_edited_after_the_hash_does_not_change_the_sent_text(self):
        # the sender sends the HELD fields, it never re-reads the body file
        self.write('work/body.txt', 'approved text\n')
        self.dash.before_claim_answer = lambda: self.write('work/body.txt', 'swapped text\n')
        res = self.run_sender(['--to', 'ann@example.test', '--subject', 'S', '--body-file', 'work/body.txt'])
        self.assertEqual(res.rc, 0, res.text)
        self.assertEqual(_text_of(self.parsed()), 'approved text\n')


class GmailSide(SenderCase):
    def test_a_failed_token_refresh_ends_before_any_approval_is_touched(self):
        for answer in [(400, {'error': 'invalid_grant'}), (200, {'no': 'token'}), (500, b'x')]:
            with self.subTest(answer=answer):
                self.dash.requests.clear()
                self.google.token = answer
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 1)
                self.assertEqual(self.dash.requests, [], 'a broken login must not burn an approval')
                self.assertIn('TOKEN_REFRESH_FAIL', res.err)

    def test_missing_login_files_end_before_any_approval_is_touched(self):
        os.remove(os.path.join(self.root, 'cred/credentials.json'))
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 1)
        self.assertEqual(self.dash.requests, [])
        self.assertIn('MISSING_CREDS', res.err)

    def test_gmail_refusing_the_send_says_the_approval_is_spent(self):
        self.google.send = (500, {'error': 'backend'})
        res = self.run_sender(MAIL_ARGS)
        self.assertEqual(res.rc, 1)
        self.assertIn('SEND_FAIL', res.err)
        self.assertIn('SPENT', res.err)
        self.assertIn('did NOT leave', res.err)
        self.assertNotIn('SENT id=', res.out)

    def test_no_answer_from_gmail_is_reported_as_unknown(self):
        self.google.drop_send = True
        res = self.run_sender(MAIL_ARGS)
        self.assertEqual(res.rc, 1)
        self.assertIn('SEND_UNKNOWN', res.err)
        self.assertIn('Sent folder', res.err)

    def test_gmail_api_base_must_be_http(self):
        for base in ('file:///etc', 'ftp://127.0.0.1/x', 'http://'):
            with self.subTest(base=base):
                self.write_env('GMAIL_SEND_API_BASE=%s\n' % base, gmail=False)
                res = self.run_sender(MAIL_ARGS)
                self.assertEqual(res.rc, 1)
                self.assertIn('gmail_base', res.err)
                self.assertEqual(self.dash.requests, [], 'checked before an approval is spent')


class GoogleEndpoints(SenderCase):
    def test_the_gmail_settings_come_from_the_env_file_not_the_environment(self):
        decoy = Google(self.events)
        empty = tempfile.mkdtemp(prefix='gmail-send-cred-')
        try:
            res = self.run_sender(MAIL_ARGS, extra_env={
                'GMAIL_SEND_API_BASE': 'http://127.0.0.1:%d' % decoy.port, 'GMAIL_CRED_DIR': empty})
            self.assertEqual(res.rc, 0, res.text)
            self.assertEqual(decoy.requests, [])
            self.assertEqual(len(self.google.sent_calls()), 1)
        finally:
            decoy.stop()
            shutil.rmtree(empty, ignore_errors=True)

    def test_the_default_credential_directory_is_not_taken_from_home(self):
        # .env names no directory: the account's own ~/.gmail-mcp from the password database, whatever $HOME says.
        # (Only the path is computed; nothing here reads or refreshes a real login.)
        import pwd
        code = ("import importlib.util,sys;"
                "s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                "print(m._cred_dir())")
        self.write_env(gmail=False)
        out = subprocess.run([sys.executable, '-c', code, self.script], capture_output=True, text=True,
                             env={'PATH': os.environ.get('PATH', ''), 'HOME': self.root, 'GMAIL_CRED_DIR': self.root}, cwd=self.root).stdout.strip()
        self.assertEqual(out, os.path.join(pwd.getpwuid(os.getuid()).pw_dir, '.gmail-mcp'))

    def test_a_token_endpoint_that_is_not_google_is_refused_before_anything_is_spent(self):
        stand_in = self.google.port
        for uri in ('http://oauth2.googleapis.com/token', 'https://evil.example/token', 'https://oauth2.googleapis.com.evil.example/token',
                    'https://user:pw@oauth2.googleapis.com/token', 'https://oauth2.googleapis.com:8443/token', 'file:///etc/passwd',
                    'http://127.0.0.1:%d/token' % (stand_in + 1), 'https://127.0.0.1:%d/token' % stand_in, 'http://localhost:%d/token' % stand_in, ''):
            with self.subTest(uri=uri):
                self.write('cred/credentials.json', json.dumps({'installed': {'client_id': 'cid', 'client_secret': 'csecret', 'token_uri': uri}}))
                self.google.requests.clear()
                res = self.run_sender(MAIL_ARGS)
                self.assertEqual(res.rc, 1, res.text)
                self.assertIn('REFUSED token_uri', res.err)
                self.assertEqual((self.dash.requests, self.google.requests), ([], []), 'nothing is sent anywhere')

    def test_a_stand_in_token_endpoint_needs_the_stand_in_base_in_the_env_file(self):
        # same origin as GMAIL_SEND_API_BASE from .env passes (the whole suite relies on it); with no such line it does not
        self.write_env('GMAIL_CRED_DIR=%s\n' % os.path.join(self.root, 'cred'), gmail=False)
        res = self.run_sender(MAIL_ARGS)
        self.assertEqual(res.rc, 1, res.text)
        self.assertIn('REFUSED token_uri', res.err)
        self.assertEqual((self.dash.requests, self.google.requests), ([], []))

    def test_the_default_google_endpoint_is_https_and_allowed(self):
        mod = load_sender_module()
        for uri in ('https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token', 'https://OAUTH2.googleapis.com:443/token'):
            self.assertTrue(mod._token_uri_allowed(uri), uri)
        self.assertEqual(mod.DEFAULT_GMAIL_BASE, 'https://gmail.googleapis.com')

    def test_the_certificate_check_ignores_the_ca_variables_of_the_environment(self):
        code = ("import importlib.util,os,ssl,sys;"
                "s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                "c=m._google_ssl_context();print(c.verify_mode==ssl.CERT_REQUIRED,c.check_hostname,len(c.get_ca_certs()))")
        bogus = os.path.join(self.root, 'bogus-ca.pem')
        self.write('bogus-ca.pem', 'not a certificate\n')
        base = subprocess.run([sys.executable, '-c', code, self.script], capture_output=True, text=True,
                              env={'PATH': os.environ.get('PATH', '')}, cwd=self.root).stdout.split()
        moved = subprocess.run([sys.executable, '-c', code, self.script], capture_output=True, text=True,
                               env={'PATH': os.environ.get('PATH', ''), 'SSL_CERT_FILE': bogus, 'SSL_CERT_DIR': self.root}, cwd=self.root).stdout.split()
        self.assertEqual(base[:2], ['True', 'True'])
        self.assertEqual(base, moved, 'SSL_CERT_FILE / SSL_CERT_DIR change nothing')


class AgentEnvironment(SenderCase):
    def test_a_dashboard_host_that_is_a_name_is_refused_before_any_call(self):
        for host in ('localhost', 'dash.example.test', '127.0.0.1.example.test'):
            with self.subTest(host=host):
                self.write_env('WEB_HOST=%s\n' % host)
                res = self.run_sender(MAIL_ARGS)
                self.assert_nothing_sent(res, 3)
                self.assertIn('dashboard_address', res.err)
                self.assertEqual((self.dash.requests, self.events), ([], []))

    def test_a_dashboard_host_that_is_an_ip_works(self):
        self.write_env('WEB_HOST=127.0.0.1\n')
        self.assertEqual(self.run_sender(MAIL_ARGS).rc, 0)
        self.write_env('WEB_HOST=0.0.0.0\n')   # unspecified = loopback
        self.assertEqual(self.run_sender(MAIL_ARGS).rc, 0)

    def test_without_the_agents_own_token_nothing_is_sent_or_asked(self):
        os.remove(os.path.join(self.root, '.agent-token'))
        self.write('store/.dashboard-token', 'shared-token-fixture')
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 3)
        self.assertIn('no_own_token', res.err)
        self.assertEqual((self.dash.requests, self.events), ([], []), 'the shared fallback is refused')
        os.remove(os.path.join(self.root, 'store/.dashboard-token'))
        res = self.run_sender(MAIL_ARGS)
        self.assert_nothing_sent(res, 3)
        self.assertEqual((self.dash.requests, self.events), ([], []))

    def test_the_dashboard_address_comes_from_the_env_file_not_the_environment(self):
        decoy = Dash(self.events)
        try:
            res = self.run_sender(MAIL_ARGS, extra_env={
                'DASHBOARD_BASE_URL': 'http://127.0.0.1:%d' % decoy.port, 'MARVEEN_DASHBOARD_BASE': 'http://127.0.0.1:%d' % decoy.port,
                'WEB_PORT': str(decoy.port), 'WEB_HOST': '127.0.0.1'})
            self.assertEqual(res.rc, 0, res.text)
            self.assertEqual(decoy.requests, [])
            self.assertEqual(len(self.claims()), 1)
        finally:
            decoy.stop()

    def test_proxy_variables_are_ignored_for_the_dashboard(self):
        decoy = Dash(self.events)
        proxy = 'http://127.0.0.1:%d' % decoy.port
        try:
            # neither the dashboard nor Google is reached through a proxy named in the environment
            res = self.run_sender(MAIL_ARGS, extra_env={
                'http_proxy': proxy, 'HTTP_PROXY': proxy, 'https_proxy': proxy, 'HTTPS_PROXY': proxy, 'all_proxy': proxy, 'ALL_PROXY': proxy})
            self.assertEqual(res.rc, 0, res.text)
            self.assertEqual(decoy.requests, [], 'a proxy is never used, for the approval service or for Google')
            self.assertEqual(len(self.claims()), 1)
        finally:
            decoy.stop()

    def test_no_option_or_variable_skips_the_claim(self):
        for extra in ({'GMAIL_SEND_DRY_RUN': '0'}, {'GMAIL_SEND_DRY_RUN': 'false'}, {'GMAIL_SEND_SKIP_CLAIM': '1'}, {'SKIP_APPROVAL': '1'},
                      {'GMAIL_SEND_DRY_RUN': ''}):
            with self.subTest(extra=extra):
                self.events.clear()
                self.dash.requests.clear()
                self.dash.claim = _conflict('none')
                res = self.run_sender(MAIL_ARGS, extra_env=extra)
                self.assert_nothing_sent(res, 3)
                self.assertEqual(len(self.claims()), 1)
        for flag in (['--dry-run'], ['--no-claim'], ['--skip-approval'], ['--force']):
            with self.subTest(flag=flag):
                self.dash.requests.clear()
                res = self.run_sender(MAIL_ARGS + flag)
                self.assert_nothing_sent(res, 2)
                self.assertEqual(self.dash.requests, [])


class Input(SenderCase):
    def test_html_is_an_unknown_option(self):
        self.write('work/page.html', '<p>Another page</p>')
        for extra in (['--html', 'work/page.html'], ['--html=work/page.html'], ['--htm', 'work/page.html'], ['--ht', 'work/page.html']):
            with self.subTest(extra=extra):
                res = self.run_sender(MAIL_ARGS + extra)
                self.assert_nothing_sent(res, 2)
                self.assertEqual((self.dash.requests, self.google.requests), ([], []))

    def test_unreadable_command_lines_send_nothing_and_ask_nothing(self):
        cases = [
            ('no subject', ['--to', 'ann@example.test', '--body', 'b']),
            ('no recipient', ['--subject', 's', '--body', 'b']),
            ('bad address', ['--to', 'not-an-address', '--subject', 's', '--body', 'b']),
            ('address with an extra @', ['--to', '"a@x.test" <ann@example.test>', '--subject', 's', '--body', 'b']),
            ('subject line break', ['--to', 'ann@example.test', '--subject', 's\nBcc: x@example.test', '--body', 'b']),
            ('empty body', ['--to', 'ann@example.test', '--subject', 's', '--body', '']),
            ('blank body', ['--to', 'ann@example.test', '--subject', 's', '--body', '  \n ']),
            ('both bodies', ['--to', 'ann@example.test', '--subject', 's', '--body', 'b', '--body-file', 'work/x']),
            ('missing body file', ['--to', 'ann@example.test', '--subject', 's', '--body-file', 'work/none.txt']),
            ('missing attachment', ['--to', 'ann@example.test', '--subject', 's', '--body', 'b', '--attach', 'work/none.bin']),
            ('positional', ['--to', 'ann@example.test', '--subject', 's', '--body', 'b', 'extra']),
            ('short option', ['-t', 'ann@example.test', '--subject', 's', '--body', 'b']),
            ('unknown option', ['--to', 'ann@example.test', '--subject', 's', '--body', 'b', '--priority', 'high']),
            ('from not an address', ['--to', 'ann@example.test', '--subject', 's', '--body', 'b', '--from', 'nope']),
            ('nothing', []),
        ]
        for label, args in cases:
            with self.subTest(label):
                res = self.run_sender(args)
                self.assert_nothing_sent(res, 2)
                self.assertEqual((self.dash.requests, self.google.requests), ([], []))

    def test_attachments_too_large_for_one_send_are_refused_before_an_approval(self):
        with open(os.path.join(self.root, 'work/big.bin'), 'wb') as fh:
            fh.truncate(19 * 1024 * 1024)
        res = self.run_sender(MAIL_ARGS + ['--attach', 'work/big.bin'])
        self.assert_nothing_sent(res, 2)
        self.assertEqual(self.dash.requests, [])


class HashParityWithTheGate(SenderCase):
    """The hash the sender claims is the hash the gate's reader computes for the same command line."""

    def assert_parity(self, args=None, command=None, stdin=None):
        want, _ = self.expected_hash(args, command)
        self.dash.requests.clear()
        res = self.run_sender(args if args is not None else self.args_of(command), stdin=stdin)
        self.assertEqual(res.rc, 0, res.text)
        self.assertEqual(self.claims()[0][2]['content_hash'], want)
        dry = self.run_sender(args if args is not None else self.args_of(command), stdin=stdin, extra_env={'GMAIL_SEND_DRY_RUN': '1'})
        self.assertEqual(dry.out.strip(), 'DRY-OK hash=' + want[:12])

    @staticmethod
    def args_of(command):
        words = shlex.split(command.split('<<', 1)[0])
        return words[2:]

    def test_plain_command_lines(self):
        self.write('work/body.txt', 'File body.\n')
        self.write_bytes('work/a.bin', b'\x00\x01\x02')
        self.write('work/b.txt', 'bee\n')
        cases = [
            MAIL_ARGS,
            ['--to', 'b@example.test', '--to', 'A@Example.TEST', '--to', 'a@example.test', '--cc', 'c@example.test', '--bcc', 'd@example.test',
             '--subject', 'S', '--body-file', 'work/body.txt', '--attach', 'work/b.txt', '--attach', 'work/a.bin',
             '--from', 'me@example.test', '--reply-to', 'r@example.test', '--in-reply-to', '<m@example.test>'],
            ['--to', 'a@example.test', '--subject', 'S', '--body', 'b', '--attach', os.path.join(self.root, 'work/a.bin')],
            ['--to', 'ann@example.test', '--subject', 'Árvíztűrő tükörfúrógép', '--body', 'Szia!\nÉkezetes törzs: őűáéíóúö.'],
            ['--to=ann@example.test', '--subject=Eq form', '--body=Eq body'],
            ['--to', 'ann@example.test,bob@example.test', '--subject', 'Comma list', '--body', 'b'],
        ]
        for args in cases:
            with self.subTest(args=args):
                self.assert_parity(args)

    def test_heredoc_body(self):
        command = "python3 scripts/gmail-send.py --to ann@example.test --subject 'Hi there' <<'EOF'\nHello there.\nSecond line.\nEOF"
        self.assert_parity(command=command, stdin='Hello there.\nSecond line.\n')

    def test_a_different_mail_has_a_different_hash(self):
        seen = set()
        for subject in ('Weekly notes', 'Weekly note'):
            for body in (BODY, BODY + ' '):
                self.dash.requests.clear()
                self.run_sender(['--to', 'ann@example.test', '--subject', subject, '--body', body])
                seen.add(self.claims()[0][2]['content_hash'])
        self.assertEqual(len(seen), 4)


if __name__ == '__main__':
    unittest.main(verbosity=1)
