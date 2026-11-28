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

POSTGRESQL MODE (hook_pg_mode.pg_mode(), no explicit db_path). The frozen SQLite file is never written. The gate asks the
dashboard instead: POST /api/v1/hooks/gate-audit, ONE call under ROUTE_DEADLINE_S (one attempt, no retry, a refused
connection returns at once), inside the same WRITE_BUDGET_S alarm. The route writes the counts and the deny rows in one
transaction and takes the agent from the TOKEN (this module presents the token of _trusted_agent_id(), never one picked from
the event's cwd). A process with no trusted agent has no token to present: NOTHING is filed (see Q-H2b-b in the PR).
  * a deny (a row, or only a count) that cannot be delivered goes to the deny SPOOL, store/.gate-audit-spool/<agent>.jsonl:
    bounded (SPOOL_MAX_ENTRIES, a full spool drops the NEW entry and prints one `spool_full` line on stderr), append-only,
    claimed by rename on drain and put back on any failure. The spool is DELAYED DELIVERY, not evidence of record: every agent's
    process runs as the same OS user, so any of them can delete a line from ANY agent's spool or forge one. A forged line is
    filed under the id of the agent WHOSE spool it was written into (the drain presents that agent's token), never under the
    forger's: a fixed-set deny (gate and reason from fixed sets, ts clamped by the route to the last 7 days, a trace id that
    passed clean_session_id) can be attributed to another agent: the author of a row that arrives from the spool is the OWNER of the file, not
    necessarily its writer. The spool is delayed delivery, never proof of authorship. Suppressing a real deny is slowed by the
    gates' protected path (a speed bump, not a wall); an HMAC would protect nothing, because the key (the agent's token) must
    be readable by the hook, so by every agent shell of the same OS user. It is drained, in batches of DRAIN_BATCH, by the next successful route call of
    that agent's gates; there is no daemon, an idle agent's spool waits for its next gate call.
  * an allow or an error is a STATISTIC, not evidence (decision Q1 A): it is added to a per-agent counts file and sent as ONE
    aggregated request at most once per COUNTS_FLUSH_EVERY_S (and together with any deny call). A failed send puts the counts
    back; a full counts file drops the new line. No per-call POST, so an allow costs a file append and no network.

A limit: a gate that ends the process with os._exit (auth-admin-gate's hard timeout) never returns here, so
that deny is not counted. Pure stdlib.
"""
import json
import os
import signal
import sqlite3
import string
import sys
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

# PostgreSQL mode (see the module docstring). Limits mirror src/web/routes/hooks-gate-audit.ts (pinned by a parity cell).
ROUTE_PATH = '/api/v1/hooks/gate-audit'
ROUTE_DEADLINE_S = 0.8
SPOOL_DIR_NAME = '.gate-audit-spool'
SPOOL_MAX_ENTRIES = 200
DRAIN_BATCH = 50          # the route cap of `denies`
MAX_COUNT_KEYS = 20       # the route cap of `counts`
MAX_COUNT_N = 10000       # the route cap of one count's n
COUNTS_FLUSH_EVERY_S = 60
COUNTS_MAX_LINES = 2000
TS_MAX = 2 ** 53  # exclusive upper bound of a spooled deny's ts (see _valid_ts)
STALE_CLAIM_S = 120       # a claimed file older than this belongs to a process that died; its lines are taken back


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


# ---- PostgreSQL mode: one route call, a deny spool and an aggregated counts file ------------------------------------------
# The spool pattern of ledger_lib (append-only and bounded, claimed by rename, put back on failure) with this module's own
# path, caps, batch and payload: ledger_lib's helpers are bound to the ledger route and its entry shape, and importing it
# costs urllib and a stderr warning a gate must not gain, so they do not fit as they are.

def _pg_mode():
    import hook_pg_mode
    return hook_pg_mode.pg_mode()


def _marker_refuses_sqlite():
    """The PostgreSQL install marker is present (P-E): the frozen SQLite file is not written, whatever the other rule says."""
    import hook_pg_mode
    return hook_pg_mode.store_marker_present()


def _spool_paths(agent_id):
    """(deny spool, counts file, flush stamp) of one agent, in store/.gate-audit-spool/."""
    safe = ''.join(c if (c.isalnum() or c in '-_') else '_' for c in str(agent_id))
    base = os.path.join(os.path.dirname(_db_path()), SPOOL_DIR_NAME, safe)
    return base + '.jsonl', base + '.counts', base + '.stamp'


def _read_entries(path):
    """The JSON objects of a JSON-lines file; a torn or non-object line is dropped. [] when there is no file."""
    out = []
    try:
        with open(path, 'rb') as fh:
            for raw in fh:
                try:
                    obj = json.loads(raw.decode('utf-8'))
                except Exception:  # noqa: BLE001 -- a torn line
                    continue
                if isinstance(obj, dict):
                    out.append(obj)
    except FileNotFoundError:
        pass
    return out


def _append_entries(path, entries, cap):
    """Append JSON lines, the file holding at most `cap` lines. A full file drops the NEW entries (nothing is rewritten);
    returns how many were dropped."""
    if not entries:
        return 0
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    try:
        with open(path, 'rb') as fh:
            have = sum(1 for _ in fh)
    except FileNotFoundError:
        have = 0
    keep = entries[:max(0, cap - have)]
    if keep:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, ''.join(json.dumps(e, separators=(',', ':')) + '\n' for e in keep).encode('utf-8'))
        finally:
            os.close(fd)
    return len(entries) - len(keep)


def _claim(path):
    """Take the file by renaming it (a concurrent gate appends to a fresh one); None when there is nothing to take. The
    claim's mtime is set to now, so STALE_CLAIM_S measures the claim, not the last append."""
    claimed = '%s.%d.flushing' % (path, os.getpid())
    try:
        os.replace(path, claimed)
    except FileNotFoundError:
        return None
    os.utime(claimed, None)
    return claimed


def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _recover_stale_claims(path, cap):
    """A claim older than STALE_CLAIM_S belongs to a process that died mid-send (the alarm budget is 1 s): take its lines back."""
    directory, prefix = os.path.dirname(path), os.path.basename(path) + '.'
    try:
        names = os.listdir(directory)
    except OSError:
        return
    mine = '%s.%d.flushing' % (path, os.getpid())
    for name in names:
        if not (name.startswith(prefix) and name.endswith('.flushing')):
            continue
        found = os.path.join(directory, name)
        try:
            if time.time() - os.stat(found).st_mtime < STALE_CLAIM_S:
                continue
            if found != mine:
                os.replace(found, mine)
            os.utime(mine, None)
        except OSError:
            continue
        _append_entries(path, _read_entries(mine), cap)
        _unlink(mine)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _member(value, allowed):
    # A str only: a forged line may carry a list or a dict, which is unhashable and would raise in `in frozenset`.
    return isinstance(value, str) and value in allowed


def _valid_count(e):
    if not (_member(e.get('gate'), GATES) and _member(e.get('decision'), DECISIONS)):
        return False
    n = e.get('n')
    if not (_is_int(n) and 0 < n <= MAX_COUNT_N):
        return False
    return e.get('reason') == '' if e['decision'] == 'allow' else _member(e.get('reason'), REASONS)


def _valid_ts(ts):
    """A deny's time: a whole number of seconds from 0 up to (not including) 2**53, the largest range JSON carries exactly. The
    route's rule is Number.isInteger (stricter than it looks: JSON.parse reads 10**400 as Infinity and the WHOLE batch is a 400),
    so a forged line with a 310-digit ts, valid for a Python int, must be dropped HERE: kept, it would head every batch, make
    every drain a 400 and fill the spool until every real deny is dropped as spool_full. Pinned against the route by
    hooks-gate-audit-route.test.ts (parity cell)."""
    return _is_int(ts) and 0 <= ts < TS_MAX


def _valid_deny(e):
    # A line of the spool is only as trustworthy as the file: anything outside the fixed sets is dropped here, and the route checks again.
    return (_member(e.get('gate'), GATES) and _member(e.get('reason'), REASONS) and _valid_ts(e.get('ts'))
            and (e.get('trace_id') is None or clean_session_id(e.get('trace_id')) is not None) and isinstance(e.get('row'), bool))


def _aggregate(counts):
    """[(gate, decision, reason, n)] -> one entry per key, n split at MAX_COUNT_N."""
    totals = {}
    for gate, decision, reason, n in counts:
        totals[(gate, decision, reason)] = totals.get((gate, decision, reason), 0) + n
    out = []
    for (gate, decision, reason), n in sorted(totals.items()):
        while n > 0:
            out.append({'gate': gate, 'decision': decision, 'reason': reason, 'n': min(n, MAX_COUNT_N)})
            n -= MAX_COUNT_N
    return out


def _deadline(start):
    """The shared route deadline, counted from `start` (the moment record() began), so the import and the file work are inside it."""
    import hook_route
    return hook_route.Deadline(max(0.0, ROUTE_DEADLINE_S - (time.monotonic() - start)))


def _send(agent_id, start, counts, denies):
    """ONE route call, no retry. Returns on an acknowledged write only; raises on anything else."""
    import hook_route
    answer = hook_route.call('POST', ROUTE_PATH, {'counts': counts, 'denies': denies}, agent_id, _deadline(start), max_attempts=1)
    if not (isinstance(answer, dict) and answer.get('ok') is True and answer.get('counts') == len(counts)
            and answer.get('denies') == len(denies)):
        raise RuntimeError('gate-audit: the answer does not acknowledge the write')


def _spool_denies(spool, entries):
    dropped = _append_entries(spool, entries, SPOOL_MAX_ENTRIES)
    if dropped:
        try:
            sys.stderr.write('gate_audit: spool_full (%d deny entr%s dropped)\n' % (dropped, 'y' if dropped == 1 else 'ies'))
        except BaseException:  # noqa: BLE001
            pass


def _flush_due(stamp):
    try:
        age = time.time() - os.stat(stamp).st_mtime
    except OSError:
        return True
    return not 0 <= age < COUNTS_FLUSH_EVERY_S


def _touch(path):
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, 'a'):
            pass
        os.utime(path, None)
    except OSError:
        pass


def _take_batch(entries):
    """The first entries that fit ONE route call: at most DRAIN_BATCH denies and MAX_COUNT_KEYS distinct count keys."""
    keys, batch = set(), []
    for e in entries:
        key = (e['gate'], e['reason'])
        if len(batch) >= DRAIN_BATCH or (key not in keys and len(keys) >= MAX_COUNT_KEYS):
            break
        keys.add(key)
        batch.append(e)
    return batch, entries[len(batch):]


def _drain_spool(agent_id, start):
    """After an acknowledged call: send ONE batch of the spooled denies (counts and rows together). The file is claimed by
    rename; until the route has acknowledged, EVERYTHING is put back (a delete before the acknowledgement would lose the evidence)."""
    spool = _spool_paths(agent_id)[0]
    _recover_stale_claims(spool, SPOOL_MAX_ENTRIES)
    claimed = _claim(spool)
    if claimed is None:
        return
    put_back = []
    try:
        valid = [e for e in _read_entries(claimed) if _valid_deny(e)]
        put_back = valid
        batch, rest = _take_batch(valid)
        if not batch:
            put_back = []
            return
        counts = _aggregate([(e['gate'], 'deny', e['reason'], 1) for e in batch])
        denies = [dict({'gate': e['gate'], 'reason': e['reason'], 'ts': e['ts']}, **({'trace_id': e['trace_id']} if e.get('trace_id') else {}))
                  for e in batch if e['row']]
        _send(agent_id, start, counts, denies)
        put_back = rest
    finally:
        _spool_denies(spool, put_back)
        _unlink(claimed)


def _send_pending(agent_id, start, own_deny=None):
    """Send the claimed counts file, and `own_deny` (this call's deny: its count, and its row when it wants one), in ONE call.
    A failure puts the counts back and spools the deny, then re-raises (record() swallows it)."""
    spool, counts_file, stamp = _spool_paths(agent_id)
    claimed, restore, tail, delivered = None, [], [], False
    try:
        # A counts claim older than STALE_CLAIM_S belongs to a process that died mid-send (the deny spool has had this from the
        # start; without it an orphaned `.counts.<pid>.flushing` is never read again and the files pile up). Statistics only,
        # and INSIDE the try on purpose: whatever it raises (an alarm included), the finally below still spools this call's
        # own deny; outside the try, the deny would be lost before anything had been written.
        _recover_stale_claims(counts_file, COUNTS_MAX_LINES)
        claimed = _claim(counts_file)
        lines =[(e['gate'], e['decision'], e['reason'], e['n']) for e in (_read_entries(claimed) if claimed else []) if _valid_count(e)]
        restore = _aggregate(lines)  # what a failed send puts back: the counts file's own contribution, never this call's deny
        merged = restore
        if own_deny is not None:
            merged = _aggregate(lines + [(own_deny['gate'], 'deny', own_deny['reason'], 1)])
        head, tail = merged[:MAX_COUNT_KEYS], merged[MAX_COUNT_KEYS:]
        denies = []
        if own_deny is not None and own_deny['row']:
            denies = [dict({'gate': own_deny['gate'], 'reason': own_deny['reason'], 'ts': own_deny['ts']},
                           **({'trace_id': own_deny['trace_id']} if own_deny.get('trace_id') else {}))]
        if head or denies:
            _send(agent_id, start, head, denies)
        delivered = True  # acknowledged: only now does `tail` (more keys than one call carries) go back to wait for the next call
    finally:
        if not delivered:
            # The EVIDENCE first: this call's own deny goes to the spool before the statistics are put back, so an alarm
            # (SIGALRM) landing inside the put-back can cost a count, never the deny itself.
            if own_deny is not None:
                _spool_denies(spool, [own_deny])
            _append_entries(counts_file, restore, COUNTS_MAX_LINES)
        if claimed:
            _unlink(claimed)
    if tail:
        _append_entries(counts_file, tail, COUNTS_MAX_LINES)
    _touch(stamp)
    try:
        _drain_spool(agent_id, start)
    except Exception:  # noqa: BLE001 -- the call above WAS acknowledged; the drain put its claimed lines back itself
        pass
    return True


def _record_pg(gate, decision, reason, agent_id, deny_row, session_id):
    """PostgreSQL mode of record(): see the module docstring. True when the route acknowledged the data."""
    if not agent_id:
        return False  # no trusted agent, so no token to present: nothing is filed (never a guess)
    start = time.monotonic()
    spool, counts_file, stamp = _spool_paths(agent_id)
    if decision == 'deny':
        own = {'gate': gate, 'reason': reason, 'ts': int(time.time()), 'trace_id': clean_session_id(session_id), 'row': bool(deny_row)}
        return _send_pending(agent_id, start, own)
    # an allow or an error is a statistic: one line in the counts file, one aggregated call at most once per COUNTS_FLUSH_EVERY_S
    _append_entries(counts_file, [{'gate': gate, 'decision': decision, 'reason': reason, 'n': 1}], COUNTS_MAX_LINES)
    if not _flush_due(stamp):
        return False
    _touch(stamp)
    return _send_pending(agent_id, start)


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
            # An explicit db_path is the SQLite seam of the tests; a gate never passes one. On a PostgreSQL install the
            # frozen file is not written: the gate asks the dashboard (see the module docstring).
            if db_path is None and _pg_mode():
                return _record_pg(gate, decision, reason, agent_id, deny_row, session_id)
            if db_path is None and _marker_refuses_sqlite():
                # a rule drift (the marker says PostgreSQL, the SQLite arm was reached): the frozen file is not touched
                sys.stderr.write('gate-audit: the PostgreSQL install marker (store/.pg-installed) is present; the SQLite file is not written\n')
                return False
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
