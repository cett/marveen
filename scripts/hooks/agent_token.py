"""Which bearer token a fleet process presents to the dashboard API.

Phase T3: the consumers move from the shared dashboard token (store/.dashboard-token) to the
calling agent's own token (agents/<id>/.agent-token; the main agent's lives in the install root).
Resolution order, always the same:

  1. MARVEEN_AGENT_TOKEN_FILE (explicit file; the test seam and the odd install)
  2. the agent's own token file
  3. FALLBACK: the shared dashboard token. T3 enforces nothing, so a missing own token must not
     turn a working call into a failing one. The fallback is deliberately visible: the request
     carries X-Agent-Id, which the shadow counter files as a self-declared shared-token call
     with a caller, whereas an unmigrated call has no caller at all. T4 removes step 3.
  4. nothing readable: no Authorization header, exactly what a hook sent before when the shared
     token file was missing.

Nothing here raises, prints or logs. The token is returned to the caller for a request header
and is kept out of repr() so a stray log line cannot carry it. Pure stdlib.
"""
import os

AGENT_TOKEN_FILENAME = ".agent-token"
SHARED_TOKEN_FILENAME = ".dashboard-token"
OPERATOR_TOKEN_FILENAME = ".operator-token"

KIND_AGENT = "agent"
KIND_OPERATOR = "operator"
KIND_SHARED = "shared"
KIND_ADMIN = "admin"

SOURCE_AGENT = "agent"
SOURCE_FALLBACK = "shared-fallback"
SOURCE_SHARED = "shared"
SOURCE_OPERATOR = "operator"
SOURCE_NONE = "none"

_ENV_TOKEN_FILE = "MARVEEN_AGENT_TOKEN_FILE"


class Resolved:
    """The outcome of a resolution. `token` is empty when source is SOURCE_NONE."""

    __slots__ = ("token", "source", "agent_id")

    def __init__(self, token, source, agent_id):
        self.token = token
        self.source = source
        self.agent_id = agent_id

    def headers(self, base=None):
        h = dict(base or {})
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        if self.agent_id:
            h["X-Agent-Id"] = self.agent_id
        return h

    def __repr__(self):
        return "Resolved(source=%r, agent_id=%r)" % (self.source, self.agent_id)

    __str__ = __repr__


def install_dir():
    # Hooks live in <install>/scripts/hooks/.
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ""


def main_agent_id(install=None):
    v = os.environ.get("MAIN_AGENT_ID", "").strip()
    if v:
        return v
    for line in _read_lines(os.path.join(install or install_dir(), ".env")):
        if line.startswith("MAIN_AGENT_ID="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def _read_lines(path):
    try:
        with open(path) as f:
            return f.read().splitlines()
    except Exception:
        return []


def agent_id_from_cwd(cwd=None, install=None):
    """<install>/agents/<id>[/...] -> <id>; the install root -> the main agent; anything else
    (a scratch directory, a worktree) -> None, because a directory name is not an identity."""
    install = (install or install_dir()).rstrip("/")
    cwd = (cwd if cwd is not None else os.getcwd()).rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        return cwd[len(agents_root) + 1:].split(os.sep)[0] or None
    if cwd == install:
        return main_agent_id(install)
    return None


def agent_token_path(agent_id, install=None):
    install = install or install_dir()
    if agent_id and agent_id == main_agent_id(install):
        return os.path.join(install, AGENT_TOKEN_FILENAME)
    return os.path.join(install, "agents", agent_id, AGENT_TOKEN_FILENAME)


def resolve(agent_id=None, cwd=None, store_dir=None, install=None, kind=KIND_AGENT):
    """Pick the token for this process. agent_id wins over cwd; with neither, the process cwd
    decides. store_dir is where .dashboard-token lives (default <install>/store).

    kind: KIND_AGENT (default) is the agent's own token with the shared fallback. KIND_OPERATOR is
    the operator's named admin token (store/.operator-token) with the same fallback, for the
    operator scripts. KIND_SHARED is the shared token on purpose, for the endpoints that are still
    admin:all and that a fleet_agent token would be refused on until T4 decides them. KIND_ADMIN is
    for a call that needs admin:all whoever makes it: the main agent's own (admin) token, everybody
    else the shared one."""
    install = install or install_dir()
    store = store_dir or os.path.join(install, "store")
    if not agent_id:
        agent_id = agent_id_from_cwd(cwd, install)
    if agent_id and ("/" in agent_id or agent_id.startswith(".")):
        agent_id = None

    shared = lambda: _read(os.path.join(store, SHARED_TOKEN_FILENAME))
    if kind == KIND_ADMIN:
        kind = KIND_AGENT if agent_id and agent_id == main_agent_id(install) else KIND_SHARED
    if kind == KIND_SHARED:
        t = shared()
        return Resolved(t, SOURCE_SHARED if t else SOURCE_NONE, agent_id)

    if kind == KIND_OPERATOR:
        own, own_source = _read(os.path.join(store, OPERATOR_TOKEN_FILENAME)), SOURCE_OPERATOR
    else:
        explicit = os.environ.get(_ENV_TOKEN_FILE, "").strip()
        own = _read(explicit) if explicit else (_read(agent_token_path(agent_id, install)) if agent_id else "")
        own_source = SOURCE_AGENT
    if own:
        return Resolved(own, own_source, agent_id)

    t = shared()
    if t:
        return Resolved(t, SOURCE_FALLBACK, agent_id)
    return Resolved("", SOURCE_NONE, agent_id)


def auth_headers(base=None, **kwargs):
    """Request headers carrying the resolved token (and X-Agent-Id when the agent is known)."""
    return resolve(**kwargs).headers(base)
