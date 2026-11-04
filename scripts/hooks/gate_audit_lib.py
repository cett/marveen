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
     reason code (REASONS, a fixed enum, never free text), the agent id and, on a deny row, the session id as
     trace_id (see below). This module reads exactly ONE field of the hook event, session_id, through
     note_event(); the field must pass clean_session_id (a short id alphabet, never a `w3c-` value) or it is
     dropped. No command, file path, recipient, tool input or output can reach the write, because the module
     is never handed them: a gate passes the event to note_event, which looks at that one key and keeps
     nothing else.

THE TRACE ID of a deny row is the RAW Claude session id, the string otel_spans.trace_id holds for that
session's work, so the denial and the session's spans fall into one trace (D1 of the audit/OTel plan). It is
the only thing the event contributes. There is no fallback: an event without a usable session_id leaves
trace_id NULL (the environment is NOT consulted, nothing is derived or guessed). A `w3c-` value is refused
here as it is on the server (D2): that prefix is the server's own statement about a traceparent that came
with credentials, and a gate must not be able to make it. The session id goes to trace_id only; the session_id
column of the row stays NULL, as before.

WHO THE AGENT IS comes from the process, not from the event. The event's cwd follows the agent's own `cd`, so an
agent could point it at another agent's directory and have its denials filed under that agent. The launcher
fixes CLAUDE_CONFIG_DIR (<install>/agents/<id>/...) and CLAUDE_PROJECT_DIR before the session starts, and
a tool call cannot change the environment of a hook process. Neither names an agent -> agent_id stays NULL
(unattributed), never a guess. The tenant is not resolved either (tenant_id stays NULL = unresolved, as for
any row whose tenant cannot be told).

A limit: a gate that ends the process with os._exit (auth-admin-gate's hard timeout) never returns here, so
that deny is not counted. Pure stdlib.
"""
import os
import signal
import sqlite3
import string
import time
from urllib.parse import quote

# Every gate that may record. A name outside this list is never written: `gate` becomes a column value.
GATES = frozenset({
    'destructive-gate', 'secret-read-gate', 'email-approval-gate', 'outgoing-copy-gate',
    'auth-admin-gate', 'tenant-skill-gate', 'shell-rescan-guard',
})
DECISIONS = frozenset({'allow', 'deny', 'error'})
# denied: the gate exited 2. gate_error: main() raised something the gate did not turn into a verdict (the
# process ends with a traceback and exit 1, which Claude Code does NOT treat as a block). exit_code: any other
# exit status.
REASONS = frozenset({'denied', 'gate_error', 'exit_code', 'input_too_large'})


class DenyExit(SystemExit):
    """A gate's exit 2 with a reason code of REASONS: `raise DenyExit(2, 'input_too_large')`. It exits exactly
    like SystemExit(2); audited() records the code instead of the generic 'denied'."""

    def __init__(self, code=2, reason='denied'):
        super().__init__(code)
        self.reason = reason

BUSY_TIMEOUT_MS = 200
WRITE_BUDGET_S = 1


class _WriteBudgetExceeded(Exception):
    pass


# What a session id may look like in a trace_id column: the alphabet of a UUID or a hex id, at most this long
# (the server applies the same limits to a trace id that comes from outside, callerTraceId in src/db/context.ts).
MAX_SESSION_ID_LENGTH = 128
_SESSION_ID_CHARS = frozenset(string.ascii_letters + string.digits + '._:-')

# The session id the running gate was told about by note_event(); None until then. One gate process serves one event.
_noted_session = None


def clean_session_id(value):
    """`value` when it may be stored as the trace_id of a deny row, else None. A str of 1..MAX_SESSION_ID_LENGTH
    characters, all of them in the id alphabet (so no whitespace, quote, NUL or newline), not starting with
    `w3c-` in any case. Pure; never raises."""
    try:
        if not isinstance(value, str) or not 0 < len(value) <= MAX_SESSION_ID_LENGTH:
            return None
        if value[:4].lower() == 'w3c-':
            return None
        if len(value) == 32 and all(ch in string.hexdigits for ch in value):
            return None  # the shape of a server trace id: a session id is a UUID, a gate must not join a request trace
        for ch in value:
            if ch not in _SESSION_ID_CHARS:
                return None
        return value
    except BaseException:  # noqa: BLE001
        return None


def note_event(event):
    """Tell the audit which session the running gate belongs to. A gate calls it once, with the event it parsed;
    the module looks at the `session_id` key of a dict and at nothing else, and keeps it only when it passes
    clean_session_id. Anything else (not a dict, no key, an unusable value) clears the note. Never raises."""
    global _noted_session
    try:
        _noted_session = clean_session_id(event.get('session_id')) if isinstance(event, dict) else None
    except BaseException:  # noqa: BLE001
        _noted_session = None


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


def _agent_under(path, install):
    """The id when `path` is <install>/agents/<id>[/...]; '' when it is the install itself; None otherwise."""
    path = os.path.normpath(path)
    agents_root = os.path.join(install, 'agents')
    if path.startswith(agents_root + os.sep):
        return path[len(agents_root) + 1:].split(os.sep)[0] or None
    if path == install:
        return ''
    return None


def _trusted_agent_id():
    """The agent this hook process runs for, from the launcher's environment (see the module docstring).
    CLAUDE_CONFIG_DIR first (a sub-agent has its own under agents/<id>), then CLAUDE_PROJECT_DIR (the directory
    the session started in: agents/<id>, or the install itself for the main agent). Never raises."""
    try:
        install = os.path.normpath(_install_dir())
        config = os.environ.get('CLAUDE_CONFIG_DIR')
        if config:
            found = _agent_under(config, install)
            if found:
                return found
        project = os.environ.get('CLAUDE_PROJECT_DIR')
        if project:
            found = _agent_under(project, install)
            if found:
                return found
            if found == '':
                return _main_agent_id()
        return None
    except BaseException:  # noqa: BLE001 -- see rule 2 in the module docstring
        return None


def _db_path():
    import hook_db_path
    return hook_db_path.db_path()


def _write(path, gate, decision, reason, agent_id, deny_row, session_id=None):
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
            # No tool_name / content_hash / session_id column on purpose: the row names the gate, the verdict, a
            # reason code and the agent, plus the session id as trace_id when the event gave a usable one.
            # (tenant_id stays NULL: a gate process cannot resolve it.)
            trace_id = clean_session_id(session_id)
            legacy = ('INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, '
                      'session_id, trigger_source) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?)')
            legacy_args = (now, agent_id, 'PreToolUse', 'deny', reason, gate)
            if trace_id is None:
                con.execute(legacy, legacy_args)
            else:
                try:
                    con.execute(
                        'INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, '
                        'session_id, trigger_source, trace_id) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)',
                        legacy_args + (trace_id,))
                except sqlite3.OperationalError as exc:
                    # A database that has not run migration 0088 yet has no trace_id column: file the row without
                    # it rather than lose the denial (and, with it, the count written just above).
                    if 'trace_id' not in str(exc):
                        raise
                    con.execute(legacy, legacy_args)
        con.commit()
    finally:
        con.close()


def _raise_budget(_signum, _frame):
    raise _WriteBudgetExceeded()


def record(gate, decision, reason, agent_id=None, deny_row=False, db_path=None, session_id=None):
    """Record one gate outcome. Returns True when it was written. NEVER raises: see the module docstring.
    `session_id` becomes the trace_id of a deny row when it passes clean_session_id."""
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
            _write(db_path or _db_path(), gate, decision, reason, agent_id, deny_row, session_id)
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

    def finish(decision, reason):
        try:
            record(gate, decision, reason, agent_id=_trusted_agent_id(), deny_row=deny_row, session_id=_noted_session)
        except BaseException:  # noqa: BLE001
            pass

    try:
        main()
    except SystemExit as exc:
        decision, reason = _classify(exc.code)
        if decision == 'deny':
            reason = getattr(exc, 'reason', None) or reason
        finish(decision, reason)
        raise
    except Exception:
        finish('error', 'gate_error')
        raise
    finish('allow', '')
