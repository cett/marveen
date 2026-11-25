"""Is this install configured for PostgreSQL? The hook side of the one rule.

The same four layers as scripts/pg-configured.sh (the shell reference) and, for the URL, src/db/pg/url.ts +
src/env.ts readEnvFile (the app). TRUE when ANY layer says PostgreSQL:
  1. the secret mount file ${SECRET_MOUNT_DIR:-/run/secrets}/MARVEEN_PG_URL, non-blank after trimming;
  2. the environment variable MARVEEN_PG_URL, non-blank;
  3. the MARVEEN_PG_URL line of the install's .env (CLAUDECLAW_ENV_DIR overrides the directory), parsed the way
     readEnvFile parses it: each line trimmed, comments and lines without '=' skipped, key and value split at the
     FIRST '=' and both trimmed, ONE pair of outer quotes removed, the LAST assignment of the key wins;
  4. the marker MARVEEN_PG_CONFIGURED=1 (the app sets it at start, so a child that cannot read the URL still
     knows). A .env that cannot be read plus the marker is TRUE: doubt means PostgreSQL, because a false SQLite
     answer would make a gate read a stale file.

The parity cell (src/__tests__/hook-pg-mode-parity.test.ts) runs one fixture table through this function, the
app's rule and pg-configured.sh: the three must give the same boolean per row.

The URL is never returned, logged or stored: only a boolean leaves this module. Pure stdlib.
"""
import os

PG_URL_KEY = "MARVEEN_PG_URL"
PG_CONFIGURED_KEY = "MARVEEN_PG_CONFIGURED"


def _install_root():
    # scripts/hooks/hook_pg_mode.py -> <install>
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _read_text(path):
    """The file's text, or None when it cannot be read (missing, unreadable, a directory)."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _strip_one_quote_pair(value):
    # readEnvFile: startsWith + endsWith of the SAME quote, then slice(1, -1). A lone quote character both starts and
    # ends with itself, so it becomes the empty string (the shell reference spells the same case out).
    if len(value) >= 1 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def _dotenv_value(text):
    """The value of MARVEEN_PG_URL in a .env text (the last assignment wins), or '' when there is none."""
    found = ""
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq == -1:
            continue
        key = line[:eq].strip()
        if key != PG_URL_KEY:
            continue
        found = _strip_one_quote_pair(line[eq + 1:].strip())
    return found


def pg_mode(install_root=None):
    """True when the install is configured for PostgreSQL (see the module text). Returns a boolean, never the URL."""
    mount_dir = (os.environ.get("SECRET_MOUNT_DIR") or "/run/secrets").rstrip("/") or "/"
    mounted = _read_text(os.path.join(mount_dir, PG_URL_KEY))
    if mounted is not None and mounted.strip():
        return True

    if (os.environ.get(PG_URL_KEY) or "").strip():
        return True

    env_dir = os.environ.get("CLAUDECLAW_ENV_DIR") or install_root or _install_root()
    dotenv = _read_text(os.path.join(env_dir, ".env"))
    marker = os.environ.get(PG_CONFIGURED_KEY) == "1"
    if dotenv is not None:
        if _dotenv_value(dotenv).strip():
            return True
        return marker
    # the .env cannot be read: the marker decides, and doubt is PostgreSQL
    return marker
