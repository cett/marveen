#!/usr/bin/env python3
"""PostToolUse hook: context watchdog for the main channels agent and the
persistent named fleet sub-agents.

Phase 2: on every tool call, read the newest transcript-JSONL line carrying
`message.usage` for the CURRENT session and write a per-turn row directly
into the token_usage table -- bypassing the batched collectTokenUsage()
sweep (src/web/token-usage.ts, 5-minute interval as of phase 1) so anything
reading token_usage (dashboard, context-restart-gate) never sees data older
than the agent's last tool call.

Phase 3: if the latest turn's context-token estimate reaches
CONTEXT_PCT_THRESHOLD of the restart-gate's configured threshold (proactive
compaction, ahead of the harness's own late-stage /compact -- and, while it
still existed, ahead of the reactive context-compact-monitor.sh heartbeat
this phase made redundant; that heartbeat was retired in phase 4, see below),
emit a rolling HANDOFF summary via the
hook's `hookSpecificOutput.additionalContext` -- the same injection channel
scripts/hooks/ledger-replay.py and taskstate-replay.py already use, just for
PostToolUse instead of SessionStart. On a SQLite install the summary is built
entirely from local SQLite reads (fleet_blackboard, kanban_cards, agent_messages)
-- no HTTP call to the dashboard API, so a stopped/overloaded dashboard process
never adds latency or a failure mode to this hook (the design report this
phase is based on flagged an API call from inside a fail-closed hook as the
main risk: "the watchdog must be an ultra-simple script -- no network, no DB
writes beyond the essentials"). On a PostgreSQL install (hook_pg_mode.pg_mode())
the SQLite file is stale, so the READS that feed the threshold and the HANDOFF
come only from POST /api/v1/hooks/watchdog-facts (see the PG-mode paragraph
below). A HANDOFF only actually fires (and only then logs a row) when
should_emit_handoff()'s dedup gate says so -- first crossing, a pct-band
change, a same-band pct drop (compact/reset), or a real content change once
enough time has passed. No new persistent state: the gate reads its own
prior 'handoff' row (per agent_id+session_id) back out of hook_audit_log,
so "rows = actual emits" stays true and a skipped call writes nothing.
Every HANDOFF firing that DOES happen is also logged as a
verdict='handoff' row in the existing hook_audit_log table (see
record_handoff_audit()) -- this used to also feed a validation counter
(src/watchdog-validation.ts) that was requested before phase 4 (retiring
context-compact-monitor.sh) could be considered: 10 HANDOFF cycles needed to
land with an interlock stamp (store/context-compact-state.json's
`last_compact`, written here on every HANDOFF and read by the monitor's own
45-min COOLDOWN_S gate to avoid firing back-to-back with the heartbeat)
actually landing and no double-compact slipping through, before that
decision was on the table. Phase 4 has since happened -- both
context-compact-monitor.sh and this interlock stamp are retired (the stamp
had no reader left once the heartbeat was gone; re-introducing a file-based
dedup for the watchdog itself would run against the store/*.json -> SQLite
migration direction, so it was dropped rather than repurposed), and with it
the now-purposeless validation counter and its `GET /api/hook-audit/watchdog-cycles`
route. The hook_audit_log 'handoff' rows themselves stay -- they are the
real audit trail, independent of the retired counter that used to read them.

#800 F3 (distinct numbering from this hook's own phase 2/3 above -- this is
OTel work, not the watchdog gate): on the same PostToolUse call that writes
the token_usage row, also upsert an `agent.turn` span and a `model.call`
span into otel_spans (see db/observability.ts's upsertOtelSpan for the TS
counterpart used by the F2 tool.call span). model.call is one span per
distinct assistant message (span_id = the API's own msg_... id, already
unique -- see write_model_call_span()). agent.turn has no dedicated
start/end hook (Rick's plan named this hook's own PostToolUse as the
implementation site, not a new Stop hook): find_turn_start_event() walks the
transcript backward for the nearest real user-turn boundary and
write_agent_turn_span() upserts that span, rolling its end_ms forward on
every tool call within the turn; close_stale_turn_spans() flips any OTHER
still-'running' agent.turn span on the same trace to 'ok' once a new turn
boundary is detected, since a turn only becomes provably finished once a
newer one has started. Same local-SQLite-only, no-network constraint as the
rest of this hook -- see the Logging-category paragraph below.

Scope (phase 4 sub-agent extension): the main channels agent AND every
persistent named fleet sub-agent (agents/<id>/.claude/settings.json) -- each
scaffolded via agent-scaffold.ts's ensureContextWatchdogHook(), one entry per
agent's own settings.json, same absolute-path convention already used for its
other scaffold-managed hooks. Deliberately EXCLUDES the ephemeral
agent-worker.ts pool (workers run from an isolated home outside both
PROJECT_ROOT and agents/<id>, e.g. ~/.<agent>-worker(-fast) -- see
agent-worker.ts): a HANDOFF built from fleet_blackboard/kanban context makes
sense for a persistent fleet member with its own blackboard row and kanban
assignments, but not for a short-lived worker that has neither.

_known_agent_cwd() below is the authorization gate: unlike
ledger_lib.agent_id_from_cwd() (shared by a dozen other hooks, none of which
null-check its result), it recognises ONLY the two structurally-verifiable
cwd shapes -- the main install root, or a sub-agent's own agents/<id>
directory -- and returns None for anything else, INCLUDING the ephemeral
worker homes above (ledger_lib's own fallback would instead return their
basename, e.g. ".marveen-worker", which is truthy and would silently pass a
naive "is not None" check). Kept local to this hook rather than folded into
ledger_lib so the other callers' existing contract (always a non-None
string) is untouched.

A SECOND, UNRELATED "sub-agent" concept (naming collision, read carefully):
everything above is about a persistent, NAMED FLEET member's own top-level
session (cwd-based). Separately, Claude Code hooks also fire for tool calls
made by an ephemeral Agent-tool sub-agent (fork, quarantine-reader,
general-purpose, ...) that a fleet agent's OWN session spawns -- by design,
per Claude Code's hooks/sub-agents docs. Such a spawned sub-agent inherits
its parent's cwd, so _known_agent_cwd() alone cannot tell its tool calls
apart from the parent's own. Claude Code's payload carries a distinct
`agent_id` field for exactly this (a per-spawn UUID, present ONLY on a
sub-agent's own tool-call events) -- confusingly the same field name as this
script's own `agent_id` local (the fleet member's identity), so main() reads
it into a deliberately different name, `cc_subagent_uuid`, and gates the
HANDOFF-emission path on it: a spawned sub-agent has no blackboard row or
kanban assignments of its own, and must never receive the PARENT's real
state injected into its isolated context as if it were a genuine system
notification. Token/span bookkeeping is deliberately NOT gated on this -- a
sub-agent's tool calls are real spend against the same account and should
still count.

Logging-category hook (CLAUDE.md "Hook fail-closed policy" exception, same
as tool-log-capture.py): fail/timeout/crash -> SILENT PASS, exit 0 always.
This is observability + best-effort continuity, not a gate -- it must never
block a tool call.

PostgreSQL mode (H1 + H2a): the SQLite file is not the source of truth after the cutover, so in PG mode this hook
NEVER opens it (main_pg() runs before any sqlite3.connect, and resolves no tenant itself): every read and every write
goes to the dashboard. ONE record call per PostToolUse (POST /api/v1/hooks/watchdog-record) carries the token_usage row,
the agent.turn / model.call spans and the stale-turn close, and answers the context_restart_gate threshold (always, even
when a write failed: the writes are best-effort telemetry and must not cost the agent its HANDOFF). Only once the context
is past CONTEXT_PCT_THRESHOLD, and the call is not a spawned sub-agent's: the dedup read (`want: prior_handoff` on
/api/v1/hooks/watchdog-facts), the decision, the HANDOFF facts (`want: handoff`, the agent's own tenant context), the
injection, and the audit row (POST /api/v1/hook-audit). There is no fallback to SQLite after a route error: a wrong
state injected at the moment the context is nearly full is worse than no injection. A failed record call has no
threshold, so the HANDOFF path is skipped for this call; a failed dedup read injects NOTHING (it must not fail open to
"emit on every call": the "no prior row means emit" rule below is for an ANSWER of null only); a failed facts call
injects nothing and writes NO audit row (a row means "actually emitted"); an audit write that fails AFTER the text was
injected leaves the row missing and the next call may emit again, accepted and logged as one line on stderr. This hook
runs on EVERY tool call, so the route calls share a SHORT budget (WATCHDOG_ROUTE_DEADLINE_S in total, ONE attempt, no
retry; a refused connection returns at once), unlike the tenant gates' 7.5 s. The hook imports no database driver and
reads no credential: the route is the point (a DB password must not enter every agent's shell). Nothing of the
SQLite file is carried over (continuity in PG starts at the deploy). Exit 0 always.
"""
from __future__ import annotations  # `X | None` annotations: python3 can be the macOS system 3.9
import sys
import os
import json
import sqlite3
import datetime
import hashlib
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hook_pg_mode  # noqa: E402
import ledger_lib  # noqa: E402
import tenant_context_lib  # noqa: E402

# Fraction of the restart-gate's configured thresholdTokens (agent_settings
# row, setting_key='context_restart_gate' -- migration 0058, group 3/8,
# replacing the former store/context-restart-gate.json; default 400_000 --
# src/context-restart-gate.ts DEFAULT_THRESHOLD_TOKENS) at which this hook
# proactively injects a HANDOFF.
# Deliberately well below the gate's own 100% trigger and the harness's own
# 90-97% /compact, and below the now-retired context-compact-monitor.sh's
# COMPACT_PCT (75) and URGENT_PCT (95) -- this fires first, earliest signal wins.
CONTEXT_PCT_THRESHOLD = 0.6
DEFAULT_THRESHOLD_TOKENS = 400_000

# Cap on the injected HANDOFF text so a single tool call can't inject an
# unbounded amount of context (mirrors ledger-replay.py's own byte cap).
MAX_HANDOFF_CHARS = 2000
HANDOFF_SUMMARY_MAX_CHARS = 600

# PG mode: the dashboard route the threshold and the HANDOFF facts come from, and its budget. This hook runs on EVERY
# PostToolUse, so the budget is far below hook_route's 7.5 s / 2 attempts (made for the tenant gates, which may wait
# once per prompt): 1.5 s for the whole run (the threshold call and the handoff call share it), ONE attempt, no retry.
# Absence of an injection beats a slow tool call; the next tool call asks again.
WATCHDOG_ROUTE_PATH = "/api/v1/hooks/watchdog-facts"
# H2a: the ONE writes-and-threshold call of every PostToolUse, and the existing audit route the emitted HANDOFF is logged to.
WATCHDOG_RECORD_PATH = "/api/v1/hooks/watchdog-record"
HOOK_AUDIT_PATH = "/api/v1/hook-audit"
WATCHDOG_ROUTE_DEADLINE_S = 1.5
WATCHDOG_ROUTE_ATTEMPTS = 1
# The audit row is the other half of the dedup pair (the next call reads it back). When the earlier calls of the run (record,
# prior_handoff, facts) leave less than this, the audit call gets a fresh budget of this size instead of being skipped: a skipped
# row means the NEXT call finds no prior HANDOFF and injects again, on every tool call, exactly when the dashboard is slow and
# the context is full. Worst case for the whole run: WATCHDOG_ROUTE_DEADLINE_S + this.
WATCHDOG_AUDIT_DEADLINE_S = 0.4
# An own blackboard row in one of these states is unfinished work the handoff must hand over together
# with the duty to close it ('stale' is an 'active' row the sweeper gave up on, still open).
OPEN_BLACKBOARD_STATUSES = ("active", "stale")
HANDOFF_CLOSE_ROW_NOTE = (
    "FIGYELEM: a fenti blackboard-sorod nyitott. Ha a munka kesz, zard done-ra (POST /api/blackboard, "
    "status=done, rovid osszefoglalo); ha elakadtal, blocked-re. Az ujrainditas nem zarja le."
)


def _install_dir() -> str:
    return ledger_lib._install_dir()


def _known_agent_cwd(cwd: str):
    """Structural allowlist for this hook's scope -- see the module docstring.
    Returns the agent_id for the two recognised shapes (main install root, or
    a sub-agent's own agents/<id> dir), or None for everything else (most
    importantly the ephemeral agent-worker.ts pool). Deliberately does NOT
    delegate to ledger_lib.agent_id_from_cwd(), whose 'last path component'
    fallback never returns None."""
    cwd = (cwd or "").rstrip("/")
    if not cwd:
        return None
    install = _install_dir().rstrip("/")
    if cwd == install:
        return ledger_lib.main_agent_id()
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        agent_id = rel.split(os.sep)[0]
        return agent_id or None
    return None


def latest_usage_event(transcript_path):
    """Return the parsed JSON of the LAST transcript line carrying
    message.usage, or None. Mirrors src/web/active-model.ts's
    readContextTokensFromProjectDir(): scan from the end, first usage-bearing
    line wins (same "latest cumulative usage" semantics), so the two never
    disagree about what "current context" means."""
    if not transcript_path:
        return None
    try:
        with open(transcript_path, encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return None
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        usage = (ev.get("message") or {}).get("usage")
        if isinstance(usage, dict):
            return ev
    return None


def context_tokens(usage: dict) -> int:
    """Same formula as active-model.ts: input + cache_read + cache_creation
    (NOT output -- output is what the model just produced, not what it had
    to hold in context to produce it)."""
    return (int(usage.get("input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0)
            + int(usage.get("cache_creation_input_tokens") or 0))


def _parse_ts(ts_raw):
    if not ts_raw:
        return None
    try:
        return int(datetime.datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def _parse_ts_ms(ts_raw):
    """Like _parse_ts but with millisecond resolution (the transcript stamps lines to the millisecond)."""
    if not ts_raw:
        return None
    try:
        return int(round(datetime.datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).timestamp() * 1000))
    except Exception:
        return None


# How long a model response took, approximated from transcript timestamps (see model_call_duration_ms).
DURATION_TAIL_BYTES = 512 * 1024      # only the end of the transcript is read: the lines of a response are recent
DURATION_MAX_HOPS = 20                # blocks of one response followed back through parentUuid
DURATION_MAX_MS = 30 * 60 * 1000      # a larger difference is a pause, not a response: no duration


def _transcript_tail_lines(transcript_path):
    """The last DURATION_TAIL_BYTES of the transcript as lines (a cut first line is dropped). Raises on I/O error."""
    with open(transcript_path, "rb") as f:
        size = f.seek(0, os.SEEK_END)
        start = max(0, size - DURATION_TAIL_BYTES)
        f.seek(start)
        data = f.read()
    if start > 0:
        _, _, data = data.partition(b"\n")
    return data.decode("utf-8", "replace").splitlines()


def _find_transcript_line(lines, uuid):
    """The parsed transcript line whose own `uuid` is `uuid`, or None. A cheap substring test first, so only the
    candidate line is parsed; the parsed uuid is then checked, so text that merely mentions the id does not count."""
    needle = '"uuid":"%s"' % uuid
    for line in reversed(lines):
        if needle not in line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("uuid") == uuid:
            return obj
    return None


def model_call_duration_ms(transcript_path, ev):
    """APPROXIMATE wall time of the model response `ev` is the (last) usage line of, in ms, or None.

    The transcript has no field for it. A response is written as one line per content block (thinking, text,
    tool_use), all with the same message id, each pointing at the previous one through parentUuid; the first
    block's parent is the line the model was answering (the user prompt or the tool_result). So: follow parentUuid
    from `ev` while the parent is an assistant line of the SAME response, and take the difference between the
    timestamp of `ev` and that first non-response line. It includes the time the harness took to write the
    line, and nothing the model spent before its first block is written is excluded.

    Any doubt gives None and NEVER raises: no parentUuid, the chain leaves the tail that was read, unreadable
    file or line, a timestamp that does not parse, a difference of zero or less, or over DURATION_MAX_MS. A
    missing duration just leaves the span without one."""
    try:
        parent = ev.get("parentUuid")
        message_id = (ev.get("message") or {}).get("id")
        end_ms = _parse_ts_ms(ev.get("timestamp"))
        if not transcript_path or not parent or not message_id or end_ms is None:
            return None
        lines = _transcript_tail_lines(transcript_path)
        start_ms = None
        for _ in range(DURATION_MAX_HOPS):
            line = _find_transcript_line(lines, parent)
            if line is None:
                return None
            same_response = (line.get("type") == "assistant"
                             and (line.get("message") or {}).get("id") == message_id)
            if same_response:
                parent = line.get("parentUuid")
                if not parent:
                    return None  # the chain starts inside the response: nothing to measure from
                continue
            start_ms = _parse_ts_ms(line.get("timestamp"))
            break
        if start_ms is None:
            return None
        duration = end_ms - start_ms
        return duration if 0 < duration <= DURATION_MAX_MS else None
    except Exception:
        return None


def resolve_tenant(conn, agent_id: str) -> str:
    """Mirrors src/db.ts resolveAgentTenant() exactly (same table, same
    enabled=1 filter, same 0/1/many -> default/tenant/_multi_ rule)."""
    rows = conn.execute(
        "SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1",
        (agent_id,),
    ).fetchall()
    if len(rows) == 0:
        return "default"
    if len(rows) == 1:
        return rows[0][0]
    return "_multi_"


def resolve_write_tenant(conn, agent_id):
    """Mirrors resolveWriteTenant() in src/db/write-tenant.ts: the tenant a telemetry row (otel_spans,
    hook_audit_log) is stamped with. 1. the fresh tenant context of the request the agent is serving
    (agent_tenant_context; a 'bound' context only while the agent still serves the tenant); 2. the one
    tenant the agent serves (main agent or enabled availability row, each tenant once), 'default' when it
    serves none; 3. None (NULL, unknown) for a shared agent with no fresh context. Never raises: this is
    instrumentation, an unresolved row is NULL."""
    if not agent_id:
        return None
    try:
        ctx = tenant_context_lib.read_context(conn, agent_id)
        tenant, _ = tenant_context_lib.usable_context(ctx)
        if tenant and tenant_context_lib.context_still_serves(conn, agent_id, ctx):
            return tenant
        rows = conn.execute(
            "SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1 "
            "UNION SELECT id FROM tenants WHERE main_agent_id = ? AND disabled_at IS NULL",
            (agent_id, agent_id),
        ).fetchall()
    except Exception:
        return None
    if len(rows) == 0:
        return "default"
    return rows[0][0] if len(rows) == 1 else None


def _execute_tenant_aware(conn, sql, params, legacy_sql, legacy_params) -> None:
    """Run the tenant-stamping INSERT; if the table has no tenant_id column yet (this script was
    deployed before the dashboard applied migration 0077) fall back to the legacy INSERT, so the
    window between the two costs no telemetry. Any other error propagates as before."""
    try:
        conn.execute(sql, params)
    except sqlite3.OperationalError as e:
        if "tenant_id" not in str(e):
            raise
        conn.execute(legacy_sql, legacy_params)


def build_usage(session_id, ev, tool_name) -> dict | None:
    """The token_usage fields of one transcript usage line, shared by the SQLite write (write_token_row) and the PG
    route payload (main_pg), so the two paths record the same row. None when the line has no usable timestamp."""
    msg = ev.get("message") or {}
    usage = msg.get("usage") or {}
    ts = _parse_ts(ev.get("timestamp"))
    if ts is None:
        return None

    content_preview = ""
    content = msg.get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                content_preview = str(block["text"])[:200]
                break
    elif isinstance(content, str):
        content_preview = content[:200]

    return {
        "session_id": session_id,
        "timestamp": ts,
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_tokens": int(usage.get("cache_read_input_tokens") or 0),
        "cache_creation_tokens": int(usage.get("cache_creation_input_tokens") or 0),
        "model": msg.get("model"),
        "content_preview": content_preview or None,
        "tool_name": tool_name,
    }


def write_token_row(conn, agent_id, session_id, ev, tool_name) -> bool:
    row = build_usage(session_id, ev, tool_name)
    if row is None:
        return False

    tenant_id = resolve_tenant(conn, agent_id)

    # Same upsert shape as collectTokenUsage() (src/web/token-usage.ts) so a
    # later batch sweep over the same line is a harmless no-op, not a dupe.
    conn.execute(
        """
        INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
          model = CASE WHEN token_usage.model IS NULL AND excluded.model IS NOT NULL THEN excluded.model ELSE token_usage.model END,
          tenant_id = excluded.tenant_id
        """,
        (
            agent_id, session_id, row["timestamp"],
            row["input_tokens"],
            row["output_tokens"],
            row["cache_read_tokens"],
            row["cache_creation_tokens"],
            # thinking_tokens: the batch collector estimates this from
            # thinking-block char length (token-usage.ts parseJsonlFile). Left
            # at 0 here -- a later batch pass fills it in via the ON CONFLICT
            # branch above once it processes the same line; this hook's job is
            # freshness for the token COUNT, not full field parity.
            0,
            row["model"],
            row["content_preview"],
            row["tool_name"],
            tenant_id,
        ),
    )
    return True


def _is_real_user_turn_start(msg: dict) -> bool:
    """True turn boundary: a user message carrying actual user content, not
    one of the tool_result envelopes Claude Code also logs with role=user
    (one per tool call, in between agent.turn boundaries). A content list
    counts as a real boundary if any block is NOT a tool_result -- covers
    plain text, images, and any future block type; a plain string content
    counts if non-empty."""
    content = msg.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(
            isinstance(b, dict) and b.get("type") != "tool_result"
            for b in content
        )
    return False


def find_turn_start_event(transcript_path, before_ts=None):
    """Scan the transcript backward for the nearest real user-turn-start
    event (see _is_real_user_turn_start) at or before before_ts (epoch
    seconds). Returns the raw parsed transcript line, or None if no boundary
    is found (e.g. the transcript was truncated past the turn's start).
    Read separately from latest_usage_event() -- same defensive per-call file
    read, kept independently testable, mirrors this module's existing style."""
    if not transcript_path:
        return None
    try:
        with open(transcript_path, encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return None
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        msg = ev.get("message") or {}
        if msg.get("role") != "user":
            continue
        if before_ts is not None:
            ts = _parse_ts(ev.get("timestamp"))
            if ts is not None and ts > before_ts:
                continue
        if _is_real_user_turn_start(msg):
            return ev
    return None


def upsert_otel_span(conn, trace_id, span_id, parent_span_id, agent_id, operation,
                      start_ms, end_ms, status, attributes) -> None:
    """Same upsert shape as db/observability.ts's upsertOtelSpan (TS side,
    used by the F2 tool-call span) -- INSERT, and on a (trace_id, span_id)
    conflict, only refresh end_ms/status/attributes so a span already closed
    by another writer is never reopened. A span the push exporter already sent
    (exported_at set) whose end_ms or status moves goes out again: exported_at
    is cleared so its final state is not lost."""
    on_conflict = """
        ON CONFLICT (trace_id, span_id) DO UPDATE SET
          exported_at = CASE
            WHEN otel_spans.exported_at IS NOT NULL
             AND (excluded.end_ms IS NOT otel_spans.end_ms OR excluded.status IS NOT otel_spans.status)
            THEN NULL ELSE otel_spans.exported_at END,
          end_ms = excluded.end_ms,
          status = excluded.status,
          attributes = COALESCE(excluded.attributes, otel_spans.attributes)
        """
    row = (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
    _execute_tenant_aware(
        conn,
        "INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes, tenant_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)" + on_conflict,
        row + (resolve_write_tenant(conn, agent_id),),
        "INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" + on_conflict,
        row,
    )


def close_stale_turn_spans(conn, trace_id: str, keep_span_id: str) -> None:
    """Once a new agent.turn boundary is detected for this trace, any OTHER
    still-'running' agent.turn span on the same trace is from a now-finished
    turn -- close it in place (status only; its end_ms already reflects the
    last tool call processed while it was the current turn, since every
    PostToolUse call during that turn kept extending it via upsert_otel_span
    above). No Stop hook exists to close a turn exactly when it ends (see
    module docstring on scope); this is the turn boundary's own PostToolUse
    extension standing in for one, same implementation site Rick's plan
    named for the agent.turn span."""
    conn.execute(
        """
        UPDATE otel_spans SET status = 'ok', exported_at = NULL
        WHERE trace_id = ? AND operation = 'agent.turn' AND status = 'running' AND span_id != ?
        """,
        (trace_id, keep_span_id),
    )


def build_turn_span(session_id: str, turn_ev: dict, latest_ts_ms: int) -> dict | None:
    """The agent.turn span of the turn currently in progress (shared by the SQLite write and the PG route payload). Reuses
    the turn-start event's own transcript uuid as the span_id (stable, already unique) and rolls end_ms forward to the
    latest processed event on every call."""
    turn_span_id = turn_ev.get("uuid")
    if not turn_span_id:
        return None
    start_ts = _parse_ts(turn_ev.get("timestamp"))
    start_ms = start_ts * 1000 if start_ts is not None else latest_ts_ms
    return {
        "operation": "agent.turn",
        "trace_id": session_id,
        "span_id": turn_span_id,
        "parent_span_id": None,
        "start_ms": start_ms,
        "end_ms": latest_ts_ms,
        "status": "running",
        "attributes": None,
    }


def write_agent_turn_span(conn, agent_id: str, session_id: str, turn_ev: dict, latest_ts_ms: int) -> str | None:
    """Upsert the agent.turn span for the turn currently in progress, so the span keeps growing until
    close_stale_turn_spans() closes it on the next turn's first tool call."""
    span = build_turn_span(session_id, turn_ev, latest_ts_ms)
    if span is None:
        return None
    upsert_otel_span(
        conn,
        trace_id=span["trace_id"],
        span_id=span["span_id"],
        parent_span_id=span["parent_span_id"],
        agent_id=agent_id,
        operation=span["operation"],
        start_ms=span["start_ms"],
        end_ms=span["end_ms"],
        status=span["status"],
        attributes=span["attributes"],
    )
    return span["span_id"]


def build_model_span(session_id: str, ev: dict, turn_span_id, duration_ms=None) -> dict | None:
    """The model.call span fields of the latest assistant usage event (shared by the SQLite write and the PG route
    payload); see write_model_call_span for the rules. None without a message id or a usable timestamp."""
    msg = ev.get("message") or {}
    usage = msg.get("usage") or {}
    model_id = msg.get("id")
    ts = _parse_ts(ev.get("timestamp"))
    if not model_id or ts is None:
        return None
    ts_ms = ts * 1000
    attributes = {
        "model": msg.get("model"),
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_tokens": int(usage.get("cache_read_input_tokens") or 0),
        "cache_creation_tokens": int(usage.get("cache_creation_input_tokens") or 0),
    }
    start_ms = ts_ms
    if isinstance(duration_ms, int) and not isinstance(duration_ms, bool) and 0 < duration_ms <= DURATION_MAX_MS:
        start_ms = ts_ms - duration_ms
        attributes["marveen.duration.source"] = "transcript"
    return {
        "operation": "model.call",
        "trace_id": session_id,
        "span_id": model_id,
        "parent_span_id": turn_span_id,
        "start_ms": start_ms,
        "end_ms": ts_ms,
        "status": "ok",
        "attributes": json.dumps(attributes),
    }


def write_model_call_span(conn, agent_id: str, session_id: str, ev: dict, turn_span_id,
                          duration_ms=None) -> str | None:
    """Upsert the model.call span for the latest assistant usage event.
    span_id = the Anthropic API message id (msg_..., already unique per
    model call, present on every usage-bearing transcript line) -- so a
    later PostToolUse call that re-reads the same "latest" line before a
    newer one exists is a harmless no-op upsert, not a duplicate span.

    `duration_ms` (model_call_duration_ms) moves the span's start back from the
    response's transcript time; the span is then marked marveen.duration.source=
    transcript, because the figure is an approximation. Without one (None, or
    anything that is not a plausible positive duration) the span is as before:
    start == end, no marker."""
    span = build_model_span(session_id, ev, turn_span_id, duration_ms=duration_ms)
    if span is None:
        return None
    upsert_otel_span(
        conn,
        trace_id=span["trace_id"],
        span_id=span["span_id"],
        parent_span_id=span["parent_span_id"],
        agent_id=agent_id,
        operation=span["operation"],
        start_ms=span["start_ms"],
        end_ms=span["end_ms"],
        status=span["status"],
        attributes=span["attributes"],
    )
    return span["span_id"]


def _read_gate_threshold(agent_id: str) -> int:
    """Best-effort read of this agent's context_restart_gate thresholdTokens
    from agent_settings (migration 0058, group 3/8 -- replaces the
    former store/context-restart-gate.json), falling back to the gate's own
    default. Any failure (missing row, corrupt JSON, missing key, DB error)
    falls back silently -- this is a read of an already-fail-closed-guarded
    config, not a new gate."""
    try:
        conn = sqlite3.connect(ledger_lib.db_path(), timeout=5)
        try:
            row = conn.execute(
                "SELECT setting_value FROM agent_settings WHERE agent_id = ? AND setting_key = 'context_restart_gate'",
                (agent_id,),
            ).fetchone()
        finally:
            conn.close()
        if row:
            v = json.loads(row[0]).get("thresholdTokens")
            if isinstance(v, (int, float)) and v > 0:
                return int(v)
    except Exception:
        pass
    return DEFAULT_THRESHOLD_TOKENS


def _fetchone(conn, sql, params=()):
    try:
        row = conn.execute(sql, params).fetchone()
        return row
    except Exception:
        return None


def _fetchall(conn, sql, params=()):
    try:
        return conn.execute(sql, params).fetchall()
    except Exception:
        return []


def facts_from_sqlite(conn, agent_id: str) -> dict:
    """The facts the HANDOFF is built from, read from the local SQLite file (a SQLite install). The queries are the
    ones build_handoff always ran; each read fails soft (an unreadable table is an absent fact). The dict is the
    shape facts_from_route() also returns, so render_handoff() cannot tell the two apart:
      {"own": {task_ref,status,summary}|None, "recent": [{agent_id,status,summary}],
       "cards": [{number,title,status}], "last_outgoing": str|None}"""
    own = None
    own_bb = _fetchone(
        conn,
        "SELECT task_ref, status, summary FROM fleet_blackboard WHERE agent_id = ?",
        (agent_id,),
    )
    if own_bb:
        own = {"task_ref": own_bb[0], "status": own_bb[1], "summary": own_bb[2]}

    bb_rows = _fetchall(
        conn,
        "SELECT agent_id, status, summary FROM fleet_blackboard ORDER BY updated_at DESC LIMIT 3",
    )
    recent = [{"agent_id": a, "status": s, "summary": m} for a, s, m in bb_rows]

    open_cards = _fetchall(
        conn,
        """
        SELECT rowid, title, status FROM kanban_cards
        WHERE assignee = ? AND status IN ('in_progress', 'waiting') AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 5
        """,
        (agent_id,),
    )
    cards = [{"number": n, "title": t, "status": s} for n, t, s in open_cards]

    last_out = _fetchone(
        conn,
        "SELECT content FROM agent_messages WHERE from_agent = ? ORDER BY created_at DESC LIMIT 1",
        (agent_id,),
    )
    return {"own": own, "recent": recent, "cards": cards, "last_outgoing": last_out[0] if last_out else None}


def _route_post(path: str, body: dict, agent_id: str, session_id, deadline):
    """One POST under the short shared budget: ONE attempt, no retry. Raises hook_route.RouteError.
    Imported here, not at the top, so a SQLite install never pays the import (urllib) on every tool call."""
    import hook_route  # noqa: E402
    return hook_route.call(
        "POST", path, body, agent_id, deadline,
        session_id=session_id, max_attempts=WATCHDOG_ROUTE_ATTEMPTS,
    )


def _route_call(agent_id: str, session_id, want: str, deadline, extra=None):
    """One call of the watchdog facts route (`want: handoff` or `prior_handoff`)."""
    body = {"want": want}
    if extra:
        body.update(extra)
    return _route_post(WATCHDOG_ROUTE_PATH, body, agent_id, session_id, deadline)


def _route_error(what: str):
    import hook_route  # noqa: E402
    return hook_route.RouteError("watchdog-facts: " + what)


def new_route_deadline():
    """The ONE budget a hook run spends on the route (the threshold call and the handoff call share it)."""
    import hook_route  # noqa: E402
    return hook_route.Deadline(WATCHDOG_ROUTE_DEADLINE_S)


def record_via_route(agent_id: str, session_id, usage, spans, close_stale, deadline) -> int:
    """PG mode: ONE call that carries this PostToolUse's writes (token_usage row, spans, the stale-turn close) and answers
    the restart-gate threshold. A null threshold (no row, no positive number) is DEFAULT_THRESHOLD_TOKENS, the same default
    the SQLite reader falls back to. The writes are best-effort on the server (an invalid item is dropped and counted
    there): this function only needs the threshold. Raises hook_route.RouteError on ANY failure or a malformed answer: the
    caller skips the HANDOFF path, it never guesses a threshold."""
    ans = _route_post(
        WATCHDOG_RECORD_PATH, {"usage": usage, "spans": spans, "close_stale": close_stale},
        agent_id, session_id, deadline,
    )
    if not isinstance(ans, dict) or "threshold_tokens" not in ans:
        raise _route_error("record answer has no threshold_tokens")
    v = ans["threshold_tokens"]
    if v is None:
        return DEFAULT_THRESHOLD_TOKENS
    if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
        raise _route_error("threshold_tokens is not a positive integer")
    return v


def prior_handoff_from_route(agent_id: str, session_id, deadline):
    """PG mode: the caller's own latest 'handoff' audit row of this session (the dedup baseline), as the (ts, reason,
    content_hash) tuple should_emit_handoff reads from SQLite, or None when the route ANSWERS that there is none.
    Raises hook_route.RouteError on ANY failure or a malformed answer: the caller injects nothing. A failed read must
    NOT be treated as "no prior row": that rule makes the hook emit on every tool call."""
    ans = _route_call(agent_id, session_id, "prior_handoff", deadline, extra={"session_id": session_id})
    if ans is None:
        return None
    if not isinstance(ans, dict):
        raise _route_error("prior_handoff answer is not an object or null")
    ts, reason, content_hash = ans.get("ts"), ans.get("reason"), ans.get("content_hash")
    if isinstance(ts, bool) or not isinstance(ts, int) or not _is_text(reason, True) or not _is_text(content_hash, True):
        raise _route_error("prior_handoff row is malformed")
    return (ts, reason, content_hash)


def _is_text(v, nullable=False):
    return (v is None and nullable) or isinstance(v, str)


def facts_from_route(agent_id: str, session_id, deadline) -> dict:
    """PG mode: the HANDOFF facts from the route (`want: handoff`), checked against the shape facts_from_sqlite() makes.
    Raises hook_route.RouteError on ANY failure or a malformed answer (the caller injects nothing and writes no
    audit row). The checks keep a garbled answer out of the text the agent reads as a system message."""
    ans = _route_call(agent_id, session_id, "handoff", deadline)
    if not isinstance(ans, dict):
        raise _route_error("handoff answer is not an object")
    own, recent, cards, last_out = ans.get("own"), ans.get("recent"), ans.get("cards"), ans.get("last_outgoing")
    if own is not None and not (isinstance(own, dict) and _is_text(own.get("task_ref"), True)
                                and _is_text(own.get("status")) and _is_text(own.get("summary"))):
        raise _route_error("handoff own row is malformed")
    if not isinstance(recent, list) or len(recent) > 3 or not all(
            isinstance(r, dict) and _is_text(r.get("agent_id")) and _is_text(r.get("status")) and _is_text(r.get("summary"))
            for r in recent):
        raise _route_error("handoff recent rows are malformed")
    if not isinstance(cards, list) or len(cards) > 5 or not all(
            isinstance(c, dict) and isinstance(c.get("number"), int) and not isinstance(c.get("number"), bool)
            and _is_text(c.get("title")) and _is_text(c.get("status"))
            for c in cards):
        raise _route_error("handoff cards are malformed")
    if not _is_text(last_out, True):
        raise _route_error("handoff last_outgoing is malformed")
    return {
        "own": ({"task_ref": own["task_ref"], "status": own["status"], "summary": own["summary"]} if own else None),
        "recent": [{"agent_id": r["agent_id"], "status": r["status"], "summary": r["summary"]} for r in recent],
        "cards": [{"number": c["number"], "title": c["title"], "status": c["status"]} for c in cards],
        "last_outgoing": last_out,
    }


def render_handoff(facts: dict, pct: float, tokens: int, threshold: int, now=None) -> str:
    """Rolling HANDOFF summary per the phase-3 design report: current task, last blackboard lines, open kanban
    cards, best-guess next step, context%. A PURE function over `facts` (see facts_from_sqlite): identical facts
    give identical text whichever adapter produced them. `now` is a seam for the parity cells."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    lines = [f"[CONTEXT-WATCHDOG HANDOFF -- {now.isoformat(timespec='seconds')}]"]

    own_bb = facts.get("own")
    if own_bb:
        task_ref, status, summary = own_bb["task_ref"], own_bb["status"], own_bb["summary"]
        # The API caps a summary at 500 characters; the clip only matters for a row written another way,
        # and keeps the close-the-row note below inside MAX_HANDOFF_CHARS.
        lines.append(f"Aktualis feladat ({status}): {str(summary)[:HANDOFF_SUMMARY_MAX_CHARS]}" + (f" [kanban {task_ref}]" if task_ref else ""))
        # A restart or a fresh session never closes the row: it stays open (and the stale sweeper
        # marks it stale) until the agent that finishes the work says so. Tell that agent.
        if status in OPEN_BLACKBOARD_STATUSES:
            lines.append(HANDOFF_CLOSE_ROW_NOTE)

    bb_rows = facts.get("recent") or []
    if bb_rows:
        lines.append("Blackboard (utolso 3):")
        for r in bb_rows:
            lines.append(f"  - {r['agent_id']} [{r['status']}]: {r['summary']}")

    open_cards = facts.get("cards") or []
    if open_cards:
        lines.append("Nyitott kartyak:")
        for c in open_cards:
            lines.append(f"  - #{c['number']} [{c['status']}]: {c['title']}")

    last_out = facts.get("last_outgoing")
    if last_out is not None:
        lines.append(f"Kovetkezo lepes (utolso kimeno uzenetbol): {str(last_out)[:300]}")

    lines.append(f"Context hasznalat: {tokens:,} / {threshold:,} tokens ({pct:.0%})")
    lines.append("[/CONTEXT-WATCHDOG HANDOFF]")

    text = "\n".join(lines)
    if len(text) > MAX_HANDOFF_CHARS:
        text = text[:MAX_HANDOFF_CHARS] + "\n... [truncated]\n[/CONTEXT-WATCHDOG HANDOFF]"
    return text


def build_handoff(conn, agent_id: str, pct: float, tokens: int, threshold: int) -> str:
    """The SQLite-install HANDOFF: facts_from_sqlite + render_handoff (the call every SQLite-mode caller and test
    makes). PG mode never reaches this: main() builds the text from facts_from_route()."""
    return render_handoff(facts_from_sqlite(conn, agent_id), pct, tokens, threshold)


def record_handoff_audit(conn, agent_id, session_id, tool_name, pct, content_hash=None) -> None:
    """Audit-trail instrumentation: log every HANDOFF firing into the
    existing hook_audit_log table (no migration for the row shape --
    hook_type stays a true CC event name, 'PostToolUse', matching every
    other row in the table; 'handoff' is a new verdict value alongside the
    existing allow/deny/defer, added to the GET/POST /api/hook-audit route's
    validation sets). This used to also double as phase-4 validation-counter
    instrumentation (reason carried an 'interlock=yes|no' tag, correlated
    against the now-retired context-compact-monitor.sh's 'PreCompact'/allow
    rows by src/watchdog-validation.ts to detect a double-compact) -- that
    counter has served its purpose (the retirement it was validating is
    done) and is retired along with the interlock stamp it depended on, so
    reason now carries only the context%. trigger_source='watchdog'
    (migration 0038) names this row's producer directly, so a coverage audit
    doesn't have to re-derive it from hook_type+verdict. content_hash
    is this row's own emitted HANDOFF's stable-content hash -- see
    should_emit_handoff()/_hash_handoff_text() -- so the NEXT call in this
    session can read it back as its dedup baseline, without any new
    persistent state. The raw session id is also filed as trace_id (the string otel_spans.trace_id holds for that
    session), once it passes gate_audit_lib.clean_session_id; a database that has no trace_id column yet (migration
    0088 not applied) gets the row without it. Never raises -- this is instrumentation, not a gate."""
    try:
        row = (
            int(datetime.datetime.now(datetime.timezone.utc).timestamp()),
            agent_id,
            tool_name,
            content_hash,
            f"ctx={pct:.0%}",
            session_id,
        )
        trace_id = None
        try:
            from gate_audit_lib import clean_session_id
            trace_id = clean_session_id(session_id)
        except Exception:
            trace_id = None  # no usable session id: the row is written without a trace, as before
        tenant = resolve_write_tenant(conn, agent_id)
        written = False
        if trace_id is not None:
            try:
                conn.execute(
                    "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id, trace_id) "
                    "VALUES (?, ?, 'PostToolUse', 'handoff', ?, ?, ?, ?, 'watchdog', ?, ?)",
                    (row[0], row[1], row[2], row[3], row[4], row[5], tenant, trace_id),
                )
                written = True
            except sqlite3.OperationalError as e:
                # No trace_id / tenant_id column yet (this script was deployed before the dashboard applied the
                # migration): fall through to the row as it was before the trace existed. Any other error propagates.
                if "trace_id" not in str(e) and "tenant_id" not in str(e):
                    raise
        if not written:
            _execute_tenant_aware(
                conn,
                "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id) "
                "VALUES (?, ?, 'PostToolUse', 'handoff', ?, ?, ?, ?, 'watchdog', ?)",
                (row[0], row[1], row[2], row[3], row[4], row[5], tenant),
                "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source) "
                "VALUES (?, ?, 'PostToolUse', 'handoff', ?, ?, ?, ?, 'watchdog')",
                row,
            )
        conn.commit()
    except Exception:
        pass


def audit_deadline(deadline):
    """The budget of the audit call: the shared one while it still has WATCHDOG_AUDIT_DEADLINE_S left, else a fresh
    WATCHDOG_AUDIT_DEADLINE_S of its own (see the constant). Never raises: on any doubt the shared one is returned."""
    try:
        if deadline.remaining() >= WATCHDOG_AUDIT_DEADLINE_S:
            return deadline
        import hook_route  # noqa: E402
        return hook_route.Deadline(WATCHDOG_AUDIT_DEADLINE_S)
    except Exception:
        return deadline


def audit_via_route(agent_id, session_id, tool_name, pct, content_hash, deadline) -> bool:
    """PG mode: the audit row of an EMITTED HANDOFF, through the existing POST /api/hook-audit (the agent is the token's;
    the tenant stamp and the trace are the server's). Same row as record_handoff_audit: reason carries the context%, the
    content hash is the next call's dedup baseline. Returns False on any failure and says so with ONE stderr line: the text
    was already injected, the row is missing, the next call may emit again -- the cheapest honest outcome, so it is
    accepted, not retried and not hidden. Never raises."""
    try:
        body = {
            "hook_type": "PostToolUse",
            "verdict": "handoff",
            "tool_name": tool_name,
            "content_hash": content_hash,
            "reason": f"ctx={pct:.0%}",
            "session_id": session_id,
            "trigger_source": "watchdog",
        }
        try:
            from gate_audit_lib import clean_session_id
            trace_id = clean_session_id(session_id)
        except Exception:
            trace_id = None  # no usable session id: the row is written without a trace, as on SQLite
        if trace_id is not None:
            body["trace_id"] = trace_id
        _route_post(HOOK_AUDIT_PATH, body, agent_id, session_id, audit_deadline(deadline))
        return True
    except Exception as e:
        try:
            sys.stderr.write("context-watchdog: the HANDOFF audit row was not written (%s); the next call may emit again\n" % type(e).__name__)
        except Exception:
            pass
        return False


def _hash_handoff_text(text: str) -> str:
    """Stable-content hash of a HANDOFF body for the dedup rule 4 check: sha1
    over the text with the two lines that change on every single call
    (the header's ISO timestamp, and the 'Context hasznalat: N / M (P%)'
    line -- tokens/pct climb on nearly every tool call even within the same
    10-point band) stripped out first, so the hash reflects an actual
    change in the SUMMARIZED content (task/blackboard/kanban/last message),
    not the clock. First 8 hex chars -- collision risk is irrelevant here,
    this only gates a rate-limited, best-effort re-emit, never a gate."""
    kept = [
        line for line in text.split("\n")
        if not line.startswith("[CONTEXT-WATCHDOG HANDOFF --")
        and not line.startswith("Context hasznalat:")
    ]
    return hashlib.sha1("\n".join(kept).encode("utf-8")).hexdigest()[:8]


_PREV_PCT_RE = re.compile(r"ctx=(\d+)%")


def _pct_band(pct_points: int) -> int:
    """60/70/80/90 decade steps, but >=95 is its own band distinct from the
    rest of the 90s (a 95%+ re-emit is wanted even without a
    full band change or a 5-point drop, since it is the last stop before the
    restart-gate's own 100% trigger)."""
    if pct_points >= 95:
        return 95
    return (pct_points // 10) * 10


def should_emit_handoff(conn, agent_id, session_id, pct, now_ts, build_text):
    """HANDOFF dedup gate: decide whether this PostToolUse call should actually
    emit a HANDOFF (and log an audit row), or silently skip. Never called
    below CONTEXT_PCT_THRESHOLD -- the caller only invokes this once pct is
    already >=60% and the call is not from a sub-agent.

    EMIT when ANY of:
    1. no prior 'handoff' row for this (agent_id, session_id) -- first crossing.
    2. the pct band changed vs the prior row's pct (see _pct_band) -- covers
       both a genuine climb into a new decade AND a drop back to a lower band,
       which only happens after a compact/restart (pct otherwise only rises).
    3. pct dropped by >=5 points vs the prior row while STAYING in the same
       band -- a same-band reset (e.g. compact took it from 68% to 61%).
    4. the content actually changed (a fresh build_text() hashes differently
       from the prior row's content_hash) AND enough time elapsed since the
       prior emit (300s normally, 60s once pct>=90% -- the last stretch
       before the gate's own trigger deserves tighter freshness).
    Otherwise: SKIP.

    build_text is a zero-arg callable (build_handoff() bound to this call's
    args) -- invoked ONLY when rules 1-3 don't already decide, since it costs
    a handful of extra local SQL reads purely to evaluate rule 4.

    On a failure reading the previous row: fail OPEN (EMIT) -- _fetchone()
    already swallows the exception and returns None, which the "no prior
    row" branch below treats as a first crossing; this hook is
    logging-category and freshness wins over cost (see module docstring).

    Returns (should_emit: bool, text: str | None, content_hash: str | None).
    text/content_hash are non-None only when this function itself had to
    build the text (the rule-4 path) -- the caller reuses it to avoid a
    second, redundant build_handoff() call; both are None when the caller
    still needs to build the text itself (the rule 1-3 EMIT paths, and the
    fail-open path)."""
    prev = _fetchone(
        conn,
        "SELECT ts, reason, content_hash FROM hook_audit_log "
        "WHERE agent_id = ? AND session_id = ? AND verdict = 'handoff' "
        "ORDER BY ts DESC, id DESC LIMIT 1",
        (agent_id, session_id),
    )
    return decide_emit(prev, pct, now_ts, build_text)


def decide_emit(prev, pct, now_ts, build_text):
    """The dedup decision over a prior-row tuple (ts, reason, content_hash) or None, the same rules for both modes:
    SQLite reads `prev` from hook_audit_log (should_emit_handoff), PG mode from the route's prior_handoff answer.
    None here means "no prior row" and EMITS: a caller whose read FAILED must not call this with None (PG mode raises
    before it gets here, see prior_handoff_from_route)."""
    cur_band = _pct_band(int(round(pct * 100)))
    if prev is None:
        return True, None, None

    prev_ts, prev_reason, prev_hash = prev
    m = _PREV_PCT_RE.search(prev_reason or "")
    if m is None:
        return True, None, None
    prev_pct = int(m.group(1)) / 100.0

    if cur_band != _pct_band(int(round(prev_pct * 100))):
        return True, None, None

    if (prev_pct - pct) >= 0.05:
        return True, None, None

    text = build_text()
    content_hash = _hash_handoff_text(text)
    if content_hash == prev_hash:
        return False, None, None

    min_gap_s = 60 if pct >= 0.90 else 300
    if (now_ts - (prev_ts or 0)) >= min_gap_s:
        return True, text, content_hash

    return False, None, None


def emit_handoff(text: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": text,
        }
    }, ensure_ascii=False))
    sys.stdout.flush()


def main_pg(agent_id, session_id, transcript_path, tool_name, cc_subagent_uuid, ev, tokens) -> None:
    """PostgreSQL mode, one PostToolUse call: NO sqlite3, no tenant resolution, no tenant_context_lib. ONE record call
    (usage row, spans, stale-turn close; answers the threshold), and only past CONTEXT_PCT_THRESHOLD for a top-level
    session: the dedup read, the decision, the facts, the injection, the audit row. One shared short deadline, one
    attempt per call, no retry, fail silent. See the module docstring for the failure ladder. Never raises."""
    try:
        deadline = new_route_deadline()

        usage = build_usage(session_id, ev, tool_name)
        spans = []
        close_stale = None
        turn_span_id = None
        ev_ts = _parse_ts(ev.get("timestamp"))
        if ev_ts is not None:
            turn_ev = find_turn_start_event(transcript_path, before_ts=ev_ts)
            if turn_ev is not None:
                turn_span = build_turn_span(session_id, turn_ev, ev_ts * 1000)
                if turn_span is not None:
                    turn_span_id = turn_span["span_id"]
                    spans.append(turn_span)
                    close_stale = {"trace_id": session_id, "keep_span_id": turn_span_id}
        model_span = build_model_span(session_id, ev, turn_span_id, duration_ms=model_call_duration_ms(transcript_path, ev))
        if model_span is not None:
            spans.append(model_span)

        try:
            threshold = record_via_route(agent_id, session_id, usage, spans, close_stale, deadline)
        except Exception:
            # no threshold, no pct: skip the HANDOFF path for this call (no default guess, no SQLite).
            return
        pct = (tokens / threshold) if threshold > 0 else 0
        # Token/span bookkeeping above runs unconditionally (a sub-agent's tool calls burn real tokens against the same
        # account and still count); only the HANDOFF path is fleet-agent-session-only.
        if pct < CONTEXT_PCT_THRESHOLD or cc_subagent_uuid:
            return
        now_ts = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
        build_text = lambda: render_handoff(facts_from_route(agent_id, session_id, deadline), pct, tokens, threshold)  # noqa: E731
        # The dedup read must FAIL CLOSED: if the route cannot say what the prior row is, inject nothing. Treating a failed
        # read as "no prior row" would emit on every tool call (decide_emit's None means an ANSWER of null).
        prev = prior_handoff_from_route(agent_id, session_id, deadline)
        should_emit, handoff, content_hash = decide_emit(prev, pct, now_ts, build_text)
        if not should_emit:
            return
        if handoff is None:
            handoff = build_text()
        if content_hash is None:
            content_hash = _hash_handoff_text(handoff)
        emit_handoff(handoff)
        audit_via_route(agent_id, session_id, tool_name, pct, content_hash, deadline)
    except Exception:
        pass  # logging-category hook: never fail the tool call


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = payload.get("cwd") or ""
    agent_id = _known_agent_cwd(cwd)
    if agent_id is None:
        sys.exit(0)

    # Claude Code's OWN "agent_id" payload field -- unrelated to this script's
    # `agent_id` above (a Marveen fleet member's identity, resolved from cwd).
    # This one is the UUID of an Agent-tool-spawned sub-agent (fork,
    # quarantine-reader, general-purpose, ...); it is present ONLY on a
    # PostToolUse event that originates from such a sub-agent's own tool call,
    # and absent for the top-level session's own calls (hooks fire for both,
    # by design -- see Claude Code's hooks/sub-agents docs). A spawned
    # sub-agent shares its parent's cwd, so it is otherwise indistinguishable
    # from the top-level fleet-agent session above -- without this check, a
    # sub-agent's tool call could trigger emit_handoff() below, injecting the
    # PARENT's real blackboard/kanban/message state as fake "system reminder"
    # text into the sub-agent's own isolated, unrelated conversation.
    cc_subagent_uuid = payload.get("agent_id") or None

    session_id = payload.get("session_id") or ""
    transcript_path = payload.get("transcript_path") or ""
    tool_name = payload.get("tool_name") or None
    if not session_id or not transcript_path:
        sys.exit(0)

    ev = latest_usage_event(transcript_path)
    if ev is None:
        sys.exit(0)

    usage = (ev.get("message") or {}).get("usage") or {}
    tokens = context_tokens(usage)

    # PG mode never reaches the sqlite3.connect below: every read and write is the dashboard's (see main_pg and the
    # module docstring). Decided FIRST, so a stale SQLite file is not even opened.
    if hook_pg_mode.pg_mode():
        main_pg(agent_id, session_id, transcript_path, tool_name, cc_subagent_uuid, ev, tokens)
        sys.exit(0)
    if hook_pg_mode.store_marker_present():
        # a rule drift: the marker says PostgreSQL, the stale SQLite file is not opened (P-E); the telemetry is dropped
        sys.stderr.write("context-watchdog: the PostgreSQL install marker (store/.pg-installed) is present; the SQLite file is not opened\n")
        sys.exit(0)

    try:
        conn = sqlite3.connect(ledger_lib.db_path(), timeout=5)
        conn.execute("PRAGMA busy_timeout=5000")
    except Exception:
        sys.exit(0)

    try:
        write_token_row(conn, agent_id, session_id, ev, tool_name)

        # F3 (#800): agent.turn + model.call spans, same PostToolUse call.
        # A missing turn boundary (e.g. transcript truncated past the turn's
        # start) still lets the model.call span through, just without a
        # parent -- best-effort, never blocks token_row/HANDOFF logic below.
        ev_ts = _parse_ts(ev.get("timestamp"))
        turn_span_id = None
        if ev_ts is not None:
            turn_ev = find_turn_start_event(transcript_path, before_ts=ev_ts)
            if turn_ev is not None:
                turn_span_id = write_agent_turn_span(conn, agent_id, session_id, turn_ev, ev_ts * 1000)
                if turn_span_id:
                    close_stale_turn_spans(conn, session_id, turn_span_id)
        write_model_call_span(conn, agent_id, session_id, ev, turn_span_id,
                              duration_ms=model_call_duration_ms(transcript_path, ev))
        conn.commit()

        # SQLite mode: the local reads, as ever (PG mode returned above, main_pg).
        threshold = _read_gate_threshold(agent_id)
        pct = (tokens / threshold) if threshold > 0 else 0
        build_text = lambda: render_handoff(facts_from_sqlite(conn, agent_id), pct, tokens, threshold)  # noqa: E731
        # Token/span bookkeeping above runs unconditionally (a sub-agent's
        # tool calls burn real tokens against the same account and should
        # still count toward CostOps budget tracking); only the HANDOFF path
        # -- additionalContext injection and the audit-log 'handoff' row --
        # is fleet-agent-session-only.
        if pct >= CONTEXT_PCT_THRESHOLD and not cc_subagent_uuid:
            now_ts = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
            should_emit, handoff, content_hash = should_emit_handoff(
                conn, agent_id, session_id, pct, now_ts, build_text,
            )
            if should_emit:
                if handoff is None:
                    handoff = build_text()
                if content_hash is None:
                    content_hash = _hash_handoff_text(handoff)
                emit_handoff(handoff)
                record_handoff_audit(conn, agent_id, session_id, tool_name, pct, content_hash)
    except Exception:
        pass  # logging-category hook: never fail the tool call
    finally:
        conn.close()

    sys.exit(0)


if __name__ == "__main__":
    main()
