"""Is this install configured for PostgreSQL? The hook side of the one rule.

The same layers as scripts/pg-configured.sh (the shell reference: the four configuration layers, then the store marker as the
fifth, in either place) and, for the URL, src/db/pg/url.ts +
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


STORE_MARKER = ".pg-installed"


def store_marker_path(install_root=None):
    """<install>/store/.pg-installed: written once by the PostgreSQL boot, the durable fifth layer (P-E). The install root is
    this file's own (the LEDGER_DB_PATH test override does not move it)."""
    return os.path.join(install_root or _install_root(), "store", STORE_MARKER)


def _marker_present(path):
    """The marker exists. A stat that fails for any other reason than 'absent' counts as present: doubt is PostgreSQL."""
    try:
        os.stat(path)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True


def store_marker_paths(install_root=None):
    """The places the store marker is looked for (P-E, decision 4): <install>/store, and $MARVEEN_STORE_DIR/ when that
    variable is set. EITHER place counts, which only tightens: a process that exports the variable cannot hide the live
    install's marker, and a relocated store (a deployment that sets the variable) does not silently miss the layer."""
    paths = [store_marker_path(install_root)]
    env_store = (os.environ.get("MARVEEN_STORE_DIR") or "").strip()
    if env_store:
        paths.append(os.path.join(env_store, STORE_MARKER))
    return paths


def store_marker_present(install_root=None):
    """The store marker exists in either place (P-E). The SQLite arms of the hooks call this as a second check: a copy of the
    rule that says SQLite while the marker is there is a drift, and the SQLite file is not opened (fail closed)."""
    return any(_marker_present(p) for p in store_marker_paths(install_root))


def pg_mode(install_root=None):
    """True when the install is configured for PostgreSQL: any of the four configuration layers (see the module text), or the
    store marker (either place), which outlives the configuration. Returns a boolean, never the URL or the marker content."""
    if _configured_by_layers(install_root):
        return True
    return store_marker_present(install_root)


def _configured_by_layers(install_root=None):
    """The four configuration layers: secret mount, environment, the install's .env, the app's marker variable."""
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
