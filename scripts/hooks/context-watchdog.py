#!/usr/bin/env python3
"""PostToolUse hook: context watchdog for the main channels agent and the
persistent named fleet sub-agents.

Phase 2: on every tool call, read the newest transcript-JSONL line carrying
`message.usage` for the CURRENT session and write a per-turn row directly
into the token_usage table -- bypassing the batched collectTokenUsage()
sweep (src/web/token-usage.ts, 5-minute interval as of phase 1) so anything
reading token_usage (dashboard, context-compact-monitor.sh,
context-restart-gate) never sees data older than the agent's last tool call.

Phase 3: if the latest turn's context-token estimate reaches
CONTEXT_PCT_THRESHOLD of the restart-gate's configured threshold (proactive
compaction, ahead of both the reactive context-compact-monitor and the
harness's own late-stage /compact), emit a rolling HANDOFF summary via the
hook's `hookSpecificOutput.additionalContext` -- the same injection channel
scripts/hooks/ledger-replay.py and taskstate-replay.py already use, just for
PostToolUse instead of SessionStart. The summary is built entirely from
local SQLite reads (fleet_blackboard, kanban_cards, agent_messages) -- no
HTTP call to the dashboard API, so a stopped/overloaded dashboard process
never adds latency or a failure mode to this hook (the design report this
phase is based on flagged an API call from inside a fail-closed hook as the
main risk: "the watchdog must be an ultra-simple script -- no network, no DB
writes beyond the essentials"). When a HANDOFF is written,
the hook also stamps store/context-compact-state.json's `last_compact` for
this agent to "now" -- context-compact-monitor.sh's own 45-min COOLDOWN_S
gate then skips it, so the watchdog and the heartbeat-driven /compact never
fire back-to-back for the same context spike (the interlock the task asked
for, reusing the monitor's existing cooldown state file instead of adding a
new one). Every HANDOFF firing is also logged as a verdict='handoff' row in
the existing hook_audit_log table (see record_handoff_audit()) -- this is
the validation counter Jonas asked for before phase 4 (retiring
context-compact-monitor.sh) can be considered: 10 HANDOFF cycles need to
land with the interlock actually landing and no double-compact slipping
through before that decision is even on the table.

Scope (phase 4 sub-agent extension): the main channels agent AND every
persistent named fleet sub-agent (agents/<id>/.claude/settings.json) -- each
scaffolded via agent-scaffold.ts's ensureContextWatchdogHook(), one entry per
agent's own settings.json, same absolute-path convention already used for its
other scaffold-managed hooks. Deliberately EXCLUDES the ephemeral
agent-worker.ts pool (workers run from an isolated home outside both
PROJECT_ROOT and agents/<id>, e.g. ~/.<agent>-worker(-fast) -- see
agent-worker.ts): a HANDOFF built from fleet_blackboard/kanban context makes
sense for a persistent fleet member with its own blackboard row and kanban
assignments, but not for a short-lived worker that has neither, and the
compact-interlock stamp is meaningless across multiple concurrent worker
sessions sharing one derived id.

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

Logging-category hook (CLAUDE.md "Hook fail-closed policy" exception, same
as tool-log-capture.py): fail/timeout/crash -> SILENT PASS, exit 0 always.
This is observability + best-effort continuity, not a gate -- it must never
block a tool call. No network calls anywhere in this script.
"""
import sys
import os
import json
import sqlite3
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# Fraction of the restart-gate's configured thresholdTokens (store/
# context-restart-gate.json, default 400_000 -- src/context-restart-gate.ts
# DEFAULT_THRESHOLD_TOKENS) at which this hook proactively injects a HANDOFF.
# Deliberately well below the gate's own 100% trigger and the harness's own
# 90-97% /compact, and below context-compact-monitor.sh's COMPACT_PCT (75)
# and URGENT_PCT (95) -- this fires first, earliest signal wins.
CONTEXT_PCT_THRESHOLD = 0.6
DEFAULT_THRESHOLD_TOKENS = 400_000

# Cap on the injected HANDOFF text so a single tool call can't inject an
# unbounded amount of context (mirrors ledger-replay.py's own byte cap).
MAX_HANDOFF_CHARS = 2000


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


def write_token_row(conn, agent_id, session_id, ev, tool_name) -> bool:
    msg = ev.get("message") or {}
    usage = msg.get("usage") or {}
    ts = _parse_ts(ev.get("timestamp"))
    if ts is None:
        return False

    content_preview = ""
    content = msg.get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                content_preview = str(block["text"])[:200]
                break
    elif isinstance(content, str):
        content_preview = content[:200]

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
            agent_id, session_id, ts,
            int(usage.get("input_tokens") or 0),
            int(usage.get("output_tokens") or 0),
            int(usage.get("cache_read_input_tokens") or 0),
            int(usage.get("cache_creation_input_tokens") or 0),
            # thinking_tokens: the batch collector estimates this from
            # thinking-block char length (token-usage.ts parseJsonlFile). Left
            # at 0 here -- a later batch pass fills it in via the ON CONFLICT
            # branch above once it processes the same line; this hook's job is
            # freshness for the token COUNT, not full field parity.
            0,
            msg.get("model"),
            content_preview or None,
            tool_name,
            tenant_id,
        ),
    )
    conn.commit()
    return True


def _gate_config_path() -> str:
    # Test override, same pattern as ledger_lib.db_path()'s LEDGER_DB_PATH.
    return os.environ.get("CONTEXT_WATCHDOG_GATE_CONFIG") or os.path.join(
        _install_dir(), "store", "context-restart-gate.json")


def _compact_state_path() -> str:
    return os.environ.get("CONTEXT_WATCHDOG_COMPACT_STATE") or os.path.join(
        _install_dir(), "store", "context-compact-state.json")


def _read_gate_threshold(agent_id: str) -> int:
    """Best-effort read of store/context-restart-gate.json's thresholdTokens
    for this agent, falling back to the gate's own default. Any failure
    (missing file, corrupt JSON, missing key) falls back silently -- this is
    a read of an already-fail-closed-guarded config file, not a new gate."""
    path = _gate_config_path()
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
        v = cfg.get(agent_id, {}).get("thresholdTokens")
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


def build_handoff(conn, agent_id: str, pct: float, tokens: int, threshold: int) -> str:
    """Rolling HANDOFF summary per the phase-3 design report: current task,
    last blackboard lines, open kanban cards, best-guess
    next step, context%. Every read is local SQLite -- see module docstring."""
    now_ts = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    lines = [f"[CONTEXT-WATCHDOG HANDOFF -- {datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}]"]

    own_bb = _fetchone(
        conn,
        "SELECT task_ref, status, summary FROM fleet_blackboard WHERE agent_id = ?",
        (agent_id,),
    )
    if own_bb:
        task_ref, status, summary = own_bb
        lines.append(f"Aktualis feladat ({status}): {summary}" + (f" [kanban {task_ref}]" if task_ref else ""))

    bb_rows = _fetchall(
        conn,
        "SELECT agent_id, status, summary FROM fleet_blackboard ORDER BY updated_at DESC LIMIT 3",
    )
    if bb_rows:
        lines.append("Blackboard (utolso 3):")
        for a, status, summary in bb_rows:
            lines.append(f"  - {a} [{status}]: {summary}")

    open_cards = _fetchall(
        conn,
        """
        SELECT rowid, title, status FROM kanban_cards
        WHERE assignee = ? AND status IN ('in_progress', 'waiting') AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 5
        """,
        (agent_id,),
    )
    if open_cards:
        lines.append("Nyitott kartyak:")
        for rowid, title, status in open_cards:
            lines.append(f"  - #{rowid} [{status}]: {title}")

    last_out = _fetchone(
        conn,
        "SELECT content FROM agent_messages WHERE from_agent = ? ORDER BY created_at DESC LIMIT 1",
        (agent_id,),
    )
    if last_out:
        lines.append(f"Kovetkezo lepes (utolso kimeno uzenetbol): {str(last_out[0])[:300]}")

    lines.append(f"Context hasznalat: {tokens:,} / {threshold:,} tokens ({pct:.0%})")
    lines.append("[/CONTEXT-WATCHDOG HANDOFF]")

    text = "\n".join(lines)
    if len(text) > MAX_HANDOFF_CHARS:
        text = text[:MAX_HANDOFF_CHARS] + "\n... [truncated]\n[/CONTEXT-WATCHDOG HANDOFF]"
    return text


def stamp_compact_interlock(agent_id: str) -> bool:
    """Interlock with context-compact-monitor.sh: writing last_compact = now
    into its own state file makes the monitor's 45-min COOLDOWN_S gate skip
    this agent, so a HANDOFF we just wrote doesn't get immediately followed
    by the heartbeat sending its own /compact for the same spike. Same file,
    same field, atomic tmp+rename -- exactly how the monitor writes it
    itself, so a concurrent monitor run sees a consistent file either way.
    Returns whether the stamp actually landed -- the caller records this in
    the handoff's own audit row (reason='...;interlock=yes|no') so the
    validation counter can tell an attempted interlock from a landed one."""
    path = _compact_state_path()
    try:
        try:
            with open(path, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = {}
        state.setdefault(agent_id, {})["last_compact"] = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, path)
        return True
    except Exception:
        return False  # best-effort interlock; a missed stamp just means one extra heartbeat check


def record_handoff_audit(conn, agent_id, session_id, tool_name, pct, interlock_ok) -> None:
    """Validation-counter instrumentation (phase-4 gate, kicsi/small task
    on top of phases 1-3): log every HANDOFF firing into the existing
    hook_audit_log table (no migration for the row shape -- hook_type stays
    a true CC event name, 'PostToolUse', matching every other row in the
    table; 'handoff' is a new verdict value alongside the existing
    allow/deny/defer, added to the GET/POST /api/hook-audit route's
    validation sets). reason carries both the context% and whether the
    compact-monitor interlock stamp landed, e.g. 'ctx=62%;interlock=yes' --
    the counter query correlates this against context-compact-monitor.sh's
    own 'PreCompact'/allow rows (see record_compact_audit() there) to
    detect a double-compact. trigger_source='watchdog' (migration 0038)
    names this row's producer directly, so a coverage audit doesn't have
    to re-derive it from hook_type+verdict. Never raises -- this is
    instrumentation, not a gate."""
    try:
        conn.execute(
            "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, reason, session_id, trigger_source) "
            "VALUES (?, ?, 'PostToolUse', 'handoff', ?, ?, ?, 'watchdog')",
            (
                int(datetime.datetime.now(datetime.timezone.utc).timestamp()),
                agent_id,
                tool_name,
                f"ctx={pct:.0%};interlock={'yes' if interlock_ok else 'no'}",
                session_id,
            ),
        )
        conn.commit()
    except Exception:
        pass


def emit_handoff(text: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": text,
        }
    }, ensure_ascii=False))
    sys.stdout.flush()


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = payload.get("cwd") or ""
    agent_id = _known_agent_cwd(cwd)
    if agent_id is None:
        sys.exit(0)

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

    try:
        conn = sqlite3.connect(ledger_lib.db_path(), timeout=5)
    except Exception:
        sys.exit(0)

    try:
        write_token_row(conn, agent_id, session_id, ev, tool_name)

        threshold = _read_gate_threshold(agent_id)
        pct = (tokens / threshold) if threshold > 0 else 0
        if pct >= CONTEXT_PCT_THRESHOLD:
            handoff = build_handoff(conn, agent_id, pct, tokens, threshold)
            emit_handoff(handoff)
            interlock_ok = stamp_compact_interlock(agent_id)
            record_handoff_audit(conn, agent_id, session_id, tool_name, pct, interlock_ok)
    except Exception:
        pass  # logging-category hook: never fail the tool call
    finally:
        conn.close()

    sys.exit(0)


if __name__ == "__main__":
    main()
