"""Location of the dashboard database file for the hooks that stay on it.

The tenant gates (tenant-context, tenant-skill-gate) and the context-watchdog
fail closed and must keep working while the dashboard is down, so they read
the database file directly instead of going through the API. This module is
the one place that knows where that file is; ledger_lib re-exports db_path()
for them. Pure stdlib.
"""
import os


def db_path():
    # Hooks live in <install>/scripts/hooks/; the database is <install>/store/.
    # Resolve from THIS file's location so it is correct regardless of the
    # session's cwd. Test override: LEDGER_DB_PATH.
    override = os.environ.get("LEDGER_DB_PATH")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    install = os.path.dirname(os.path.dirname(here))
    return os.path.join(install, "store", "claudeclaw.db")
