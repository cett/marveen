#!/usr/bin/env python3
"""Tests for scripts/hooks/email-approval-gate.py (the PreToolUse gate on the main agent's outgoing mail).

The gate runs as a subprocess inside a throw-away install tree (its own .env, token, store and copies of
the scripts it loads), talking to a stub dashboard on a loopback port. Every refusal is checked for
exit 2 AND for its reason; every allow for the claim the stub saw. Fixture data only (example.test).

  1. Which calls are sends / which are not (the dashboard is not called for the latter).
  2. The decision table: level, enforcement flag, unreadable mail, claim answers, request opening.
  3. Fail closed: a service that is down, slow, wrong, or a part that does not load.
  4. What the agent's environment cannot do: move the base URL, switch the gate off.
  5. The log and the matcher.

Run: python3 <thisfile>   (EMAIL_GATE_PATH names a gate file that is not installed yet)
"""
import hashlib
import hmac
import importlib.machinery
import importlib.util
import json
import os
import re
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
REPO = os.path.dirname(SCRIPTS)
GATE_SRC = os.environ.get('EMAIL_GATE_PATH') or os.path.join(SCRIPTS, 'hooks', 'email-approval-gate.py')
sys.path.insert(0, os.path.join(SCRIPTS, 'lib'))
import email_extract as E  # noqa: E402

TOKEN = 'tok-main-0123456789abcdef'
MAIN = 'agent-a'
CLAIM_KEY = 'a1' * 32          # the dashboard's claim signing key, as the file holds it (64 hex characters)
OTHER_KEY = 'b2' * 32          # a key some other listener made up
CONSUMED_AT = 1760000000


def sign_claim(key_hex, content_hash, category, agent_id, ref, consumed_at):
    """What the dashboard signs: HMAC-SHA256 of v1|hash|category|agent|ref|consumed_at, the key being the bytes of the hex."""
    text = 'v1|%s|%s|%s|%s|%s' % (content_hash, category, agent_id, ref if ref is not None else '', consumed_at)
    return hmac.new(bytes.fromhex(key_hex), text.encode('utf-8'), hashlib.sha256).hexdigest()

# One neutral mail. The copy gate lets plain English through.
MAIL = {'to': ['ann@example.test'], 'subject': 'Weekly notes', 'body': 'Here are the notes from this week.'}
SEND_TOOL = 'mcp__gmail__gmail_send_email'


def _autonomy(level=2, cap=2, enforce=True):
    return 200, {'updated_at': 1, 'categories': [
        {'key': 'email_send', 'label': 'x', 'level': level, 'locked': False, 'maxLevel': cap, 'timeoutMinutes': 60, 'humanOnly': True},
        {'key': 'other', 'label': 'y', 'level': 3, 'locked': False, 'maxLevel': 3},
    ], 'approvalHumanOnlyEnforce': enforce}


def _claim_ok(aid='appr-1', sig_key=CLAIM_KEY, sig_fields=None, sig='auto', body_extra=None, **override):
    """What the real route answers: the approval row, naming the hash, the category, the agent and the use
    (the reference) of the request it answers, and the signature the dashboard puts on it. A function of the
    request, so a wrong field is a deliberate one. sig_key=None answers with no `sig` (a mirror that has no key),
    sig_fields overrides what is signed (not what is shown), sig='...' sends that value as it is."""
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
        body.update(body_extra or {})
        return 200, body
    return answer


def _conflict(reason, **extra):
    return 409, dict({'error': 'conflict', 'reason': reason, 'window_s': 1800, 'approval': None}, **extra)


class Dash:
    """A stub dashboard: scripted answers, a record of every request."""

    def __init__(self, bind='127.0.0.1', port=0):
        self.autonomy = _autonomy()
        self.claim = _claim_ok()
        self.create = (201, {'id': 'req-1', 'status': 'pending'})
        self.hang = set()      # paths that sleep past the gate's call timeout
        self.redirect = None   # a Location the claim answers with (302)
        self.requests = []
        dash = self

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
                dash.requests.append((self.command, self.path, parsed, dict(self.headers)))
                if self.path in dash.hang:
                    time.sleep(6)
                if dash.redirect and self.path == '/api/approvals/claim':
                    self.send_response(302)
                    self.send_header('Location', dash.redirect)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                answer = {('GET', '/api/autonomy'): dash.autonomy, ('POST', '/api/approvals/claim'): dash.claim,
                          ('POST', '/api/approvals'): dash.create}.get((self.command, self.path), (404, {'error': 'not_found'}))
                status, obj = answer(parsed) if callable(answer) else answer
                data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _do

        if ':' in bind:
            import socket

            class V6Server(ThreadingHTTPServer):
                address_family = socket.AF_INET6
            self.server = V6Server((bind, port), H)
        else:
            self.server = ThreadingHTTPServer((bind, port), H)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def paths(self):
        return [(m, p) for m, p, _, _ in self.requests]


class GateCase(unittest.TestCase):
    def setUp(self):
        self.dash = Dash()
        self.root = tempfile.mkdtemp(prefix='email-gate-')
        for rel in ('scripts/hooks', 'scripts/lib', 'store'):
            os.makedirs(os.path.join(self.root, rel))
        shutil.copy(GATE_SRC, os.path.join(self.root, 'scripts/hooks/email-approval-gate.py'))
        shutil.copy(os.path.join(SCRIPTS, 'hooks/outgoing-copy-gate.py'), os.path.join(self.root, 'scripts/hooks/'))
        shutil.copy(os.path.join(SCRIPTS, 'hooks/agent_token.py'), os.path.join(self.root, 'scripts/hooks/'))
        for name in ('email_extract.py', 'homoglyph.py', 'mixed_script.py'):
            shutil.copy(os.path.join(SCRIPTS, 'lib', name), os.path.join(self.root, 'scripts/lib/'))
        self.write('.env', 'WEB_PORT=%d\nMAIN_AGENT_ID=%s\n' % (self.dash.port, MAIN))
        self.write('.agent-token', TOKEN)
        self.write('store/.claim-signing-key', CLAIM_KEY)
        self.write('store/rules.json', json.dumps({'bad_name_patterns': ['ZZQQNAME'], 'correction': 'fix the name'}))
        self.log_path = os.path.join(self.root, 'store/email-approval-gate.log')

    def tearDown(self):
        self.dash.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, rel, text):
        with open(os.path.join(self.root, rel), 'w', encoding='utf-8') as fh:
            fh.write(text)

    def run_gate(self, tool, tool_input, extra_env=None, raw=None, cwd=None):
        payload = raw if raw is not None else json.dumps({'tool_name': tool, 'tool_input': tool_input, 'cwd': cwd or self.root})
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.root,
               'OUTGOING_COPY_GATE_RULES': os.path.join(self.root, 'store/rules.json')}
        env.update(extra_env or {})
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, os.path.join(self.root, 'scripts/hooks/email-approval-gate.py')],
                           input=payload.encode(), capture_output=True, env=env, timeout=30)
        self.elapsed = time.monotonic() - t0
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')

    def send(self, **kw):
        return self.run_gate(SEND_TOOL, dict(MAIL, **kw))

    def log_lines(self):
        try:
            with open(self.log_path, encoding='utf-8') as fh:
                return [json.loads(x) for x in fh if x.strip()]
        except OSError:
            return []

    def expect_deny(self, result, code, *needles):
        rc, out, err = result
        self.assertEqual(rc, 2, 'expected a block, got rc=%s stdout=%r stderr=%r' % (rc, out, err))
        self.assertEqual(out, '')
        for n in needles:
            self.assertIn(n, err)
        lines = self.log_lines()
        self.assertTrue(lines, 'a refusal leaves a log line')
        self.assertEqual(lines[-1]['verdict'], 'deny')
        self.assertEqual(lines[-1]['code'], code, lines[-1])

    def expected_hash(self, tool=SEND_TOOL, ti=None):
        built = E.envelope_of_call(tool, ti or MAIL, MAIN)
        self.assertTrue(built['ok'], built)
        return built['hash'], built['canon']


class Classification(GateCase):
    def test_not_a_send_passes_and_calls_nothing(self):
        cases = [
            ('Bash', {'command': 'ls -la'}),
            ('Bash', {'command': 'git diff scripts/lib/email_extract.py'}),
            ('Bash', {'command': 'curl -s http://localhost:3420/api/blackboard'}),
            ('mcp__gmail__gmail_draft', dict(MAIL)),
            ('mcp__gmail__gmail_search_emails', {'query': 'from:ann'}),
            ('mcp__claude_ai_Gmail__create_draft', dict(MAIL)),
            ('manage_email', {'action': 'search', 'query': 'x'}),
            ('manage_email', {'action': 'reply', 'draft': True, 'to': ['ann@example.test'], 'body': 'b'}),
            ('draft_email', dict(MAIL)),
        ]
        for tool, ti in cases:
            with self.subTest(tool=tool, ti=ti):
                rc, out, err = self.run_gate(tool, ti)
                self.assertEqual((rc, out), (0, ''), err)
        self.assertEqual(self.dash.requests, [])
        self.assertEqual(self.log_lines(), [])

    def test_send_tools_are_gated(self):
        self.dash.autonomy = _autonomy(level=1)
        for tool, ti in [
            (SEND_TOOL, dict(MAIL)),
            ('send_email', dict(MAIL)),
            ('manage_email', {'action': 'send', 'to': ['ann@example.test'], 'body': 'b'}),
            ('manage_email', {'to': ['ann@example.test'], 'body': 'b'}),   # no action: read as the dangerous one
            ('mcp__claude_ai_Gmail__send_message', dict(MAIL)),
            ('mcp__claude_ai_Gmail__reply_all', {'body': 'b'}),
            ('mcp__claude_ai_Gmail__forward', {'to': ['ann@example.test']}),
            ('mcp__gmail__gmail_send_draft', {'draftId': 'x'}),
        ]:
            with self.subTest(tool=tool):
                self.expect_deny(self.run_gate(tool, ti), 'level1')

    def test_bash_mail_commands_are_gated(self):
        self.dash.autonomy = _autonomy(level=1)
        self.write('store/mail.txt', 'To: ann@example.test\nSubject: Hi\n\nHello there.\n')
        for cmd in [
            "python3 scripts/support-mail/send.py --to ann@example.test --subject Hi --body 'Hello there'",
            'echo $(date) && python3 scripts/gmail-send.py --to ann@example.test',   # a substitution around a send
            'sendmail -t < %s/store/mail.txt' % self.root,
            'stdbuf -o0 python3 scripts/support-mail/send.py --to ann@example.test --subject Hi --body Hello',   # a wrapper neither classifier follows
        ]:
            with self.subTest(cmd=cmd):
                self.expect_deny(self.run_gate('Bash', {'command': cmd}), 'level1')


class GmailRestCurl(GateCase):
    """A curl to the Gmail or Resend send route is a send: it goes through the same approval as any mail tool."""
    GM = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
    UP = 'https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media'

    def setUp(self):
        super().setUp()
        import base64
        raw = base64.urlsafe_b64encode(b'To: ann@example.test\r\nSubject: Weekly notes\r\n\r\nHere are the notes from this week.\r\n').decode()
        self.write('store/r.json', json.dumps({'raw': raw}))
        self.write('store/m.eml', 'To: ann@example.test\r\nSubject: Weekly notes\r\n\r\nHere are the notes from this week.\r\n')
        self.cmds = [
            'curl -s -X POST %s -H "Authorization: Bearer $T" -d @store/r.json' % self.GM,
            'curl -s --url %s -d @store/r.json' % self.GM,
            "curl -s '%s' --data-binary @store/m.eml" % self.UP,
        ]

    def test_a_gmail_curl_without_an_approval_is_refused_and_a_request_is_opened(self):
        self.dash.claim = _conflict('none')
        for cmd in self.cmds:
            with self.subTest(cmd=cmd):
                self.dash.requests.clear()
                self.expect_deny(self.run_gate('Bash', {'command': cmd}), 'requested', 'req-1')
                self.assertIn(('POST', '/api/approvals'), self.dash.paths())

    def test_level_1_refuses_a_gmail_curl(self):
        self.dash.autonomy = _autonomy(level=1)
        for cmd in self.cmds:
            with self.subTest(cmd=cmd):
                self.expect_deny(self.run_gate('Bash', {'command': cmd}), 'level1')

    def test_a_gmail_curl_with_an_approval_and_a_readable_body_is_allowed(self):
        for cmd in self.cmds:
            with self.subTest(cmd=cmd):
                self.dash.requests.clear()
                built = E.envelope_of_call('Bash', {'command': cmd}, MAIN, self.root)
                self.assertTrue(built['ok'], built)
                rc, out, err = self.run_gate('Bash', {'command': cmd})
                self.assertEqual(rc, 0, err)
                claim = [r for r in self.dash.requests if r[1] == '/api/approvals/claim']
                self.assertEqual([c[2]['content_hash'] for c in claim], [built['hash']])

    def test_a_gmail_curl_whose_url_or_body_cannot_be_read_is_refused_and_spends_nothing(self):
        for cmd in ('curl -s "https://gmail.googleapis.com/$P" -d @store/r.json', 'curl -s %s -d "$BODY"' % self.GM,
                    'U=%s; curl -s $U -d @store/r.json' % self.GM, 'env -u cat timeout 5 curl -s %s -d @store/r.json' % self.GM):
            with self.subTest(cmd=cmd):
                self.dash.requests.clear()
                self.expect_deny(self.run_gate('Bash', {'command': cmd}), 'unreadable')
                self.assertNotIn(('POST', '/api/approvals/claim'), self.dash.paths())

    def test_a_curl_to_a_host_that_is_not_a_mail_api_is_not_gated(self):
        rc, out, err = self.run_gate('Bash', {'command': 'curl -s http://127.0.0.1:%d/api/blackboard' % self.dash.port})
        self.assertEqual((rc, out), (0, ''), err)
        self.assertEqual(self.log_lines(), [])


class DecisionTable(GateCase):
    def test_level_1_is_a_hard_refusal(self):
        self.dash.autonomy = _autonomy(level=1)
        self.expect_deny(self.send(), 'level1', 'KEMENYEN')
        self.assertEqual(self.dash.paths(), [('GET', '/api/autonomy')])

    def test_level_3_without_clamp_is_refused_with_clamp_it_is_2(self):
        self.dash.autonomy = _autonomy(level=3, cap=None)
        self.expect_deny(self.send(), 'level_high')
        self.dash.requests.clear()
        self.dash.autonomy = _autonomy(level=3, cap=2)
        self.dash.claim = _claim_ok()
        rc, out, err = self.send()
        self.assertEqual(rc, 0, err)
        self.assertIn(('POST', '/api/approvals/claim'), self.dash.paths())

    def test_level_not_decidable_is_refused(self):
        for label, answer in [
            ('no category', (200, {'categories': [{'key': 'other', 'level': 2, 'maxLevel': 2}], 'approvalHumanOnlyEnforce': True})),
            ('no categories', (200, {'approvalHumanOnlyEnforce': True})),
            ('level is text', (200, {'categories': [{'key': 'email_send', 'level': '2', 'maxLevel': 2}], 'approvalHumanOnlyEnforce': True})),
            ('level is bool', (200, {'categories': [{'key': 'email_send', 'level': True, 'maxLevel': 2}], 'approvalHumanOnlyEnforce': True})),
            ('level 0', _autonomy(level=0)),
            ('not json', (200, b'<html>')),
            ('500', (500, {'error': 'x'})),
            ('401', (401, {'error': 'unauthorized'})),
        ]:
            with self.subTest(label):
                self.dash.autonomy = answer
                self.dash.requests.clear()
                rc, out, err = self.send()
                self.assertEqual(rc, 2, err)
                self.assertEqual([p for _, p in self.dash.paths()], ['/api/autonomy'], 'nothing is spent when the level is unknown')

    def test_enforcement_off_or_missing_is_refused_before_any_claim(self):
        for enforce in (False, None):
            with self.subTest(enforce=enforce):
                self.dash.autonomy = _autonomy(enforce=enforce)
                if enforce is None:
                    del self.dash.autonomy[1]['approvalHumanOnlyEnforce']
                self.dash.requests.clear()
                self.expect_deny(self.send(), 'enforce_off', 'human-only')
                self.assertEqual([p for _, p in self.dash.paths()], ['/api/autonomy'])

    def test_claim_200_allows_and_spends_exactly_this_mail(self):
        want, _ = self.expected_hash()
        rc, out, err = self.send()
        self.assertEqual(rc, 0, err)
        msg = json.loads(out)['systemMessage']
        self.assertIn('appr-1', msg)
        self.assertIn(want[:12], msg)
        claims = [r for r in self.dash.requests if r[1] == '/api/approvals/claim']
        self.assertEqual(len(claims), 1)
        _, _, body, headers = claims[0]
        self.assertEqual(body['category'], 'email_send')
        self.assertEqual(body['content_hash'], want)
        self.assertEqual(body['consumer'], 'email-approval-gate')
        self.assertRegex(body['ref'], r'^[\x20-\x7e]{1,200}$')
        self.assertEqual(headers.get('Authorization'), 'Bearer ' + TOKEN)
        self.assertEqual(headers.get('X-Agent-Id'), MAIN)
        self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())
        line = self.log_lines()[-1]
        self.assertEqual((line['verdict'], line['code'], line['hash'], line['rcpt'], line['level']), ('allow', 'consumed', want[:12], 1, 2))

    def test_the_hash_follows_every_field_of_the_mail(self):
        seen = set()
        for ti in [dict(MAIL), dict(MAIL, subject='Weekly note'), dict(MAIL, body=MAIL['body'] + ' '),
                   dict(MAIL, to=['ann@example.test', 'bob@example.test']), dict(MAIL, cc=['bob@example.test']),
                   dict(MAIL, bcc=['bob@example.test'])]:
            self.dash.requests.clear()
            rc, out, err = self.run_gate(SEND_TOOL, ti)
            self.assertEqual(rc, 0, err)
            seen.add([r for r in self.dash.requests if r[1] == '/api/approvals/claim'][0][2]['content_hash'])
        self.assertEqual(len(seen), 6)

    def test_bash_send_py_end_to_end(self):
        cmd = "python3 scripts/support-mail/send.py --to ann@example.test --subject 'Weekly notes' --body 'Here are the notes from this week.'"
        built = E.envelope_of_call('Bash', {'command': cmd}, MAIN, self.root)
        self.assertTrue(built['ok'], built)
        rc, out, err = self.run_gate('Bash', {'command': cmd})
        self.assertEqual(rc, 0, err)
        claim = [r for r in self.dash.requests if r[1] == '/api/approvals/claim'][0][2]
        self.assertEqual(claim['content_hash'], built['hash'])

    def test_a_claim_answer_about_another_mail_agent_or_use_is_refused(self):
        # a listener that is not the dashboard can say 200 ok; it cannot know the hash and the reference
        for field, wrong in [('content_hash', 'f' * 64), ('category', 'other'), ('agent_id', 'someone-else'), ('status', 'pending'),
                             ('consumed_by', 'someone-else'), ('consumed_ref', 'gate-0'), ('consumed_ref', None), ('content_hash', None),
                             ('agent_id', None), ('category', None)]:
            with self.subTest(field=field, wrong=wrong):
                self.dash.requests.clear()
                self.dash.claim = _claim_ok(**{field: wrong})
                self.expect_deny(self.send(), 'claim_mismatch', field)
                self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())
        self.dash.claim = (200, {'ok': True, 'approval': {'id': 'x'}})   # a bare yes
        self.expect_deny(self.send(), 'claim_mismatch')

    def test_pending_names_the_request_and_opens_no_second_one(self):
        self.dash.claim = _conflict('pending', approval_id='req-9')
        self.expect_deny(self.send(), 'pending', 'req-9', 'Ne kerj ujat')
        self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_no_usable_approval_opens_a_request_and_refuses(self):
        want, canon = self.expected_hash()
        for reason in ('none', 'expired', 'already_consumed', 'rejected', 'not_human_decided'):
            with self.subTest(reason=reason):
                self.dash.requests.clear()
                self.dash.claim = _conflict(reason)
                self.expect_deny(self.send(), 'requested', 'req-1', want[:12], 'ann@example.test', 'Weekly notes', 'PONTOSAN ugyanezt')
                opened = [r for r in self.dash.requests if r[:2] == ('POST', '/api/approvals')]
                self.assertEqual(len(opened), 1)
                body = opened[0][2]
                self.assertEqual((body['agent_id'], body['category'], body['content_hash'], body['action_payload']), (MAIN, 'email_send', want, canon))
                self.assertNotIn('action_description', body, 'the requester does not describe its own mail')
                self.assertEqual(self.log_lines()[-1]['reason'], reason)

    def test_an_already_open_request_is_reported_as_such(self):
        self.dash.claim = _conflict('none')
        self.dash.create = (200, {'id': 'req-2', 'status': 'pending', 'deduplicated': True})
        self.expect_deny(self.send(), 'requested', 'req-2', 'mar nyitva volt')

    def test_unknown_claim_reason_refuses_without_a_request(self):
        for reason in ('wrong_category', 'hash_mismatch', 'surprise', ''):
            with self.subTest(reason=reason):
                self.dash.requests.clear()
                self.dash.claim = _conflict(reason)
                self.expect_deny(self.send(), 'claim_unexpected')
                self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_claim_failures_refuse_and_open_nothing(self):
        for label, answer in [('401', (401, {'error': 'unauthorized'})), ('403', (403, {'error': 'forbidden', 'reason': 'agent_identity_required'})),
                              ('404', (404, {'error': 'not_found'})), ('500', (500, {'error': 'x'})), ('503', (503, {})),
                              ('not json', (200, b'ok')), ('200 without ok', (200, {'approval': {'id': 'a'}})),
                              ('200 ok false', (200, {'ok': False, 'approval': {'id': 'a'}})), ('200 null', (200, b'null')),
                              ('409 without reason', (409, {'error': 'conflict'})), ('409 not json', (409, b'x')),
                              ('302', (302, {}))]:
            with self.subTest(label):
                self.dash.requests.clear()
                self.dash.claim = answer
                rc, out, err = self.send()
                self.assertEqual((rc, out), (2, ''), err)
                self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_request_opening_failures_refuse(self):
        self.dash.claim = _conflict('none')
        for label, answer in [('400', (400, {'error': 'invalid_value', 'hint': 'bad envelope'})), ('403', (403, {'error': 'forbidden'})),
                              ('409 too many', (409, {'error': 'conflict', 'reason': 'too_many_pending'})), ('500', (500, {})),
                              ('201 without id', (201, {'status': 'pending'})), ('not json', (201, b'x'))]:
            with self.subTest(label):
                self.dash.create = answer
                self.expect_deny(self.send(), 'request_failed')

    def test_unreadable_mail_is_refused_with_the_way_out_and_spends_nothing(self):
        for label, ti in [('unknown field', dict(MAIL, mystery='x')), ('no recipient', {'subject': 's', 'body': 'b'}),
                          ('hidden address in a name', dict(MAIL, to=['"a@x.test,b@y.test" <c@z.test>']))]:
            with self.subTest(label):
                self.dash.requests.clear()
                self.expect_deny(self.run_gate(SEND_TOOL, ti), 'unreadable', 'LITERAL')
                self.assertEqual([p for _, p in self.dash.paths()], ['/api/autonomy'])
                self.assertTrue(self.log_lines()[-1]['unreadable'])

    def test_a_mail_with_an_html_part_is_refused_and_spends_nothing(self):
        # the owner reads the text and the fingerprint, the recipient reads the HTML
        self.write('store/m.eml', 'To: ann@example.test\nSubject: Hi\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary=B\n\n'
                   '--B\nContent-Type: text/plain; charset=utf-8\n\nHarmless text.\n--B\nContent-Type: text/html; charset=utf-8\n\n<p>Another page</p>\n--B--\n')
        cases = [
            (SEND_TOOL, dict(MAIL, html='<p>Another page</p>')),
            (SEND_TOOL, dict(MAIL, htmlBody='<p>Another page</p>')),
            ('Bash', {'command': "python3 scripts/support-mail/send.py --to ann@example.test --subject Hi --body 'Another page' --html"}),
            ('Bash', {'command': 'sendmail -t < %s/store/m.eml' % self.root}),
        ]
        for tool, ti in cases:
            with self.subTest(tool=tool, ti=ti):
                self.dash.requests.clear()
                self.expect_deny(self.run_gate(tool, ti), 'html_part', 'HTML resz nem ellenorizheto')
                self.assertEqual([p for _, p in self.dash.paths()], ['/api/autonomy'], 'no claim, no request')

    def test_empty_body_is_refused(self):
        rc, out, err = self.send(body='')
        self.assertEqual(rc, 2)
        self.assertNotIn(('POST', '/api/approvals/claim'), self.dash.paths())

    def test_the_refusal_names_what_the_owner_will_judge(self):
        self.dash.claim = _conflict('none')
        long_body = ('Line one.\n' + 'x' * 400)
        rc, out, err = self.send(subject='Re: weekly\u2028notes', body=long_body, cc=['bob@example.test'])
        self.assertEqual(rc, 2)
        self.assertIn('cc: bob@example.test', err)
        self.assertIn('torzs eleje: Line one. xxx', err)
        self.assertNotIn('x' * 130, err, 'the body is shown as its first 120 characters')
        self.assertNotIn('\u2028', err)
        for secret in (TOKEN, '.agent-token', 'dashboard-token', '/api/approvals/claim'):
            self.assertNotIn(secret, err, 'the text does not help a bypass')


class ClaimSignature(GateCase):
    """The claim answer must be signed with the key the dashboard keeps in store/.claim-signing-key."""

    def _refused(self, claim=None, code='claim_unsigned'):
        if claim is not None:
            self.dash.claim = claim
        self.dash.requests.clear()
        self.expect_deny(self.send(), code)
        # a refused answer is the end: no request is opened for the owner, nothing is retried
        self.assertEqual(self.dash.paths().count(('POST', '/api/approvals/claim')), 1)
        self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_a_signed_answer_is_allowed(self):
        rc, out, err = self.send()
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.log_lines()[-1]['code'], 'consumed')

    def test_a_mirror_without_the_key_is_refused(self):
        # it reads the request and echoes hash, category, agent and reference back: every echo check passes
        self._refused(_claim_ok(sig_key=None))
        self._refused(_claim_ok(sig_key=OTHER_KEY))
        for forged in ('', 'f' * 64, '0' * 64, 'x', None, 12, ['a'], {'a': 1}, True):
            with self.subTest(sig=forged):
                self._refused(_claim_ok(sig=forged))

    def test_a_signature_over_another_value_is_refused(self):
        # the signature is good for a claim, but not for THIS one: each signed field matters
        for field, other in [('content_hash', 'f' * 64), ('category', 'other'), ('agent_id', 'someone-else'),
                             ('consumed_ref', 'gate-0'), ('consumed_ref', None), ('consumed_at', CONSUMED_AT + 1)]:
            with self.subTest(field=field):
                self._refused(_claim_ok(sig_fields={field: other}))

    def test_the_signature_must_be_exactly_the_lowercase_hex_digest(self):
        self._refused(_claim_ok(sig_key=None, sig='AB' * 32))

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
                # signed with the value the answer shows, so only the consumed_at check can refuse it
                self._refused(_claim_ok(consumed_at=bad, sig_fields={'consumed_at': bad}))

    def test_no_usable_key_file_is_a_refusal(self):
        for label, content in [('missing', None), ('empty', ''), ('short', 'ab' * 16), ('not hex', 'zz' * 32), ('upper case', 'AB' * 32),
                               ('trailing junk', CLAIM_KEY + 'ab'), ('binary', '\x00\x01')]:
            with self.subTest(key=label):
                path = os.path.join(self.root, 'store/.claim-signing-key')
                if os.path.isdir(path):
                    os.rmdir(path)
                elif os.path.exists(path):
                    os.remove(path)
                if content is not None:
                    self.write('store/.claim-signing-key', content)
                self._refused(_claim_ok())
        path = os.path.join(self.root, 'store/.claim-signing-key')
        if os.path.exists(path):
            os.remove(path)
        os.mkdir(path)      # a directory where the key should be
        self._refused(_claim_ok())

    def test_a_stub_that_signs_with_a_key_the_gate_does_not_have_is_refused(self):
        # the key file holds a different key than the answer was signed with
        self.write('store/.claim-signing-key', OTHER_KEY)
        self._refused(_claim_ok())

    def test_the_key_comes_from_the_gates_own_install_not_from_the_environment(self):
        other = tempfile.mkdtemp(prefix='email-gate-key-')
        try:
            with open(os.path.join(other, 'key'), 'w') as fh:
                fh.write(OTHER_KEY)
            self.write('store/.claim-signing-key', CLAIM_KEY)
            self.dash.claim = _claim_ok(sig_key=OTHER_KEY)
            for name in ('CLAIM_SIGNING_KEY', 'CLAIM_SIGNING_KEY_FILE', 'MARVEEN_STORE_DIR', 'STORE_DIR'):
                self.dash.requests.clear()
                rc, out, err = self.run_gate(SEND_TOOL, dict(MAIL), extra_env={name: OTHER_KEY if 'FILE' not in name and 'DIR' not in name else other})
                self.assertEqual(rc, 2, name)
                self.assertEqual(self.log_lines()[-1]['code'], 'claim_unsigned', name)
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_the_refusal_never_prints_the_key_or_the_signature(self):
        self.dash.claim = _claim_ok(sig_key=OTHER_KEY)
        rc, out, err = self.send()
        self.assertEqual(rc, 2)
        for secret in (CLAIM_KEY, OTHER_KEY, sign_claim(OTHER_KEY, 'x', 'y', 'z', 'r', CONSUMED_AT)):
            self.assertNotIn(secret, err)
        self.assertNotIn(CLAIM_KEY, json.dumps(self.log_lines()))


class CopyGateFirst(GateCase):
    def test_copy_gate_refusal_comes_first_and_nothing_is_asked(self):
        rc, out, err = self.send(body='Here are the notes \u2014 all of them.')
        self.assertEqual(rc, 2)
        self.assertIn('KIMENO-SZOVEG KAPU', err)
        self.assertEqual(self.dash.requests, [], 'no approval burns on a call the copy gate refuses')
        self.assertEqual(self.log_lines()[-1]['code'], 'copy_gate')

    def test_copy_gate_name_rule_applies(self):
        rc, out, err = self.send(body='Dear ZZQQNAME, here are the notes.')
        self.assertEqual(rc, 2)
        self.assertEqual(self.dash.requests, [])

    def test_copy_gate_covers_non_send_bash_too(self):
        # the gate replaces the copy gate's registration for these tools: its homoglyph check on an
        # inter-agent message still has to run
        cmd = ("curl -s -X POST http://localhost:3420/api/messages -H 'Content-Type: application/json' "
               "-d '{\"from\":\"a\",\"to\":\"b\",\"content\":\"p\u0430ssword\"}'")  # Cyrillic a
        rc, out, err = self.run_gate('Bash', {'command': cmd})
        self.assertEqual(rc, 2, err)
        self.assertEqual(self.dash.requests, [])


class FailClosed(GateCase):
    def test_dashboard_down(self):
        self.dash.stop()
        self.expect_deny(self.send(), 'autonomy_unavailable')
        self.dash = Dash()   # tearDown stops it

    def test_slow_autonomy_answer(self):
        self.dash.hang = {'/api/autonomy'}
        self.expect_deny(self.send(), 'autonomy_unavailable')
        self.assertLess(self.elapsed, 8.5)

    def test_slow_claim_answer_stays_inside_the_budget(self):
        self.dash.hang = {'/api/approvals/claim'}
        self.expect_deny(self.send(), 'claim_unavailable')
        self.assertLess(self.elapsed, 8.5)
        self.assertNotIn(('POST', '/api/approvals'), self.dash.paths())

    def test_garbage_and_missing_input(self):
        for label, raw in [('not json', 'not json'), ('empty', ''), ('list', '[1]'), ('no tool_input', '{"tool_name":"Bash"}'),
                           ('tool_input list', '{"tool_name":"Bash","tool_input":["x"]}'), ('tool_name number', '{"tool_name":5,"tool_input":{}}'),
                           ('Bash command not text', '{"tool_name":"Bash","tool_input":{"command":5}}')]:
            with self.subTest(label):
                rc, out, err = self.run_gate(None, None, raw=raw)
                self.assertEqual((rc, out), (2, ''), err)
        self.assertEqual(self.dash.requests, [])

    def test_a_part_that_does_not_load_is_a_refusal_naming_the_file(self):
        for rel, tool_input, tool in [
            ('scripts/hooks/outgoing-copy-gate.py', {'command': 'ls'}, 'Bash'),
            ('scripts/lib/email_extract.py', dict(MAIL), SEND_TOOL),
            ('scripts/hooks/agent_token.py', dict(MAIL), SEND_TOOL),
        ]:
            with self.subTest(rel=rel):
                path = os.path.join(self.root, rel)
                with open(path, encoding='utf-8') as fh:
                    original = fh.read()
                try:
                    with open(path, 'w', encoding='utf-8') as fh:
                        fh.write('this is not python (\n')
                    rc, out, err = self.run_gate(tool, tool_input)
                    self.assertEqual((rc, out), (2, ''), err)
                    self.assertIn(rel, err)
                    self.assertEqual(self.log_lines()[-1]['code'], 'load_error')
                finally:
                    with open(path, 'w', encoding='utf-8') as fh:
                        fh.write(original)

    def test_a_missing_part_is_a_refusal_too(self):
        os.remove(os.path.join(self.root, 'scripts/lib/email_extract.py'))
        rc, out, err = self.send()
        self.assertEqual(rc, 2)
        self.assertIn('scripts/lib/email_extract.py', err)
        # A Bash call cannot be told from a send without the reader, and no second list of mail programs
        # lives in the gate: it is refused too, naming the file.
        for cmd in ('ls', 'git status'):
            rc, out, err = self.run_gate('Bash', {'command': cmd})
            self.assertEqual(rc, 2, cmd)
            self.assertIn('scripts/lib/email_extract.py', err)
        # ... while a tool that is no mail tool does not need it
        self.assertEqual(self.run_gate('mcp__gmail__gmail_draft', dict(MAIL))[0], 0)

    def test_no_own_token_is_a_refusal_and_the_shared_token_does_not_stand_in(self):
        os.remove(os.path.join(self.root, '.agent-token'))
        self.expect_deny(self.send(), 'no_own_token')
        self.write('store/.dashboard-token', 'shared-token')
        self.expect_deny(self.send(), 'no_own_token')
        self.assertEqual(self.dash.requests, [])

    def test_no_main_agent_id_is_a_refusal(self):
        self.write('.env', 'WEB_PORT=%d\n' % self.dash.port)
        self.expect_deny(self.send(), 'no_own_token')

    def test_a_log_that_cannot_be_written_changes_no_verdict(self):
        os.makedirs(self.log_path)   # a directory where the file should be
        self.assertEqual(self.send()[0], 0)
        self.dash.autonomy = _autonomy(level=1)
        rc, out, err = self.send()
        self.assertEqual(rc, 2)
        self.assertIn('TILTVA', err)


class AgentEnvironmentCannotMoveTheGate(GateCase):
    def test_base_url_is_not_taken_from_the_environment(self):
        yes = Dash()
        try:
            self.dash.autonomy = _autonomy(level=1)
            rc, out, err = self.run_gate(SEND_TOOL, dict(MAIL), extra_env={
                'DASHBOARD_BASE_URL': 'http://localhost:%d' % yes.port, 'WEB_PORT': str(yes.port),
                'http_proxy': 'http://127.0.0.1:%d' % yes.port, 'HTTP_PROXY': 'http://127.0.0.1:%d' % yes.port})
            self.assertEqual(rc, 2, err)
            self.assertEqual(yes.requests, [], 'the lenient server never saw the gate')
            self.assertEqual(self.dash.paths(), [('GET', '/api/autonomy')])
        finally:
            yes.stop()

    def test_the_address_is_an_ip_not_the_name_localhost(self):
        # a listener on ::1 at the same port must never be asked (localhost can resolve there)
        import socket
        if not socket.has_ipv6:
            self.skipTest('no IPv6')
        yes = Dash(bind='::1', port=self.dash.port)
        try:
            self.assertEqual(self.send()[0], 0)
            self.assertEqual(yes.requests, [])
        except OSError:
            self.skipTest('::1 is not available')
        finally:
            yes.stop()
        mod = self._gate_module()
        for env_text, want in [('', '127.0.0.1'), ('WEB_HOST=0.0.0.0\n', '127.0.0.1'), ('WEB_HOST=127.0.0.1\n', '127.0.0.1'),
                               ('WEB_HOST=192.0.2.7\n', '192.0.2.7'), ('WEB_HOST=::1\n', '[::1]')]:
            with self.subTest(env_text):
                self.write('.env', 'WEB_PORT=%d\n%s' % (self.dash.port, env_text))
                mod.INSTALL = self.root
                self.assertEqual(mod.base_url(), 'http://%s:%d' % (want, self.dash.port))

    def test_a_dashboard_host_that_is_a_name_fails_closed(self):
        # the dashboard binds a name its own way; the gate does not guess which address that is
        for name in ('localhost', 'evil.example', '127.0.0.1.evil'):
            with self.subTest(name):
                self.write('.env', 'WEB_PORT=%d\nMAIN_AGENT_ID=%s\nWEB_HOST=%s\n' % (self.dash.port, MAIN, name))
                self.dash.requests.clear()
                self.expect_deny(self.send(), 'autonomy_unavailable', 'WEB_HOST')
                self.assertEqual(self.dash.requests, [])

    def _gate_module(self):
        loader = importlib.machinery.SourceFileLoader('email_gate_for_host', os.path.join(self.root, 'scripts/hooks/email-approval-gate.py'))
        spec = importlib.util.spec_from_loader('email_gate_for_host', loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        return mod

    def test_no_switch_relaxes_it(self):
        self.dash.autonomy = _autonomy(level=1)
        flags = {k: '1' for k in ('EMAIL_APPROVAL_GATE_DISABLE', 'EMAIL_APPROVAL_GATE_SHADOW', 'EMAIL_GATE_OFF', 'DISABLE_HOOKS',
                                  'APPROVAL_HUMAN_ONLY_ENFORCE', 'SHADOW', 'MARVEEN_AGENT_ID')}
        flags['MARVEEN_AGENT_ID'] = 'someone-else'
        self.expect_deny(self.run_gate(SEND_TOOL, dict(MAIL), extra_env=flags), 'level1')

    def test_redirects_are_not_followed(self):
        # a 3xx from the (local) server must not lead the gate to another server
        other = Dash()
        try:
            self.dash.redirect = 'http://127.0.0.1:%d/api/approvals/claim' % other.port
            self.expect_deny(self.send(), 'claim_unavailable')
            self.assertEqual(other.requests, [])
        finally:
            other.stop()


class LogAndMatcher(GateCase):
    def test_log_has_one_line_per_verdict_and_never_the_mail(self):
        self.send()                                   # allow
        self.dash.claim = _conflict('none')
        self.send(subject='Secret subject')           # deny (requested)
        self.dash.autonomy = _autonomy(level=1)
        self.send()                                   # deny (level1)
        with open(self.log_path, encoding='utf-8') as fh:
            raw = fh.read()
        lines = [json.loads(x) for x in raw.splitlines()]
        self.assertEqual([(l['verdict'], l['code']) for l in lines], [('allow', 'consumed'), ('deny', 'requested'), ('deny', 'level1')])
        for l in lines:
            self.assertEqual(l['tool'], SEND_TOOL)
            self.assertRegex(l['ts'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$')
            self.assertIsInstance(l['ms'], int)
        for private in ('Secret subject', 'ann@example.test', 'Here are the notes', TOKEN):
            self.assertNotIn(private, raw)

    def _module(self):
        loader = importlib.machinery.SourceFileLoader('email_gate_under_test', GATE_SRC)   # EMAIL_GATE_PATH may not end in .py
        spec = importlib.util.spec_from_loader('email_gate_under_test', loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        return mod

    def test_every_tool_the_classifier_calls_a_send_matches_the_matcher(self):
        mod = self._module()
        every_tool = mod.EMAIL_GATE_MATCHER == '*'
        rx = None if every_tool else re.compile(mod.EMAIL_GATE_MATCHER)
        names = [SEND_TOOL, 'send_email', 'mcp__x__send_email', 'manage_email', 'mcp__claude_ai_Gmail__send_message',
                 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__reply_all', 'mcp__claude_ai_Gmail__forward',
                 'mcp__gmail__gmail_send_draft', 'Bash']
        for n in names:
            with self.subTest(n):
                self.assertTrue(every_tool or rx.fullmatch(n), n)
        if not every_tool:
            for n in ('Read', 'Write', 'Edit', 'mcp__plugin_telegram_telegram__reply', 'mcp__github__create_issue'):
                self.assertFalse(rx.fullmatch(n), n)
        # the classifier on the tool names alone
        self.assertTrue(mod.tool_is_send('manage_email', {}))
        self.assertFalse(mod.tool_is_send('manage_email', {'action': 'list'}))
        self.assertFalse(mod.tool_is_send('mcp__gmail__gmail_draft', {}))
        self.assertFalse(mod.tool_is_send('mcp__plugin_telegram_telegram__reply', {}))

    def test_registered_matcher_equals_the_constant(self):
        mod = self._module()
        path = os.path.join(REPO, '.claude', 'settings.json')
        try:
            with open(path, encoding='utf-8') as fh:
                settings = json.load(fh)
        except (OSError, ValueError):
            self.skipTest('no tracked root settings.json')
        found = []
        for entry in (settings.get('hooks') or {}).get('PreToolUse', []):
            if any('email-approval-gate.py' in str(h.get('command', '')) for h in entry.get('hooks', [])):
                found.append(entry.get('matcher'))
        if not found:
            self.skipTest('the gate is not registered yet (K9)')
        self.assertEqual(found, [mod.EMAIL_GATE_MATCHER])


if __name__ == '__main__':
    unittest.main(verbosity=1)
