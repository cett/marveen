"""Tiny client for the dashboard API, shared by the hooks that write through it
(ledger_lib, skill-sql-sync). Pure stdlib; every call has a short timeout and
raises on failure -- the caller decides whether that is a spool, a warning or a
silent no-op, because a hook must never break the session over a dashboard
that is down.

The port comes from WEB_PORT (env, then <install>/.env, default 3420) and the
bearer token from <store>/.dashboard-token. Test override: DASHBOARD_BASE_URL.
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hook_db_path import db_path  # noqa: E402


def install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def store_dir():
    # The directory of the database file: that is where the token, the ledger
    # spool and the live-drain marker live (and the single seam tests use).
    return os.path.dirname(db_path())


def _port():
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(install_dir(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        except Exception:
            pass
    return port or "3420"


def base_url():
    return (os.environ.get("DASHBOARD_BASE_URL") or "http://localhost:%s" % _port()).rstrip("/")


def _headers():
    headers = {"Content-Type": "application/json"}
    try:
        with open(os.path.join(store_dir(), ".dashboard-token")) as f:
            token = f.read().strip()
        if token:
            headers["Authorization"] = "Bearer " + token
    except Exception:
        pass
    return headers


def request(method, path, body=None, timeout=2):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers=_headers())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8") or "null")
