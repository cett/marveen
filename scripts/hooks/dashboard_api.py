"""Tiny client for the dashboard API, shared by the hooks that write through it
(ledger_lib, skill-sql-sync). Pure stdlib; every call has a short timeout and
raises on failure -- the caller decides whether that is a spool, a warning or a
silent no-op, because a hook must never break the session over a dashboard
that is down.

The port comes from WEB_PORT (env, then <install>/.env, default 3420). The bearer token is the
calling agent's own (agent_token.resolve): its agents/<id>/.agent-token, with X-Agent-Id naming the
caller. When that file is missing the request carries no Authorization header (and so is refused);
the shared token is never used. Test override: DASHBOARD_BASE_URL.
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hook_db_path import db_path  # noqa: E402
import agent_token  # noqa: E402


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


def _headers(agent_id=None, kind=agent_token.KIND_AGENT):
    return agent_token.resolve(agent_id=agent_id, store_dir=store_dir(), kind=kind).headers(
        {"Content-Type": "application/json"})


def traceparent(session_id):
    """A W3C traceparent header value for a request made on behalf of `session_id`, or None. The trace id is the
    one the OTLP exporter derives for that session's spans (sha256 of the session id, first 32 hex), so the
    dashboard's http.server span of a slow or failed request lands in the same trace. Never raises."""
    try:
        if not session_id:
            return None
        import hashlib
        return "00-%s-%s-01" % (hashlib.sha256(str(session_id).encode("utf-8")).hexdigest()[:32], os.urandom(8).hex())
    except Exception:
        return None


def request(method, path, body=None, timeout=2, agent_id=None, kind=agent_token.KIND_AGENT, session_id=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = _headers(agent_id, kind)
    tp = traceparent(session_id)
    if tp:
        headers["traceparent"] = tp
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8") or "null")
