#!/usr/bin/env python3
"""The PostgreSQL install marker (store/.pg-installed, P-E) in the hook side.

  1. hook_pg_mode: the marker alone is PostgreSQL; the marker is read from the install root's store, never from the
     LEDGER_DB_PATH test override; an absent marker with no layer is SQLite; a stat that fails is doubt = PostgreSQL.
  2. gate_audit_lib: a rule drift (pg_mode() says SQLite while the marker is there) does not write the frozen SQLite file.
     The mutant that writes anyway is caught by the file check.
  3. tenant-context: on a drift the hook exits 2 and never reaches its SQLite connect (spy, with a no-marker control).
  4. tenant-skill-gate: on a drift the gate blocks and never reaches sqlite3.connect (spy, with a no-marker control).

Run: python3 scripts/__tests__/pg-marker-hooks.test.py  (neutral fixtures, throwaway install roots)
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# the hooks come from an isolated install root (a copy with an empty store): a real marker in this checkout's store must not
# change what these cells expect (pg_install_isolation.py, PR 959 test-only isolation)
from pg_install_isolation import isolated_hooks_dir  # noqa: E402
HOOKS = isolated_hooks_dir()
sys.path.insert(0, HOOKS)

import hook_pg_mode  # noqa: E402

FOR_ENV = ('MARVEEN_PG_URL', 'MARVEEN_PG_CONFIGURED', 'LEDGER_DB_PATH', 'SECRET_MOUNT_DIR', 'CLAUDECLAW_ENV_DIR',
           'MARVEEN_STORE_DIR')


def make_root():
    root = tempfile.mkdtemp(prefix='pg-marker-')
    os.makedirs(os.path.join(root, 'store'))
    secrets = os.path.join(root, 'no-secrets')
    os.environ['SECRET_MOUNT_DIR'] = secrets
    os.environ['CLAUDECLAW_ENV_DIR'] = root
    return root


def put_marker(root):
    with open(os.path.join(root, 'store', '.pg-installed'), 'w') as f:
        f.write('pg-installed 2026-11-28T00:00:00.000Z\n')


class Env(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in FOR_ENV}
        for k in FOR_ENV:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class TestPgModeMarker(Env):
    def test_marker_alone_is_postgresql(self):
        root = make_root()
        put_marker(root)
        self.assertTrue(hook_pg_mode.pg_mode(root))
        self.assertTrue(hook_pg_mode.store_marker_present(root))

    def test_no_marker_and_no_layer_is_sqlite(self):
        root = make_root()
        self.assertFalse(hook_pg_mode.pg_mode(root))
        self.assertFalse(hook_pg_mode.store_marker_present(root))

    def test_marker_is_read_from_the_install_store_not_from_the_test_override(self):
        root = make_root()
        put_marker(root)
        os.environ['LEDGER_DB_PATH'] = os.path.join(tempfile.mkdtemp(prefix='pg-marker-other-'), 'x.db')
        self.assertEqual(hook_pg_mode.store_marker_path(root), os.path.join(root, 'store', '.pg-installed'))
        self.assertTrue(hook_pg_mode.pg_mode(root))

    def test_a_marker_in_another_store_does_not_count(self):
        root = make_root()
        other = make_root()
        put_marker(other)
        self.assertFalse(hook_pg_mode.pg_mode(root))

    def test_a_stat_that_fails_for_another_reason_is_doubt_and_counts_as_postgresql(self):
        # a path whose parent is a regular file: stat fails with NotADirectoryError (not "absent")
        blocker = os.path.join(tempfile.mkdtemp(prefix='pg-marker-file-'), 'plain')
        with open(blocker, 'w') as f:
            f.write('x')
        self.assertTrue(hook_pg_mode._marker_present(os.path.join(blocker, 'store', '.pg-installed')))

    def test_the_result_is_a_boolean_and_no_marker_content_leaks(self):
        root = make_root()
        put_marker(root)
        self.assertIs(hook_pg_mode.pg_mode(root), True)


class TestGateAuditDriftDoesNotWrite(Env):
    """P-E, the gate audit (PR 959 finding 5). The drift cell plants a REAL marker in a throwaway store (MARVEEN_STORE_DIR,
    which the hooks read as the second place, decision 4); nothing is stubbed except the rule copy. Each mutant turns
    exactly one of these cells red: the marker check always False (the drift cell), the db_path-is-None condition dropped
    from the marker branch (the seam cell), the stderr-and-return-False branch removed (the drift cell)."""

    def test_a_drift_with_a_real_marker_writes_nothing(self):
        import contextlib
        import io
        import gate_audit_lib as gal
        env_store = make_root()
        put_marker(env_store)
        os.environ['MARVEEN_STORE_DIR'] = os.path.join(env_store, 'store')
        saved_pg, saved_write = gal._pg_mode, gal._write
        calls = []
        err = io.StringIO()
        try:
            gal._pg_mode = lambda: False                 # the copy of the rule says SQLite (the drift)
            gal._write = lambda *a, **k: calls.append(a)
            with contextlib.redirect_stderr(err):
                # a known gate name: an unknown one returns False before any write, which would make this cell vacuous
                result = gal.record('auth-admin-gate', 'allow', 'drift cell', 'agent-a', False)
        finally:
            gal._pg_mode, gal._write = saved_pg, saved_write
        self.assertIs(result, False)
        self.assertEqual(calls, [], 'the frozen SQLite file was written on a marked install')
        self.assertIn('store/.pg-installed', err.getvalue())

    def test_control_without_a_marker_the_sqlite_arm_writes(self):
        import gate_audit_lib as gal
        empty_store = make_root()                        # no marker in the environment store, none in the install store
        os.environ['MARVEEN_STORE_DIR'] = os.path.join(empty_store, 'store')
        self.assertFalse(gal._marker_refuses_sqlite(), 'precondition: the marker must really be absent')
        saved_pg, saved_write = gal._pg_mode, gal._write
        calls = []
        try:
            gal._pg_mode = lambda: False
            gal._write = lambda *a, **k: calls.append(a)
            result = gal.record('auth-admin-gate', 'allow', 'no marker cell', 'agent-a', False)
        finally:
            gal._pg_mode, gal._write = saved_pg, saved_write
        self.assertIs(result, True)
        self.assertEqual(len(calls), 1, 'the SQLite arm did not write without a marker')

    def test_an_explicit_db_path_is_the_test_seam_and_is_not_refused_by_the_marker(self):
        import gate_audit_lib as gal
        env_store = make_root()
        put_marker(env_store)
        os.environ['MARVEEN_STORE_DIR'] = os.path.join(env_store, 'store')
        db = os.path.join(make_root(), 'store', 'claudeclaw.db')
        saved_pg, saved_write = gal._pg_mode, gal._write
        calls = []
        try:
            gal._pg_mode = lambda: False
            gal._write = lambda *a, **k: calls.append(a)
            result = gal.record('auth-admin-gate', 'allow', 'seam cell', 'agent-a', False, db_path=db)
        finally:
            gal._pg_mode, gal._write = saved_pg, saved_write
        self.assertIs(result, True)
        self.assertEqual(len(calls), 1, 'an explicit db_path (the test seam) must not be refused by the marker')


class TestContextWatchdogMarkerDrift(Env):
    """P-E, nit 6: the context-watchdog on a rule drift (the rule says SQLite, the marker says PostgreSQL) exits 0 with its
    telemetry dropped and never reaches sqlite3.connect. The control (no marker) shows the connect IS reached."""

    def _run(self, pg_rule, marker_present):
        import contextlib
        import io
        import sqlite3
        wd = load_hook('context-watchdog')
        saved = (wd._known_agent_cwd, wd.latest_usage_event, hook_pg_mode.pg_mode,
                 hook_pg_mode.store_marker_present, sqlite3.connect, sys.stdin)
        calls = []

        def spy(*a, **k):
            calls.append(a)
            raise RuntimeError('spy: the SQLite file was reached')

        wd._known_agent_cwd = lambda cwd: 'agent-a'
        wd.latest_usage_event = lambda path: {'message': {'usage': {'input_tokens': 1}}}
        hook_pg_mode.pg_mode = lambda *a, **k: pg_rule
        hook_pg_mode.store_marker_present = lambda *a, **k: marker_present
        sqlite3.connect = spy
        sys.stdin = io.StringIO(json.dumps({'cwd': '/nonexistent/agent-a', 'session_id': 'session-a',
                                            'transcript_path': '/nonexistent/transcript.jsonl', 'tool_name': 'Bash'}))
        err = io.StringIO()
        code = None
        try:
            with contextlib.redirect_stderr(err):
                wd.main()
        except SystemExit as exc:
            code = exc.code
        finally:
            (wd._known_agent_cwd, wd.latest_usage_event, hook_pg_mode.pg_mode,
             hook_pg_mode.store_marker_present, sqlite3.connect, sys.stdin) = saved
        return code, calls, err.getvalue()

    def test_drift_exits_0_and_never_opens_the_sqlite_file(self):
        code, calls, err = self._run(pg_rule=False, marker_present=True)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [], 'the SQLite file was opened on a marked install')
        self.assertIn('.pg-installed', err)

    def test_control_without_a_marker_the_sqlite_arm_is_reached(self):
        _code, calls, _err = self._run(pg_rule=False, marker_present=False)
        self.assertGreaterEqual(len(calls), 1, 'the spy was not reached: the drift cell would be vacuous')


class TestStoreMarkerEitherPlace(Env):
    """P-E, decision 4: the hooks look for the store marker in <install>/store AND in $MARVEEN_STORE_DIR when it is set.
    The three cells: the marker only in the environment store, only in the install store, and neither."""

    def test_marker_only_in_the_environment_store_counts(self):
        root = make_root()           # install store: no marker
        env_root = make_root()
        put_marker(env_root)         # the marker lives in the store the variable names
        os.environ['MARVEEN_STORE_DIR'] = os.path.join(env_root, 'store')
        self.assertTrue(hook_pg_mode.store_marker_present(root))
        self.assertTrue(hook_pg_mode.pg_mode(root))

    def test_marker_only_in_the_install_store_counts_with_the_variable_set(self):
        root = make_root()
        put_marker(root)
        env_root = make_root()       # the variable names an empty store
        os.environ['MARVEEN_STORE_DIR'] = os.path.join(env_root, 'store')
        self.assertTrue(hook_pg_mode.store_marker_present(root))
        self.assertTrue(hook_pg_mode.pg_mode(root))

    def test_neither_place_has_the_marker_is_sqlite(self):
        root = make_root()
        env_root = make_root()
        os.environ['MARVEEN_STORE_DIR'] = os.path.join(env_root, 'store')
        self.assertFalse(hook_pg_mode.store_marker_present(root))
        self.assertFalse(hook_pg_mode.pg_mode(root))


def run_hook_main(mod, payload, pg_rule, marker_present, connect_owner, connect_name):
    """Run a hook's main() with the rule and the marker set by hand, and with the SQLite connect replaced by a spy that
    records every call and raises (so a SQLite arm that is reached is visible, and cannot write). Everything is restored.
    Returns (exit code, spy calls, stderr text)."""
    import contextlib
    import io
    saved = (hook_pg_mode.pg_mode, hook_pg_mode.store_marker_present, getattr(connect_owner, connect_name), sys.stdin)
    calls = []

    def spy(*a, **k):
        calls.append(a)
        raise RuntimeError('spy: the SQLite file was reached')

    hook_pg_mode.pg_mode = lambda *a, **k: pg_rule
    hook_pg_mode.store_marker_present = lambda *a, **k: marker_present
    setattr(connect_owner, connect_name, spy)
    sys.stdin = io.StringIO(json.dumps(payload))
    err = io.StringIO()
    code = None
    try:
        with contextlib.redirect_stderr(err):
            mod.main()
    except SystemExit as exc:
        code = exc.code
    finally:
        hook_pg_mode.pg_mode, hook_pg_mode.store_marker_present = saved[0], saved[1]
        setattr(connect_owner, connect_name, saved[2])
        sys.stdin = saved[3]
    return code, calls, err.getvalue()


def load_hook(name):
    """A hook file imported by path: its name has a hyphen, so a plain import does not work."""
    spec = importlib.util.spec_from_file_location(name.replace('-', '_') + '_under_test', os.path.join(HOOKS, name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestTenantContextMarkerDrift(Env):
    """P-E: tenant-context on a rule drift (the rule says SQLite, the marker says PostgreSQL) exits 2 without opening the
    SQLite file. The control cell shows the spy IS reached when there is no marker, so the drift cell is not vacuous."""

    PAYLOAD = {'cwd': '/nonexistent/agent-a', 'prompt': 'hello', 'session_id': 'session-a'}

    def test_drift_exits_2_and_never_opens_the_sqlite_file(self):
        import tenant_context_lib as tcl
        tc = load_hook('tenant-context')
        code, calls, err = run_hook_main(tc, self.PAYLOAD, pg_rule=False, marker_present=True,
                                         connect_owner=tcl, connect_name='connect')
        self.assertEqual(code, 2)
        self.assertEqual(calls, [], 'the SQLite file was opened on a marked install')
        self.assertIn('.pg-installed', err)

    def test_control_without_a_marker_the_sqlite_arm_is_reached(self):
        import tenant_context_lib as tcl
        tc = load_hook('tenant-context')
        code, calls, _err = run_hook_main(tc, self.PAYLOAD, pg_rule=False, marker_present=False,
                                          connect_owner=tcl, connect_name='connect')
        self.assertGreaterEqual(len(calls), 1, 'the spy was not reached: the drift cell would be vacuous')


class TestTenantSkillGateMarkerDrift(Env):
    """P-E: tenant-skill-gate on a rule drift blocks (exit 2) without opening the SQLite file (sqlite3.connect is the spy).
    The control cell shows the connect IS reached without a marker."""

    PAYLOAD = {'tool_name': 'Skill', 'tool_input': {'skill': 'agent-a-tenant-skill'}, 'cwd': '/nonexistent/agent-a',
               'session_id': 'session-a'}

    def test_drift_blocks_and_never_opens_the_sqlite_file(self):
        import sqlite3
        gate = load_hook('tenant-skill-gate')
        code, calls, err = run_hook_main(gate, self.PAYLOAD, pg_rule=False, marker_present=True,
                                         connect_owner=sqlite3, connect_name='connect')
        self.assertEqual(code, 2)
        self.assertEqual(calls, [], 'the SQLite file was opened on a marked install')
        self.assertIn('.pg-installed', err)

    def test_control_without_a_marker_the_sqlite_arm_is_reached(self):
        import sqlite3
        gate = load_hook('tenant-skill-gate')
        _code, calls, _err = run_hook_main(gate, self.PAYLOAD, pg_rule=False, marker_present=False,
                                           connect_owner=sqlite3, connect_name='connect')
        self.assertGreaterEqual(len(calls), 1, 'the spy was not reached: the drift cell would be vacuous')


if __name__ == '__main__':
    unittest.main(verbosity=1)
