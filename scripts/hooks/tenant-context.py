#!/usr/bin/env python3
"""UserPromptSubmit hook: record which tenant the request the agent is about to serve belongs to.

Resolves the incoming source (chat, inter-agent message, scheduled task) to a tenant through the
database (see tenant_context_lib) and keeps one row per agent in agent_tenant_context. The
use-time skill gate reads that row.

Fail closed, in the only way a prompt hook can: if the new context cannot be written, the old
row (the PREVIOUS request's tenant) must not survive. The hook then tries to invalidate it; if
even that fails it exits 2 so the prompt is refused instead of being served with a stale tenant.

Two backends, the same policy (tenant_context_lib) and the same failure ladder:
  SQLite       the hook reads and writes the database file itself (unchanged).
  PostgreSQL   (hook_pg_mode.pg_mode(): the install is configured for it) the hook has no database driver and does not
               touch the SQLite file, which is stale there. It asks the dashboard for the FACTS of the prompt's sources
               (POST /api/v1/hooks/tenant-facts, one call), decides with the same policy code, and records the
               context through PUT /api/v1/hooks/tenant-context. There is no fallback to SQLite after a route error.
               One shared deadline (hook_route.Deadline, 7.5 s) covers the whole run inside the 10 s harness timeout.
               A prompt with NO source marker at all is the local operator's: it resolves to the default tenant without
               any lookup, so a dashboard outage does not block the operator's plain prompt (the record still goes through the
               route, and if that and the invalidation fail the prompt is refused as before). A prompt WITH a channel,
               inter-agent or scheduled marker needs the dashboard: while the dashboard is down or restarting it is refused
               (exit 2) rather than served with a tenant nobody verified.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hook_pg_mode  # noqa: E402
import ledger_lib  # noqa: E402
import tenant_context_lib as tcl  # noqa: E402


def run_pg(agent_id, prompt, session_id):
    """PostgreSQL mode: facts from the dashboard, the same policy, the record through the dashboard. Exits."""
    import hook_route  # noqa: E402  (only this mode needs the client)
    deadline = hook_route.Deadline()

    def fetch(requested):
        return hook_route.call("POST", "/api/v1/hooks/tenant-facts", {"sources": requested}, agent_id, deadline, session_id)

    def record(status, tenant, source):
        hook_route.call("PUT", "/api/v1/hooks/tenant-context",
                        {"status": status, "tenant_id": tenant, "source": source, "session_id": session_id},
                        agent_id, deadline, session_id)

    try:
        facts = tcl.prefetch_facts(agent_id, prompt, fetch)
        status, tenant, source = tcl.resolve_prompt(facts, agent_id, prompt)
        record(status, tenant, source)
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as err:
        sys.stderr.write("tenant-context: could not record the tenant context (%s), invalidating\n" % err)
    try:
        record("unknown", "", "hook-error")
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as err:
        sys.stderr.write(
            "tenant-context: refusing the prompt, the previous tenant context could not be invalidated (%s)\n" % err
        )
        sys.exit(2)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # not a hook payload: nothing to record
    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    prompt = payload.get("prompt") or ""
    session_id = str(payload.get("session_id") or "")
    if hook_pg_mode.pg_mode():
        run_pg(agent_id, prompt, session_id)
    if hook_pg_mode.store_marker_present():
        # a rule drift: the marker says PostgreSQL, so the SQLite file is not opened here (fail closed, P-E)
        sys.stderr.write("tenant-context: the PostgreSQL install marker (store/.pg-installed) is present; the SQLite file is not read\n")
        sys.exit(2)
    con = None
    try:
        con = tcl.connect(ledger_lib.db_path())
        status, tenant, source = tcl.resolve_prompt(con, agent_id, prompt)
        tcl.write_context(con, agent_id, status, tenant, source, session_id)
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as err:
        sys.stderr.write("tenant-context: could not record the tenant context (%s), invalidating\n" % err)
    # A failed write can leave its transaction (and the write lock) open: release it before the
    # second attempt, or that attempt waits out the busy timeout and fails too.
    try:
        if con is not None:
            con.rollback()
            con.close()
    except Exception:
        pass
    try:
        con = tcl.connect(ledger_lib.db_path())
        tcl.write_context(con, agent_id, "unknown", "", "hook-error", session_id)
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as err:
        sys.stderr.write(
            "tenant-context: refusing the prompt, the previous tenant context could not be invalidated (%s)\n" % err
        )
        sys.exit(2)


if __name__ == "__main__":
    main()
