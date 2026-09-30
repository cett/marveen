#!/usr/bin/env python3
"""UserPromptSubmit hook: record which tenant the request the agent is about to serve belongs to.

Resolves the incoming source (chat, inter-agent message, scheduled task) to a tenant through the
database (see tenant_context_lib) and keeps one row per agent in agent_tenant_context. The
use-time skill gate reads that row.

Fail closed, in the only way a prompt hook can: if the new context cannot be written, the old
row (the PREVIOUS request's tenant) must not survive. The hook then tries to invalidate it; if
even that fails it exits 2 so the prompt is refused instead of being served with a stale tenant.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import tenant_context_lib as tcl  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # not a hook payload: nothing to record
    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    prompt = payload.get("prompt") or ""
    session_id = str(payload.get("session_id") or "")
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
