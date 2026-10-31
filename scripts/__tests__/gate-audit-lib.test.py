#!/usr/bin/env python3
"""Tests for scripts/hooks/gate_audit_lib.py (OTel H5b): the decision counters and deny rows of the
PreToolUse gates, and the one rule that matters about them -- a failed or slow audit write NEVER changes a
gate's verdict.

  1. The library: what a row may carry, the fixed enums, upserts, every way the write can fail (no database,
     a directory, a corrupt file, a missing table, a lock held by someone else, a read-only file) and that
     none of them raises or takes long.
  2. audited(): the exit status of the wrapped main() comes out unchanged (0, 2, 1, None, a string, a
     return, an exception), even when the recording blows up with anything, an interrupt included.
  3. Each of the six gates, run as a real process in a throw-away install tree, on a deny and on an allow:
     the (exit status, stdout, stderr) is identical with the audit module absent (the gate as it was before
     H5b), with a healthy audit database, and with every broken audit database of (1). The healthy run also
     has to leave the count behind, or the comparison would prove nothing.
  4. Privacy: nothing of the event (command, path, recipient) reaches the database.

Neutral fixture data only (agent-a, tenant-a): no real names, ids or tokens.

Run: python3 <thisfile>
"""
import importlib.util
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.dirname(SCRIPTS)
HOOKS = os.path.join(SCRIPTS, 'hooks')
MIGRATIONS = os.path.join(REPO, 'src', 'migrations')

sys.path.insert(0, HOOKS)
_spec = importlib.util.spec_from_file_location('gate_audit_lib', os.path.join(HOOKS, 'gate_audit_lib.py'))
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)

SENTINEL_CMD = 'SENTINEL-COMMAND-should-never-be-stored'
SENTINEL_PATH = '/SENTINEL/path/should/never/be/stored'
SENTINEL_RECIPIENT = 'sentinel-recipient@example.invalid'


def sql(name):
    with open(os.path.join(MIGRATIONS, name), encoding='utf-8') as fh:
        return fh.read()


def make_audit_db(path, with_counts=True, with_hook_log=True):
    """The audit tables as the real migrations build them (0037, 0038, the tenant_id column of 0077, 0083)."""
    con = sqlite3.connect(path)
    if with_hook_log:
        con.executescript(sql('0037_hook_audit_log.sql'))
        con.executescript(sql('0038_hook_audit_trigger_source.sql'))
        con.execute('ALTER TABLE hook_audit_log ADD COLUMN tenant_id TEXT')
    if with_counts:
        con.executescript(sql('0083_gate_decision_counts.sql'))
    con.commit()
    con.close()


def rows(path, query, params=()):
    con = sqlite3.connect(path)
    try:
        return con.execute(query, params).fetchall()
    finally:
        con.close()


class LibCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='gate-audit-')
        self.db = os.path.join(self.dir, 'claudeclaw.db')
        make_audit_db(self.db)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    # --- what is written -------------------------------------------------------------------------------

    def test_input_too_large_is_a_known_reason_and_denyexit_carries_it(self):
        self.assertIn('input_too_large', lib.REASONS)
        self.assertTrue(lib.record('outgoing-copy-gate', 'deny', 'input_too_large', agent_id='agent-a', deny_row=True, db_path=self.db))
        self.assertEqual(rows(self.db, 'SELECT gate, decision, reason, count FROM gate_decision_counts'),
                         [('outgoing-copy-gate', 'deny', 'input_too_large', 1)])
        e = lib.DenyExit(2, 'input_too_large')
        self.assertIsInstance(e, SystemExit)
        self.assertEqual((e.code, e.reason), (2, 'input_too_large'))

    def test_audited_records_the_reason_of_a_denyexit_and_still_exits_2(self):
        from unittest import mock
        seen = []

        def rec(gate, decision, reason, **kw):
            seen.append((gate, decision, reason))
            return True

        def main():
            raise lib.DenyExit(2, 'input_too_large')

        def plain():
            sys.exit(2)

        with mock.patch.object(lib, 'record', rec), mock.patch.object(lib, '_trusted_agent_id', lambda: None):
            with self.assertRaises(SystemExit) as cm:
                lib.audited('g', main)
            self.assertEqual(cm.exception.code, 2)
            with self.assertRaises(SystemExit) as cm2:
                lib.audited('g', plain)
            self.assertEqual(cm2.exception.code, 2)
        self.assertEqual(seen, [('g', 'deny', 'input_too_large'), ('g', 'deny', 'denied')])

    def test_deny_writes_a_count_and_a_row_with_only_the_allowed_columns(self):
        self.assertTrue(lib.record('secret-read-gate', 'deny', 'denied', agent_id='agent-a', deny_row=True, db_path=self.db))
        self.assertEqual(rows(self.db, 'SELECT gate, decision, reason, count FROM gate_decision_counts'),
                         [('secret-read-gate', 'deny', 'denied', 1)])
        r = rows(self.db, 'SELECT agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id FROM hook_audit_log')
        self.assertEqual(r, [('agent-a', 'PreToolUse', 'deny', None, None, 'denied', None, 'secret-read-gate', None)])

    def test_counts_accumulate_per_gate_decision_and_reason(self):
        for _ in range(3):
            lib.record('destructive-gate', 'allow', '', db_path=self.db)
        lib.record('destructive-gate', 'deny', 'denied', db_path=self.db)
        lib.record('auth-admin-gate', 'allow', '', db_path=self.db)
        got = {(g, d, r): c for g, d, r, c in rows(self.db, 'SELECT gate, decision, reason, count FROM gate_decision_counts')}
        self.assertEqual(got, {('destructive-gate', 'allow', ''): 3, ('destructive-gate', 'deny', 'denied'): 1,
                               ('auth-admin-gate', 'allow', ''): 1})

    def test_first_at_stays_and_updated_at_moves(self):
        lib.record('destructive-gate', 'allow', '', db_path=self.db)
        con = sqlite3.connect(self.db)
        con.execute('UPDATE gate_decision_counts SET first_at = 100, updated_at = 100')
        con.commit()
        con.close()
        lib.record('destructive-gate', 'allow', '', db_path=self.db)
        (first, updated, count), = rows(self.db, 'SELECT first_at, updated_at, count FROM gate_decision_counts')
        self.assertEqual((first, count), (100, 2))
        self.assertGreater(updated, 100)

    def test_an_allow_and_a_gate_with_its_own_deny_rows_write_no_hook_audit_row(self):
        lib.record('email-approval-gate', 'allow', '', deny_row=True, db_path=self.db)
        lib.record('destructive-gate', 'deny', 'denied', deny_row=False, db_path=self.db)
        self.assertEqual(rows(self.db, 'SELECT COUNT(*) FROM hook_audit_log'), [(0,)])
        self.assertEqual(rows(self.db, 'SELECT COUNT(*) FROM gate_decision_counts'), [(2,)])

    def test_an_error_is_counted_but_never_gets_a_deny_row(self):
        lib.record('outgoing-copy-gate', 'error', 'gate_error', deny_row=True, db_path=self.db)
        self.assertEqual(rows(self.db, 'SELECT COUNT(*) FROM hook_audit_log'), [(0,)])
        self.assertEqual(rows(self.db, 'SELECT decision, reason FROM gate_decision_counts'), [('error', 'gate_error')])

    # --- the enums -------------------------------------------------------------------------------------

    def test_an_unknown_gate_or_decision_is_not_written(self):
        self.assertFalse(lib.record('some-other-hook', 'deny', 'denied', db_path=self.db))
        self.assertFalse(lib.record('destructive-gate', 'maybe', 'denied', db_path=self.db))
        self.assertEqual(rows(self.db, 'SELECT COUNT(*) FROM gate_decision_counts'), [(0,)])

    def test_a_reason_outside_the_enum_is_replaced_never_stored(self):
        lib.record('destructive-gate', 'deny', SENTINEL_CMD, deny_row=True, db_path=self.db)
        lib.record('destructive-gate', 'error', SENTINEL_PATH, db_path=self.db)
        lib.record('destructive-gate', 'allow', SENTINEL_RECIPIENT, db_path=self.db)
        dump = json.dumps(rows(self.db, 'SELECT * FROM gate_decision_counts') + rows(self.db, 'SELECT * FROM hook_audit_log'))
        for s in (SENTINEL_CMD, SENTINEL_PATH, SENTINEL_RECIPIENT):
            self.assertNotIn(s, dump)
        self.assertEqual(sorted(rows(self.db, 'SELECT decision, reason FROM gate_decision_counts')),
                         [('allow', ''), ('deny', 'denied'), ('error', 'exit_code')])

    def test_every_gate_name_in_the_library_is_one_the_tests_below_cover(self):
        self.assertEqual(set(lib.GATES), set(GATE_CASES))

    # --- every way the write can fail ------------------------------------------------------------------

    def assert_fails_quietly(self, path, seconds=2.5):
        t0 = time.monotonic()
        ok = lib.record('secret-read-gate', 'deny', 'denied', deny_row=True, db_path=path)
        self.assertFalse(ok)
        self.assertLess(time.monotonic() - t0, seconds)

    def test_no_database_file_is_not_created(self):
        path = os.path.join(self.dir, 'nope.db')
        self.assert_fails_quietly(path)
        self.assertFalse(os.path.exists(path))

    def test_a_directory(self):
        self.assert_fails_quietly(self.dir)

    def test_a_corrupt_file(self):
        path = os.path.join(self.dir, 'bad.db')
        with open(path, 'wb') as fh:
            fh.write(b'not a database' * 100)
        self.assert_fails_quietly(path)

    def test_a_database_without_the_tables(self):
        path = os.path.join(self.dir, 'empty.db')
        make_audit_db(path, with_counts=False, with_hook_log=False)
        self.assert_fails_quietly(path)

    def test_a_database_with_the_count_table_but_no_hook_audit_log_writes_nothing_for_a_deny_row(self):
        path = os.path.join(self.dir, 'half.db')
        make_audit_db(path, with_counts=True, with_hook_log=False)
        self.assert_fails_quietly(path)
        self.assertEqual(rows(path, 'SELECT COUNT(*) FROM gate_decision_counts'), [(0,)])  # one transaction: all or nothing

    def test_a_lock_held_by_someone_else_gives_up_within_the_busy_timeout(self):
        holder = sqlite3.connect(self.db, isolation_level=None)
        holder.execute('BEGIN EXCLUSIVE')
        try:
            self.assert_fails_quietly(self.db, seconds=2.0)
        finally:
            holder.execute('ROLLBACK')
            holder.close()

    def test_a_read_only_file(self):
        os.chmod(self.db, 0o444)
        try:
            self.assert_fails_quietly(self.db)
        finally:
            os.chmod(self.db, 0o644)

    def test_a_write_that_hangs_is_cut_off_by_the_budget(self):
        orig = lib._write
        lib._write = lambda *a, **k: time.sleep(10)
        try:
            t0 = time.monotonic()
            self.assertFalse(lib.record('secret-read-gate', 'deny', 'denied', db_path=self.db))
            self.assertLess(time.monotonic() - t0, 3.0)
        finally:
            lib._write = orig

    def test_the_gates_own_alarm_is_replaced_for_the_write_and_nothing_stays_armed(self):
        fired = []
        previous = signal.signal(signal.SIGALRM, lambda *a: fired.append(1))
        try:
            signal.alarm(1)
            lib.record('destructive-gate', 'allow', '', db_path=self.db)
            self.assertEqual(signal.alarm(0), 0)  # nothing left pending
            time.sleep(1.2)
            self.assertEqual(fired, [])  # the gate's handler is not called later either
        finally:
            signal.signal(signal.SIGALRM, previous)


class AuditedCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='gate-audit-')
        self.db = os.path.join(self.dir, 'claudeclaw.db')
        make_audit_db(self.db)
        self.env = os.environ.get('LEDGER_DB_PATH')
        os.environ['LEDGER_DB_PATH'] = self.db
        self.stdin = sys.stdin

    def tearDown(self):
        sys.stdin = self.stdin
        if self.env is None:
            os.environ.pop('LEDGER_DB_PATH', None)
        else:
            os.environ['LEDGER_DB_PATH'] = self.env
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_audited(self, main, **kw):
        """Returns ('exit', code) or ('raise', type) or ('return', None) exactly as audited() ended."""
        try:
            lib.audited('secret-read-gate', main, **kw)
        except SystemExit as exc:
            return ('exit', exc.code)
        except BaseException as exc:  # noqa: BLE001
            return ('raise', type(exc))
        return ('return', None)

    def counts(self):
        return {(g, d, r): c for g, d, r, c in rows(self.db, 'SELECT gate, decision, reason, count FROM gate_decision_counts')}

    def test_the_exit_status_comes_out_unchanged_and_is_classified(self):
        cases = [(0, ('allow', '')), (None, ('allow', '')), (2, ('deny', 'denied')), (1, ('error', 'exit_code')),
                 (3, ('error', 'exit_code')), ('a message', ('error', 'exit_code'))]
        for code, (decision, reason) in cases:
            def main(code=code):
                sys.exit(code)
            self.assertEqual(self.run_audited(main), ('exit', code))
            self.assertIn(('secret-read-gate', decision, reason), self.counts(), code)

    def test_a_main_that_returns_is_an_allow(self):
        self.assertEqual(self.run_audited(lambda: None), ('return', None))
        self.assertEqual(self.counts(), {('secret-read-gate', 'allow', ''): 1})

    def test_an_exception_of_the_gate_is_counted_and_raised_again_as_it_was(self):
        def main():
            raise KeyError('boom')
        self.assertEqual(self.run_audited(main), ('raise', KeyError))
        self.assertEqual(self.counts(), {('secret-read-gate', 'error', 'gate_error'): 1})

    def test_the_verdict_survives_a_recording_that_blows_up_with_anything(self):
        for boom in (RuntimeError('x'), OSError('x'), KeyboardInterrupt(), SystemExit(0), MemoryError(), sqlite3.OperationalError('x')):
            orig = lib._write

            def bad(*a, boom=boom, **k):
                raise boom
            lib._write = bad
            try:
                for code in (0, 2):
                    def main(code=code):
                        sys.exit(code)
                    self.assertEqual(self.run_audited(main), ('exit', code), repr(boom))
            finally:
                lib._write = orig

    def test_the_verdict_survives_a_broken_agent_lookup_and_a_broken_record(self):
        orig_agent, orig_record = lib._trusted_agent_id, lib.record
        lib._trusted_agent_id = lambda *a: (_ for _ in ()).throw(KeyboardInterrupt())
        try:
            def main():
                sys.exit(2)
            self.assertEqual(self.run_audited(main), ('exit', 2))
        finally:
            lib._trusted_agent_id = orig_agent
        lib.record = lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt())
        try:
            self.assertEqual(self.run_audited(main), ('exit', 2))
        finally:
            lib.record = orig_record

    def with_env(self, **env):
        """Set (value) or clear (None) environment variables for one test, restored by addCleanup."""
        for key, value in env.items():
            old = os.environ.get(key)
            self.addCleanup(lambda k=key, o=old: os.environ.pop(k, None) if o is None else os.environ.__setitem__(k, o))
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def deny_and_get_agent(self):
        def main():
            sys.exit(2)
        self.assertEqual(self.run_audited(main, deny_row=True), ('exit', 2))
        return rows(self.db, 'SELECT agent_id FROM hook_audit_log')[-1][0]

    def test_the_agent_comes_from_the_launchers_environment_and_nothing_of_the_event_is_kept(self):
        import io
        install = os.path.dirname(os.path.dirname(HOOKS))
        self.with_env(CLAUDE_CONFIG_DIR=os.path.join(install, 'agents', 'agent-a', '.claude-config'), CLAUDE_PROJECT_DIR=None)
        event = {'tool_name': 'Bash', 'cwd': os.path.join(install, 'agents', 'agent-b'),
                 'tool_input': {'command': SENTINEL_CMD, 'file_path': SENTINEL_PATH, 'to': SENTINEL_RECIPIENT}}
        sys.stdin = io.StringIO(json.dumps(event))
        self.assertEqual(self.deny_and_get_agent(), 'agent-a')  # NOT agent-b, whose directory the event's cwd names
        self.assertEqual(rows(self.db, 'SELECT trigger_source FROM hook_audit_log'), [('secret-read-gate',)])
        dump = json.dumps(rows(self.db, 'SELECT * FROM hook_audit_log') + rows(self.db, 'SELECT * FROM gate_decision_counts'))
        with open(self.db, 'rb') as fh:
            raw = fh.read()
        for s in (SENTINEL_CMD, SENTINEL_PATH, SENTINEL_RECIPIENT, 'agent-b'):
            self.assertNotIn(s, dump)
            self.assertNotIn(s.encode(), raw)

    def test_an_agent_cannot_have_its_denials_filed_under_another_by_changing_directory(self):
        import io
        install = os.path.dirname(os.path.dirname(HOOKS))
        self.with_env(CLAUDE_CONFIG_DIR=None, CLAUDE_PROJECT_DIR=os.path.join(install, 'agents', 'agent-a'))
        sys.stdin = io.StringIO(json.dumps({'cwd': os.path.join(install, 'agents', 'agent-b')}))
        self.assertEqual(self.deny_and_get_agent(), 'agent-a')

    def test_the_project_directory_alone_names_the_agent_and_the_install_itself_is_the_main_agent(self):
        install = os.path.dirname(os.path.dirname(HOOKS))
        self.with_env(CLAUDE_CONFIG_DIR=None, CLAUDE_PROJECT_DIR=os.path.join(install, 'agents', 'agent-c', 'sub', 'dir'))
        self.assertEqual(self.deny_and_get_agent(), 'agent-c')
        self.with_env(CLAUDE_PROJECT_DIR=install, MAIN_AGENT_ID='agent-main')
        self.assertEqual(self.deny_and_get_agent(), 'agent-main')

    def test_no_trusted_environment_means_no_agent_id_never_a_guess(self):
        install = os.path.dirname(os.path.dirname(HOOKS))
        self.with_env(CLAUDE_CONFIG_DIR=None, CLAUDE_PROJECT_DIR=None, MAIN_AGENT_ID='agent-main')
        self.assertIsNone(self.deny_and_get_agent())
        self.with_env(CLAUDE_CONFIG_DIR='/somewhere/else/.claude', CLAUDE_PROJECT_DIR='/some/scratch/dir')
        self.assertIsNone(self.deny_and_get_agent())
        # a path that only looks like the agents directory
        self.with_env(CLAUDE_PROJECT_DIR=os.path.join(install, 'agentsX', 'agent-a'))
        self.assertIsNone(self.deny_and_get_agent())
        self.with_env(CLAUDE_PROJECT_DIR=os.path.join(install, 'agents-evil', 'x'))
        self.assertIsNone(self.deny_and_get_agent())
        self.with_env(CLAUDE_PROJECT_DIR=os.path.join(install, 'agents'))
        self.assertIsNone(self.deny_and_get_agent())

    def test_stdin_is_left_alone(self):
        import io
        stream = io.StringIO('line one\nline two\n')
        sys.stdin = stream
        seen = []

        def main():
            seen.append(sys.stdin is stream)
            seen.append(sys.stdin.readline())
            seen.append(sys.stdin.read())
        self.run_audited(main)
        self.assertEqual(seen, [True, 'line one\n', 'line two\n'])
        self.assertIs(sys.stdin, stream)

    def test_a_gate_name_outside_the_list_just_runs_the_gate(self):
        def main():
            sys.exit(2)
        try:
            lib.audited('not-a-gate', main)
        except SystemExit as exc:
            self.assertEqual(exc.code, 2)
        self.assertEqual(self.counts(), {})


# --- the six gates as real processes ------------------------------------------------------------------

# gate file -> (deny_row, deny payload, allow payload); a payload is a dict (JSON-encoded) or a raw string.
# The deny of the gates with a heavy policy setup is the fail-closed refusal of an unreadable event, a real
# exit-2 path of the real gate; the gates with a cheap policy deny a real call.
GATE_CASES = {
    'destructive-gate': (False, {'tool_name': 'Read', 'tool_input': {'file_path': '/home/user-a/.ssh/id_rsa'}}, {'tool_name': 'Bash', 'tool_input': {'command': 'echo ok'}}),
    'secret-read-gate': (True, {'tool_name': 'Read', 'tool_input': {'file_path': '@ROOT@/store/.claim-signing-key'}}, {'tool_name': 'Read', 'tool_input': {'file_path': '@ROOT@/src/a.ts'}}),
    'email-approval-gate': (True, '{', {'tool_name': 'Bash', 'tool_input': {'command': 'echo ok'}}),
    'outgoing-copy-gate': (True, {'tool_name': 'Bash', 'tool_input': {'command': 'echo ' + 'x' * 400000}}, {'tool_name': 'Bash', 'tool_input': {'command': 'echo ok'}}),
    'auth-admin-gate': (False, {'tool_name': 'Bash', 'tool_input': {'command': 'npm run dashboard-user add user-b'}}, {'tool_name': 'Bash', 'tool_input': {'command': 'echo ok'}}),
    'tenant-skill-gate': (True, '{', {'tool_name': 'Bash', 'tool_input': {'command': 'echo ok'}}),
}


class GateProcessCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = os.path.realpath(tempfile.mkdtemp(prefix='gate-audit-install-'))
        os.makedirs(os.path.join(cls.root, 'scripts'))
        os.makedirs(os.path.join(cls.root, 'store'))
        os.makedirs(os.path.join(cls.root, 'src'))
        shutil.copytree(HOOKS, os.path.join(cls.root, 'scripts', 'hooks'), ignore=shutil.ignore_patterns('__pycache__', 'node_modules'))
        shutil.copytree(os.path.join(SCRIPTS, 'lib'), os.path.join(cls.root, 'scripts', 'lib'), ignore=shutil.ignore_patterns('__pycache__'))
        # The same install without the audit module: the gate exactly as it was before H5b.
        cls.bare = os.path.realpath(tempfile.mkdtemp(prefix='gate-audit-bare-'))
        shutil.copytree(cls.root, cls.bare, dirs_exist_ok=True)
        os.remove(os.path.join(cls.bare, 'scripts', 'hooks', 'gate_audit_lib.py'))
        for r in (cls.root, cls.bare):
            with open(os.path.join(r, 'store', '.claim-signing-key'), 'w') as fh:
                fh.write('a1' * 32)
            with open(os.path.join(r, 'src', 'a.ts'), 'w') as fh:
                fh.write('export const a = 1\n')
            with open(os.path.join(r, '.env'), 'w') as fh:
                fh.write('WEB_PORT=1\nMAIN_AGENT_ID=agent-main\n')  # a closed port: nothing is listening
        cls.work = tempfile.mkdtemp(prefix='gate-audit-db-')

    @classmethod
    def tearDownClass(cls):
        for d in (cls.root, cls.bare, cls.work):
            shutil.rmtree(d, ignore_errors=True)

    def payload(self, spec, root):
        if isinstance(spec, str):
            return spec
        return json.dumps(dict(spec, cwd=root)).replace('@ROOT@', root)

    def run_gate(self, gate, spec, db_path, root=None):
        root = root or self.root
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': root, 'LEDGER_DB_PATH': db_path,
               'AUTH_ADMIN_GATE_NO_AUDIT': '1', 'OUTGOING_COPY_GATE_RULES': os.path.join(root, 'store', 'rules.json')}
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, os.path.join(root, 'scripts', 'hooks', gate + '.py')],
                           input=self.payload(spec, root).encode(), capture_output=True, env=env, timeout=60)
        self.elapsed = time.monotonic() - t0
        norm = lambda b: b.decode('utf-8', 'replace').replace(self.root, '@ROOT@').replace(self.bare, '@ROOT@')
        return p.returncode, norm(p.stdout), norm(p.stderr)

    def db_variants(self):
        """name -> path (and a cleanup) of each audit database the gate may meet."""
        out = {}
        self.variant_n = getattr(self, 'variant_n', 0) + 1
        base = os.path.join(self.work, 'v%d' % self.variant_n)
        os.makedirs(base)
        healthy = os.path.join(base, 'healthy.db')
        make_audit_db(healthy)
        out['healthy'] = healthy
        notables = os.path.join(base, 'notables.db')
        make_audit_db(notables, with_counts=False, with_hook_log=False)
        out['no tables'] = notables
        out['missing'] = os.path.join(base, 'does-not-exist.db')
        out['directory'] = base
        corrupt = os.path.join(base, 'corrupt.db')
        with open(corrupt, 'wb') as fh:
            fh.write(b'garbage' * 200)
        out['corrupt'] = corrupt
        ro = os.path.join(base, 'readonly.db')
        make_audit_db(ro)
        os.chmod(ro, 0o444)
        out['read-only'] = ro
        return out

    def test_every_gate_decides_the_same_with_the_audit_absent_healthy_or_broken(self):
        self.assertEqual(set(GATE_CASES), set(lib.GATES))
        for gate, (deny_row, deny_spec, allow_spec) in GATE_CASES.items():
            for label, spec, want_rc in (('deny', deny_spec, 2), ('allow', allow_spec, 0)):
                baseline = self.run_gate(gate, spec, os.path.join(self.work, 'unused.db'), root=self.bare)
                self.assertEqual(baseline[0], want_rc, '%s %s baseline: %r' % (gate, label, baseline))
                for name, path in self.db_variants().items():
                    got = self.run_gate(gate, spec, path)
                    self.assertEqual(got, baseline, '%s %s with a %s audit database' % (gate, label, name))
                    self.assertLess(self.elapsed, 20, '%s %s %s' % (gate, label, name))
                    for suffix in ('', '-wal', '-shm'):
                        if os.path.isfile(path + suffix):
                            os.chmod(path + suffix, 0o644)

    def test_a_locked_audit_database_does_not_hold_a_gate_up_or_change_it(self):
        for gate, (deny_row, deny_spec, allow_spec) in GATE_CASES.items():
            for n, spec in enumerate((deny_spec, allow_spec)):
                baseline = self.run_gate(gate, spec, os.path.join(self.work, 'unused.db'), root=self.bare)
                path = os.path.join(self.work, 'locked-%s-%d.db' % (gate, n))
                make_audit_db(path)
                holder = sqlite3.connect(path, isolation_level=None)
                holder.execute('BEGIN EXCLUSIVE')
                try:
                    got = self.run_gate(gate, spec, path)
                finally:
                    holder.execute('ROLLBACK')
                    holder.close()
                self.assertEqual(got, baseline, gate)
                self.assertLess(self.elapsed, 20, gate)

    def test_a_gate_files_its_denial_under_the_agent_the_launcher_started_it_for(self):
        env_agent = {'CLAUDE_CONFIG_DIR': os.path.join(self.root, 'agents', 'agent-a', '.claude-config')}
        for gate, (deny_row, deny_spec, allow_spec) in GATE_CASES.items():
            if not deny_row:
                continue
            path = os.path.join(self.work, 'agent-%s.db' % gate)
            make_audit_db(path)
            payload = self.payload(deny_spec, self.root)
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': self.root, 'LEDGER_DB_PATH': path,
                   'AUTH_ADMIN_GATE_NO_AUDIT': '1', **env_agent}
            p = subprocess.run([sys.executable, os.path.join(self.root, 'scripts', 'hooks', gate + '.py')],
                               input=payload.encode(), capture_output=True, env=env, timeout=60)
            self.assertEqual(p.returncode, 2, gate)
            self.assertEqual(rows(path, 'SELECT agent_id FROM hook_audit_log'), [('agent-a',)], gate)

    def test_a_healthy_run_leaves_the_count_and_the_deny_row_behind(self):
        for gate, (deny_row, deny_spec, allow_spec) in GATE_CASES.items():
            path = os.path.join(self.work, 'count-%s.db' % gate)
            make_audit_db(path)
            self.assertEqual(self.run_gate(gate, deny_spec, path)[0], 2, gate)
            self.assertEqual(self.run_gate(gate, allow_spec, path)[0], 0, gate)
            self.assertEqual(self.run_gate(gate, allow_spec, path)[0], 0, gate)
            got = {(d, r): c for d, r, c in rows(path, 'SELECT decision, reason, count FROM gate_decision_counts WHERE gate = ?', (gate,))}
            self.assertEqual(got, {('deny', 'denied'): 1, ('allow', ''): 2}, gate)
            hook_rows = rows(path, 'SELECT hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source FROM hook_audit_log')
            if deny_row:
                self.assertEqual(hook_rows, [('PreToolUse', 'deny', None, None, 'denied', None, gate)], gate)
            else:
                self.assertEqual(hook_rows, [], gate)  # that gate posts its own deny row through the API
            with open(path, 'rb') as fh:
                raw = fh.read()
            for s in ('.ssh/id_rsa', 'dashboard-user', 'claim-signing-key', 'xxxxxxxx'):
                self.assertNotIn(s.encode(), raw, gate)


if __name__ == '__main__':
    unittest.main()
