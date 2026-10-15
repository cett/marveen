#!/usr/bin/env python3
"""Tests for the W3C traceparent the hooks send to the dashboard (OTel H6a): scripts/hooks/dashboard_api.py
traceparent()/request() and the tool-log-capture hook.

The contract with the TypeScript side (src/otel-exporter.ts toHexId): the exporter sends the spans written under
a session id with the trace id sha256(session id)[:32]. The hooks derive the very same id, so the dashboard's
http.server span of a slow or failed request lands in the trace of that session. FIXED_TRACE below is the value
src/__tests__/otel-http.test.ts pins from the TypeScript side for 'session-a'; if one side changes, both tests fail.

Neutral fixture data only.
"""
import importlib.util
import os
import re
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), 'hooks')
sys.path.insert(0, HOOKS)

_spec = importlib.util.spec_from_file_location('dashboard_api', os.path.join(HOOKS, 'dashboard_api.py'))
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)

FIXED_TRACE = 'fa57a52dbf08190218529730a3e99db6'  # sha256('session-a')[:32]
TRACEPARENT_RE = re.compile(r'^00-([0-9a-f]{32})-([0-9a-f]{16})-01$')


class TestTraceparent(unittest.TestCase):
    def test_the_trace_id_is_the_one_the_exporter_derives_for_the_session(self):
        m = TRACEPARENT_RE.match(api.traceparent('session-a'))
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), FIXED_TRACE)

    def test_the_span_id_is_new_each_time_and_never_all_zero(self):
        ids = {TRACEPARENT_RE.match(api.traceparent('session-a')).group(2) for _ in range(50)}
        self.assertGreater(len(ids), 40)
        self.assertNotIn('0' * 16, ids)

    def test_different_sessions_have_different_traces(self):
        a = TRACEPARENT_RE.match(api.traceparent('session-a')).group(1)
        b = TRACEPARENT_RE.match(api.traceparent('session-b')).group(1)
        self.assertNotEqual(a, b)

    def test_no_session_gives_no_header_and_nothing_raises(self):
        for bad in (None, '', 0):
            self.assertIsNone(api.traceparent(bad))
        for odd in (123, b'bytes', ['x'], object()):
            try:
                api.traceparent(odd)
            except Exception as exc:  # noqa: BLE001
                self.fail('raised %r for %r' % (exc, odd))

    def test_the_session_id_itself_is_not_in_the_header(self):
        self.assertNotIn('session-a', api.traceparent('session-a'))


class TestRequestHeader(unittest.TestCase):
    def run_request(self, **kw):
        captured = {}

        class Resp:
            def read(self):
                return b'null'

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            captured['headers'] = {k.lower(): v for k, v in req.header_items()}
            return Resp()

        with mock.patch.object(api, '_headers', return_value={'Authorization': 'Bearer test'}), \
                mock.patch.object(api, 'base_url', return_value='http://localhost:1'), \
                mock.patch.object(api.urllib.request, 'urlopen', fake_urlopen):
            api.request('GET', '/api/x', **kw)
        return captured['headers']

    def test_a_request_made_for_a_session_carries_the_traceparent(self):
        h = self.run_request(session_id='session-a')
        self.assertEqual(TRACEPARENT_RE.match(h['traceparent']).group(1), FIXED_TRACE)
        self.assertEqual(h['authorization'], 'Bearer test')

    def test_a_request_without_a_session_has_none(self):
        self.assertNotIn('traceparent', self.run_request())


class TestToolLogCapture(unittest.TestCase):
    def test_the_hook_derives_its_header_the_same_way(self):
        with open(os.path.join(HOOKS, 'tool-log-capture.py'), encoding='utf-8') as fh:
            src = fh.read()
        # same recipe as dashboard_api.traceparent: sha256 of the session id, first 32 hex, 16 random hex, flags 01
        self.assertIn("hashlib.sha256(session_id.encode()).hexdigest()[:32]", src)
        self.assertIn("os.urandom(8).hex()", src)
        self.assertIn("headers['traceparent']", src)


if __name__ == '__main__':
    unittest.main()
