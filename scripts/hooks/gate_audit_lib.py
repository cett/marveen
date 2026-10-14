"""gate_audit_lib.py -- decision counters and deny rows for the PreToolUse gates (OTel H5b).

A gate calls `audited('<gate-name>', main)` instead of `main()`. After main() has decided (it ends in
sys.exit(0) = allow, sys.exit(2) = deny), the wrapper records the outcome and exits with EXACTLY the status the
gate chose:

  * store/claudeclaw.db gate_decision_counts: one running count per (gate, decision, reason). Feeds the
    marveen.gate.decisions OTLP counter, so an allow rate exists at all.
  * hook_audit_log: one 'deny' row, only for a gate that does not post its own (deny_row=True).

THE GATE'S VERDICT IS NEVER AT STAKE HERE (the rules of the H5b review):
  1. The decision is made first. This code only runs once main() has raised SystemExit (or returned), and
     whatever happens in here, the original SystemExit is re-raised unchanged: same code, same stderr.
  2. Every failure is swallowed (a locked database, a missing table or file, a full disk, a bad path, a
     programming error here, even an interrupt during the write). The write opens the database with
     mode=rw (never creates one), waits at most BUSY_TIMEOUT_MS for a lock, and is cut off after
     WRITE_BUDGET_S, so a gate's total run time grows by a few milliseconds and by 1.2 s at the very worst.
  3. The gate imports this module inside try/except: a missing or broken file leaves the gate exactly as it
     was before (see the import stanza at the bottom of each gate).
  4. A row can carry only what is listed here: the gate name (from GATES), the decision (DECISIONS), a
     reason code (REASONS, a fixed enum, never free text) and the agent id derived from the event's cwd. No
     command, file path, recipient, tool input or output ever reaches this module's write: the module reads
     the event only to find `cwd`, and keeps nothing else.

A limit: a gate that ends the process with os._exit (auth-admin-gate's hard timeout) never returns here, so
that deny is not counted. Pure stdlib.
"""
import json
import os
import signal
import sqlite3
import sys
import time
from urllib.parse import quote

# Every gate that may record. A name outside this list is never written: `gate` becomes a column value.
GATES = frozenset({
    'destructive-gate', 'secret-read-gate', 'email-approval-gate', 'outgoing-copy-gate',
    'auth-admin-gate', 'tenant-skill-gate',
})
DECISIONS = frozenset({'allow', 'deny', 'error'})
# denied: the gate exited 2. gate_error: main() raised something the gate did not turn into a verdict (the
# process ends with a traceback and exit 1, which Claude Code does NOT treat as a block). exit_code: any other
# exit status.
REASONS = frozenset({'denied', 'gate_error', 'exit_code'})

BUSY_TIMEOUT_MS = 200
WRITE_BUDGET_S = 1
_CAPTURE_LIMIT = 1 << 20  # of the event, to find `cwd`; a larger event just has no agent id


class _WriteBudgetExceeded(Exception):
    pass


class _TeeStdin(object):
    """Reads like the real stdin and remembers what was read (up to _CAPTURE_LIMIT), so the wrapper can find
    the event's cwd without the gate having to hand it over. Every other attribute is the real stdin's."""

    def __init__(self, inner):
        self._inner = inner
        self._chunks = []
        self._size = 0

    def _keep(self, data):
        if isinstance(data, str) and self._size <= _CAPTURE_LIMIT:
            self._chunks.append(data)
            self._size += len(data)
        return data

    def read(self, *args):
        return self._keep(self._inner.read(*args))

    def readline(self, *args):
        return self._keep(self._inner.readline(*args))

    def captured(self):
        return ''.join(self._chunks) if self._size <= _CAPTURE_LIMIT else ''

    def __iter__(self):
        return iter(self._inner)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def _classify(code):
    """The exit status a gate chose -> (decision, reason)."""
    if code is None or code == 0:
        return 'allow', ''
    if code == 2:
        return 'deny', 'denied'
    return 'error', 'exit_code'


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _main_agent_id():
    """MAIN_AGENT_ID from the environment or the install's env file, or None. Silent (ledger_lib's resolver
    warns on stderr, which a gate's output must not gain) and without ledger_lib's import cost (urllib)."""
    value = os.environ.get('MAIN_AGENT_ID')
    if value:
        return value.strip() or None
    try:
        with open(os.path.join(_install_dir(), '.' + 'env')) as fh:
            for line in fh:
                if line.startswith('MAIN_AGENT_ID='):
                    return line.split('=', 1)[1].strip() or None
    except BaseException:  # noqa: BLE001
        pass
    return None


def _agent_id(captured):
    """The agent behind the event's cwd: <install>/agents/<id> is <id>, the install itself is the main agent,
    anything else (a scratch directory, a worktree) names no agent -> None. Never raises."""
    try:
        cwd = str(json.loads(captured).get('cwd') or '').rstrip('/')
        install = _install_dir().rstrip('/')
        agents_root = os.path.join(install, 'agents')
        if cwd.startswith(agents_root + os.sep):
            return cwd[len(agents_root) + 1:].split(os.sep)[0] or None
        if cwd == install or not cwd:
            return _main_agent_id()
        return None
    except BaseException:  # noqa: BLE001 -- see rule 2 in the module docstring
        return None


def _db_path():
    import hook_db_path
    return hook_db_path.db_path()


def _write(path, gate, decision, reason, agent_id, deny_row):
    now = int(time.time())
    con = sqlite3.connect('file:%s?mode=rw' % quote(path), uri=True, timeout=BUSY_TIMEOUT_MS / 1000.0)
    try:
        con.execute('PRAGMA busy_timeout=%d' % BUSY_TIMEOUT_MS)
        con.execute(
            'INSERT INTO gate_decision_counts (gate, decision, reason, count, first_at, updated_at) '
            'VALUES (?, ?, ?, 1, ?, ?) '
            'ON CONFLICT(gate, decision, reason) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at',
            (gate, decision, reason, now, now))
        if deny_row and decision == 'deny':
            # No tool_name / content_hash / session_id on purpose: the row names the gate, the verdict, a
            # reason code and the agent. (tenant_id stays NULL: a gate process cannot resolve it.)
            con.execute(
                'INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, '
                'session_id, trigger_source) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?)',
                (now, agent_id, 'PreToolUse', 'deny', reason, gate))
        con.commit()
    finally:
        con.close()


def _raise_budget(_signum, _frame):
    raise _WriteBudgetExceeded()


def record(gate, decision, reason, agent_id=None, deny_row=False, db_path=None):
    """Record one gate outcome. Returns True when it was written. NEVER raises: see the module docstring."""
    try:
        if gate not in GATES or decision not in DECISIONS:
            return False
        if decision == 'allow':
            reason = ''
        elif reason not in REASONS:
            reason = 'denied' if decision == 'deny' else 'exit_code'
        previous = None
        armed = False
        try:
            # The decision is final, so the gate's own watchdog alarm (auth-admin-gate arms one that ends
            # the process with exit 2) is replaced by this budget for the few milliseconds of the write.
            signal.alarm(0)
            previous = signal.signal(signal.SIGALRM, _raise_budget)
            signal.alarm(WRITE_BUDGET_S)
            armed = True
        except BaseException:  # noqa: BLE001 -- no SIGALRM here (not the main thread, Windows): the sqlite timeouts still bound the write
            pass
        try:
            _write(db_path or _db_path(), gate, decision, reason, agent_id, deny_row)
            return True
        finally:
            if armed:
                try:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, previous if previous is not None else signal.SIG_DFL)
                except BaseException:  # noqa: BLE001
                    pass
    except BaseException:  # noqa: BLE001 -- rule 2: a failed write must not change anything
        return False


def audited(gate, main, deny_row=False):
    """Run `main` (a gate's entry point) and record how it ended. Exits exactly as `main` would have."""
    tee = None
    try:
        tee = _TeeStdin(sys.stdin)
        sys.stdin = tee
    except BaseException:  # noqa: BLE001 -- no tee: the outcome is still counted, without an agent id
        tee = None

    def finish(decision, reason):
        try:
            agent = _agent_id(tee.captured()) if tee is not None else None
            record(gate, decision, reason, agent_id=agent, deny_row=deny_row)
        except BaseException:  # noqa: BLE001
            pass

    try:
        main()
    except SystemExit as exc:
        decision, reason = _classify(exc.code)
        finish(decision, reason)
        raise
    except Exception:
        finish('error', 'gate_error')
        raise
    finish('allow', '')
