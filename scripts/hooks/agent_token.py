"""Which bearer token a fleet process presents to the dashboard API.

Phase T4-5: every consumer presents the calling agent's OWN token (agents/<id>/.agent-token; the main
agent's lives in the install root). The shared dashboard token (store/.dashboard-token) is no longer
read here at all: not as a kind, not as a fallback.
Which agent the process is: an explicit id, else the working directory (<install>/agents/<id>/...,
the install root = the main agent), else what the spawner set in the environment (MARVEEN_AGENT_ID,
or CLAUDE_CONFIG_DIR = <install>/agents/<id>/.claude-config) -- so a hook or script that runs from
a worktree or a scratch directory is still the agent that launched it, not an anonymous caller.
Resolution order for the token, always the same:

  1. MARVEEN_AGENT_TOKEN_FILE (explicit file; the test seam and the odd install)
  2. the agent's own token file
  3. nothing readable: source SOURCE_NONE, an empty token (so no Authorization header) and `error`
     naming the fix. There is NO fallback to the shared token: a missing own token is a fault to
     see, not a call to keep alive. A token that is present but refused (401) is the server's
     business and is never retried on another one.

KIND_ADMIN is for a call that needs the admin role whoever makes it: the main agent uses its own
(admin) token; any other agent gets SOURCE_NONE and an `error` that names the way (ask the main agent
through /api/messages), never a borrowed token.

Nothing here raises, prints or logs. The token is returned to the caller for a request header
and is kept out of repr() so a stray log line cannot carry it. Pure stdlib.
"""
import os

AGENT_TOKEN_FILENAME = ".agent-token"
OPERATOR_TOKEN_FILENAME = ".operator-token"

KIND_AGENT = "agent"
KIND_OPERATOR = "operator"
KIND_ADMIN = "admin"
KIND_MAIN = "main"

SOURCE_AGENT = "agent"
SOURCE_OPERATOR = "operator"
SOURCE_NONE = "none"

_ENV_TOKEN_FILE = "MARVEEN_AGENT_TOKEN_FILE"
_ENV_AGENT_ID = "MARVEEN_AGENT_ID"
_ENV_CONFIG_DIR = "CLAUDE_CONFIG_DIR"


class Resolved:
    """The outcome of a resolution. `token` is empty when source is SOURCE_NONE, and `error` then
    says why and how to fix it (a plain sentence for a log line or an exception; never a token)."""

    __slots__ = ("token", "source", "agent_id", "error")

    def __init__(self, token, source, agent_id, error=None):
        self.token = token
        self.source = source
        self.agent_id = agent_id
        self.error = error

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


def agent_id_from_env(install=None):
    """The identity the spawner gave this process, for a working directory that names nobody (a
    worktree, a scratch directory). MARVEEN_AGENT_ID wins; otherwise CLAUDE_CONFIG_DIR does:
    <install>/agents/<id>/.claude-config is that agent's, <install>/.channels-config the main
    agent's. Both are set when the session is launched, not by where it later `cd`s."""
    v = os.environ.get(_ENV_AGENT_ID, "").strip()
    if v:
        return v
    cfg = os.environ.get(_ENV_CONFIG_DIR, "").strip()
    if not cfg:
        return None
    install = (install or install_dir()).rstrip("/")
    cfg = os.path.normpath(cfg)
    agents_root = os.path.join(install, "agents") + os.sep
    if cfg.startswith(agents_root):
        parts = cfg[len(agents_root):].split(os.sep)
        if len(parts) >= 2 and parts[0] and parts[1] == ".claude-config":
            return parts[0]
        return None
    main_cfg = os.path.join(install, ".channels-config")
    if cfg == main_cfg or cfg.startswith(main_cfg + os.sep):
        return main_agent_id(install)
    return None


def agent_token_path(agent_id, install=None):
    install = install or install_dir()
    if agent_id and agent_id == main_agent_id(install):
        return os.path.join(install, AGENT_TOKEN_FILENAME)
    return os.path.join(install, "agents", agent_id, AGENT_TOKEN_FILENAME)


def missing_token_message(agent_id, install=None):
    """The fix for an agent that has no readable own token file (never contains a token)."""
    if not agent_id:
        return ("cannot tell which agent this is (no agent id from the arguments, the working directory or "
                "MARVEEN_AGENT_ID / CLAUDE_CONFIG_DIR) and so which token file to read; "
                "set MARVEEN_AGENT_ID or run it as the agent")
    return ("no readable own token for agent '%s' (%s); the operator issues it with: npm run agent-tokens -- issue %s"
            % (agent_id, agent_token_path(agent_id, install), agent_id))


ADMIN_ONLY_MESSAGE = ("this call needs admin rights and only the main agent holds them: "
                      "ask the main agent to make it (an inter-agent message through /api/messages)")


def resolve(agent_id=None, cwd=None, store_dir=None, install=None, kind=KIND_AGENT):
    """Pick the token for this process. agent_id wins over cwd; with neither, the process cwd
    decides. store_dir is where .operator-token lives (default <install>/store).

    kind: KIND_AGENT (default) is the agent's own token. KIND_OPERATOR is the operator's named admin
    token (store/.operator-token), for the operator scripts. KIND_ADMIN is for a call that needs
    admin:all whoever makes it: the main agent's own (admin) token; every other agent gets
    SOURCE_NONE and ADMIN_ONLY_MESSAGE. KIND_MAIN acts as the main agent whoever runs it, for the
    system scripts the dashboard or cron runs on the coordinator's behalf (its own admin token).
    There is no fallback to the shared dashboard token: a missing own token resolves to
    SOURCE_NONE with an `error` naming the fix, and nothing here reads store/.dashboard-token."""
    install = install or install_dir()
    store = store_dir or os.path.join(install, "store")
    if not agent_id:
        agent_id = agent_id_from_cwd(cwd, install) or agent_id_from_env(install)
    if agent_id and ("/" in agent_id or agent_id.startswith(".")):
        agent_id = None

    if kind == KIND_MAIN:
        agent_id, kind = main_agent_id(install) or agent_id, KIND_AGENT
    if kind == KIND_ADMIN:
        if not (agent_id and agent_id == main_agent_id(install)):
            return Resolved("", SOURCE_NONE, agent_id, ADMIN_ONLY_MESSAGE)
        kind = KIND_AGENT

    if kind == KIND_OPERATOR:
        own = _read(os.path.join(store, OPERATOR_TOKEN_FILENAME))
        if own:
            return Resolved(own, SOURCE_OPERATOR, agent_id)
        return Resolved("", SOURCE_NONE, agent_id,
                        "no readable operator token (%s); the operator issues it with: npm run agent-tokens -- issue-operator"
                        % os.path.join(store, OPERATOR_TOKEN_FILENAME))

    explicit = os.environ.get(_ENV_TOKEN_FILE, "").strip()
    own = _read(explicit) if explicit else (_read(agent_token_path(agent_id, install)) if agent_id else "")
    if own:
        return Resolved(own, SOURCE_AGENT, agent_id)
    return Resolved("", SOURCE_NONE, agent_id, missing_token_message(agent_id, install))


def auth_headers(base=None, **kwargs):
    """Request headers carrying the resolved token (and X-Agent-Id when the agent is known)."""
    return resolve(**kwargs).headers(base)


def canary_shared_token(store_dir=None, install=None):
    """The shared dashboard token's value, for ONE caller: the go-live gate's canary
    (scripts/token-shadow-gate.py), which makes a single deliberate shared-token call to prove the
    counter is alive. Nothing else may use it; resolve() never returns it. '' when the file is gone
    (after a rotation the canary then has nothing to send and the gate says so)."""
    store = store_dir or os.path.join(install or install_dir(), "store")
    return _read(os.path.join(store, ".dashboard-token"))
