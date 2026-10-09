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

SOURCE_AGENT = "agent"
SOURCE_FALLBACK = "shared-fallback"
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


def resolve(agent_id=None, cwd=None, store_dir=None, install=None):
    """Pick the token for this process. agent_id wins over cwd; with neither, the process cwd
    decides. store_dir is where .dashboard-token lives (default <install>/store)."""
    install = install or install_dir()
    if not agent_id:
        agent_id = agent_id_from_cwd(cwd, install)
    if agent_id and ("/" in agent_id or agent_id.startswith(".")):
        agent_id = None

    explicit = os.environ.get(_ENV_TOKEN_FILE, "").strip()
    own = _read(explicit) if explicit else (_read(agent_token_path(agent_id, install)) if agent_id else "")
    if own:
        return Resolved(own, SOURCE_AGENT, agent_id)

    shared = _read(os.path.join(store_dir or os.path.join(install, "store"), SHARED_TOKEN_FILENAME))
    if shared:
        return Resolved(shared, SOURCE_FALLBACK, agent_id)
    return Resolved("", SOURCE_NONE, agent_id)


def auth_headers(base=None, **kwargs):
    """Request headers carrying the resolved token (and X-Agent-Id when the agent is known)."""
    return resolve(**kwargs).headers(base)
