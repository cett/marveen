#!/usr/bin/env python3
"""The PostgreSQL install marker (store/.pg-installed, P-E) in the hook side.

  1. hook_pg_mode: the marker alone is PostgreSQL; the marker is read from the install root's store, never from the
     LEDGER_DB_PATH test override; an absent marker with no layer is SQLite; a stat that fails is doubt = PostgreSQL.
  2. gate_audit_lib: a rule drift (pg_mode() says SQLite while the marker is there) does not write the frozen SQLite file.
     The mutant that writes anyway is caught by the file check.

Run: python3 scripts/__tests__/pg-marker-hooks.test.py  (neutral fixtures, throwaway install roots)
"""
import importlib.util
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), 'hooks')
sys.path.insert(0, HOOKS)

import hook_pg_mode  # noqa: E402

FOR_ENV = ('MARVEEN_PG_URL', 'MARVEEN_PG_CONFIGURED', 'LEDGER_DB_PATH', 'SECRET_MOUNT_DIR', 'CLAUDECLAW_ENV_DIR')


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
    def test_a_drift_does_not_write_the_frozen_sqlite_file(self):
        import gate_audit_lib as gal
        root = make_root()
        put_marker(root)
        db = os.path.join(root, 'store', 'claudeclaw.db')
        saved, saved_write, saved_marker = gal._pg_mode, gal._write, gal._marker_refuses_sqlite
        calls = []
        try:
            gal._pg_mode = lambda: False          # the copy of the rule says SQLite (the drift)
            gal._marker_refuses_sqlite = lambda: True   # the marker is in this install (the hook reads its own install root)
            gal._write = lambda *a, **k: calls.append(a)
            # a known gate name: an unknown one returns False before any write, which would make this cell vacuous
            result = gal.record('auth-admin-gate', 'allow', 'drift cell', 'agent-a', False)
        finally:
            gal._pg_mode = saved
            gal._write = saved_write
            gal._marker_refuses_sqlite = saved_marker
        self.assertIs(result, False)
        self.assertEqual(calls, [], 'the frozen SQLite file was written on a marked install')

    def test_without_a_marker_the_sqlite_arm_still_writes(self):
        import gate_audit_lib as gal
        root = make_root()
        db = os.path.join(root, 'store', 'claudeclaw.db')
        saved, saved_write = gal._pg_mode, gal._write
        calls = []
        try:
            gal._pg_mode = lambda: False
            gal._write = lambda *a, **k: calls.append(a)
            gal.record('auth-admin-gate', 'allow', 'no marker cell', 'agent-a', False, db_path=db)
        finally:
            gal._pg_mode = saved
            gal._write = saved_write
        # no marker: the SQLite arm is taken as before (the seam is the only writer here)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main(verbosity=1)
