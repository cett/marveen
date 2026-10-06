#!/usr/bin/env python3
"""PostToolUse hook: log skill usage to the persistent skill_usage table.

Every captured event carries a `source` (the usage path) and the coarser legacy
`trigger_type` the server stores next to it:

  source       trigger_type  what happened
  skill_tool   tool_call     the Skill tool was invoked
  read_tool    skill_read    Read opened a file inside a skill directory
  bash_read    skill_read    Bash cat/head/tail/sed -n/less/more/bat/nl/awk/grep/rg of a skill file
  bash_script  skill_read    Bash interpreter or ./ run of a skill's scripts/ file
  api_read     skill_read    Bash curl GET of /api/skills/sql/<id> (or its /files)
  slash        tool_call     UserPromptSubmit: the prompt starts with /<name> and <name> is an existing
                             skill directory (built-in commands and unknown names do not count)

A "skill directory" is <anything>/.claude/skills/<name>/ or the same under
.claude-config/ (the config alias the harness gives each agent), i.e. the global,
project-level and agent-local skill roots alike. Only a CONCRETE <name> counts:
the skills root, a glob and a recursive listing name no skill and log nothing.

Not a use (no row): ls/stat/wc/cp/mv/rm/rsync/tar/git, sed -i, tee, redirections,
quoted text (echo "cat .../SKILL.md"), heredoc bodies, curl with a non-GET method
or a body, the /api/skills/sql LIST call. Commands are judged per segment
(&& || ; | newline, $( ) and backticks outside quotes).

Best effort, said plainly: a path built at runtime ($DIR/SKILL.md, a variable in the
skill name, cd into the directory first), a command inside bash -c "..." or a double
quoted $(...), and a path with a space (Bash only) are not seen. A repeat inside 60 s
is deduplicated by the server, not here.

Unlike tool_call_log (pruned every 24 h), skill_usage is never pruned so the
dream-engine can make data-driven suggestions after two or more weeks of data.

Registration: a PostToolUse entry with matcher Skill|Read|Bash and a UserPromptSubmit entry (no
matcher; same script, told apart by the payload) in the tracked project settings (main agent) and
templates/settings.json.template (sub-agents); ensureAgentHooks seeds the UserPromptSubmit entry into
existing sub-agents and ensureSkillUsageMatcher widens an older Skill|Read matcher at startup.
"""
import sys
import os
import re
import json
import shlex
import threading
import time
import urllib.parse
import urllib.request
import urllib.error


def _install_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_install_dir(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_install_dir(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ""


def _main_agent_id() -> str:
    v = os.environ.get("MAIN_AGENT_ID")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "marveen"


def _agent_id_from_cwd(cwd: str) -> str:
    """Derive agent_id from the session working directory.

    <install>/agents/<id>  -> <id>       (sub-agent: agent-name, ...)
    <install>               -> MAIN_AGENT_ID
    """
    cwd = (cwd or "").rstrip("/")
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        seg = rel.split(os.sep)[0]
        return seg if seg else _main_agent_id()
    if cwd == install:
        return _main_agent_id()
    base = os.path.basename(cwd)
    return base if base else _main_agent_id()


# A skill directory name: letters, digits and . _ @ + - only, so globs, $VARs, ~ and quotes never name one.
_NAME = r"[A-Za-z0-9_][A-Za-z0-9_.@+-]*"
_NAME_OK = re.compile(r"^" + _NAME + r"$")
_SKILL_DIR = r"(?:^|/)\.claude(?:-config)?/skills/(" + _NAME + r")"

# Read tool: any file inside a concrete skill directory (SKILL.md, references/, scripts/...).
_READ_RE = re.compile(_SKILL_DIR + r"/.+$")
# Bash word (no whitespace): the skill directory itself or a path below it.
_WORD_RE = re.compile(_SKILL_DIR + r"(/\S*)?$")
_API_RE = re.compile(
    r"/api(?:/v1)?/skills/sql/([^/?#\s]+)(?:/files(?:/[^?#\s]*)?)?(?:[?#].*)?$"
)

SOURCE_TRIGGER = {
    "skill_tool": "tool_call",
    "read_tool": "skill_read",
    "bash_read": "skill_read",
    "bash_script": "skill_read",
    "api_read": "skill_read",
    "slash": "tool_call",
}

_READ_VERBS = {"cat", "head", "tail", "sed", "less", "more", "bat", "nl", "awk", "grep", "rg"}
# grep/rg may be pointed at a skill directory itself (a concrete skill, not the root).
_DIR_OK_VERBS = {"grep", "rg"}
_INTERPRETERS = {"bash", "sh", "zsh", "node", "tsx", "ruby", "perl", "deno", "bun"}
_WRAPPERS = {"env", "time", "exec", "command", "nohup", "npx"}
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_REDIRECT = re.compile(r"^\d*(?:>>?|<|&>>?|>\||>&|<&)")
_REDIRECT_OP_ONLY = re.compile(r"^\d*(?:>>?|<|&>>?|>\||>&|<&)$")
_CURL_DATA_LONG = (
    "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii",
    "--form", "--form-string", "--json", "--upload-file",
)
_MAX_HITS = 5
# Total wall-clock budget for ALL the POSTs of one hook run (see main()).
_POST_BUDGET_SECS = 1.2


def _heredoc_stripped(cmd: str) -> str:
    """Drop heredoc bodies: text fed to a command is data, not a command."""
    out, pending = [], []
    for line in cmd.split("\n"):
        if pending:
            if line.strip() == pending[0]:
                pending.pop(0)
            continue
        out.append(line)
        pending.extend(
            m.group(2) for m in re.finditer(r"(?<!<)<<(?!<)-?\s*(['\"]?)(\w+)\1", line)
        )
    return "\n".join(out)


def _segments(cmd: str) -> list[str]:
    """Split on && || ; | & newline, $( ) and backticks, outside quotes."""
    segs, cur = [], []
    quote = None
    i = 0
    n = len(cmd)
    while i < n:
        c = cmd[i]
        if quote:
            cur.append(c)
            if c == "\\" and quote == '"' and i + 1 < n:
                cur.append(cmd[i + 1])
                i += 1
            elif c == quote:
                quote = None
        elif c == "\\" and i + 1 < n:
            cur.append(c)
            cur.append(cmd[i + 1])
            i += 1
        elif c in "'\"":
            quote = c
            cur.append(c)
        elif c in ";|\n()`" or (
            c == "&" and not (i > 0 and cmd[i - 1] in "<>") and not (i + 1 < n and cmd[i + 1] == ">")
        ):
            segs.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    segs.append("".join(cur))
    return [x for x in (t.strip() for t in segs) if x]


def _tokens(seg: str) -> list[str]:
    try:
        toks = shlex.split(seg)
    except ValueError:
        toks = seg.split()
    out, skip = [], False
    for t in toks:
        if skip:
            skip = False
            continue
        if _REDIRECT.match(t):
            # A bare operator takes the next word as its target; an attached one carries it.
            skip = _REDIRECT_OP_ONLY.match(t) is not None
            continue
        out.append(t)
    return out


def _unwrap(toks: list[str]) -> list[str]:
    """Strip leading VAR=value assignments and transparent wrappers (env, time, npx...)."""
    while toks:
        if _ENV_ASSIGN.match(toks[0]):
            toks = toks[1:]
        elif os.path.basename(toks[0]) in _WRAPPERS:
            toks = toks[1:]
            while toks and toks[0].startswith("-"):
                toks = toks[1:]
        else:
            break
    return toks


def _is_interpreter(verb: str) -> bool:
    return verb in _INTERPRETERS or re.fullmatch(r"python[0-9.]*", verb) is not None


def _read_hit(verb: str, args: list[str]) -> list[str]:
    # sed -i / --in-place rewrites the file: an edit, not a use.
    if verb == "sed" and any(
        a == "--in-place" or a.startswith("--in-place=") or re.match(r"^-[^-]*i", a) for a in args
    ):
        return []
    # awk -i inplace (gawk) rewrites the file, and awk -i <lib> / --include loads code: neither is a read.
    if verb == "awk" and any(a.startswith("-i") or a.startswith("--include") or a.startswith("--in-place") for a in args):
        return []
    names = []
    for a in args:
        m = _WORD_RE.search(a)
        if not m:
            continue
        rest = m.group(2) or ""
        if rest in ("", "/") and verb not in _DIR_OK_VERBS:
            continue
        names.append(m.group(1))
    return names


def _script_hit(args: list[str]) -> list[str]:
    for a in args:
        if a.startswith("-"):
            continue
        m = _WORD_RE.search(a)
        if m and (m.group(2) or "").startswith("/scripts/"):
            return [m.group(1)]
        return []  # the first non-flag argument is the script (or code); nothing else counts
    return []


def _curl_hit(args: list[str]) -> list[str]:
    method, data = None, False
    names = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-X", "--request") and i + 1 < len(args):
            method = args[i + 1]
            i += 2
            continue
        if a.startswith("--request="):
            method = a.split("=", 1)[1]
        elif a.startswith("--") and a.split("=", 1)[0] in _CURL_DATA_LONG:
            data = True
        elif re.fullmatch(r"-[A-Za-z]+", a):
            letters = a[1:]
            if "X" in letters:
                tail = letters.split("X", 1)[1]
                if tail:
                    method = tail
                elif i + 1 < len(args):
                    method = args[i + 1]
                    i += 1
            if any(ch in letters for ch in "dFT"):
                data = True
        elif not a.startswith("-"):
            m = _API_RE.search(a)
            if m:
                last = urllib.parse.unquote(m.group(1)).split("/")[-1]
                if _NAME_OK.match(last):
                    names.append(last)
        i += 1
    if (method or "GET").upper() != "GET" or data:
        return []
    return names


def _bash_hits(command: str) -> list[tuple[str, str]]:
    # Fast exit: a command that names no skills/ path and no skills API cannot hit.
    if "skills/" not in command:
        return []
    hits: list[tuple[str, str]] = []
    for seg in _segments(_heredoc_stripped(command)):
        toks = _unwrap(_tokens(seg))
        if not toks:
            continue
        verb = os.path.basename(toks[0])
        args = toks[1:]
        found: list[tuple[str, str]] = []
        direct = _WORD_RE.search(toks[0])
        if direct and (direct.group(2) or "").startswith("/scripts/"):
            found = [(direct.group(1), "bash_script")]
        elif verb in _READ_VERBS:
            found = [(n, "bash_read") for n in _read_hit(verb, args)]
        elif _is_interpreter(verb):
            found = [(n, "bash_script") for n in _script_hit(args)]
        elif verb == "curl":
            found = [(n, "api_read") for n in _curl_hit(args)]
        for h in found:
            if h not in hits:
                hits.append(h)
    return hits[:_MAX_HITS]


def _classify_all(tool_name: str, tool_input: dict) -> list[tuple[str, str, str]]:
    """Return every (skill_name, trigger_type, source) this tool call is a use of."""
    if tool_name == "Skill":
        skill = (tool_input.get("skill") or "").strip()
        if skill:
            return [(skill, "tool_call", "skill_tool")]
    elif tool_name == "Read":
        path = (tool_input.get("file_path") or "").strip()
        m = _READ_RE.search(path)
        if m:
            return [(m.group(1), "skill_read", "read_tool")]
    elif tool_name == "Bash":
        command = tool_input.get("command") or ""
        if isinstance(command, str):
            return [(n, SOURCE_TRIGGER[src], src) for n, src in _bash_hits(command)]
    return []


def _classify(tool_name: str, tool_input: dict) -> tuple[str, str, str] | None:
    """Return the first (skill_name, trigger_type, source), or None if the event is irrelevant."""
    hits = _classify_all(tool_name, tool_input)
    return hits[0] if hits else None


# Claude Code's own slash commands. A skill directory that happens to share one of these names is NOT what
# the command runs, so the name never counts as a skill use.
_BUILTIN_COMMANDS = {
    "add-dir", "agents", "bug", "clear", "compact", "config", "context", "cost", "doctor", "effort",
    "exit", "export", "fast", "help", "hooks", "ide", "init", "install-github-app", "login", "logout",
    "mcp", "memory", "model", "output-style", "permissions", "plugin", "pr-comments", "privacy-settings",
    "quit", "release-notes", "rename", "resume", "review", "rewind", "status", "statusline",
    "terminal-setup", "theme", "todos", "upgrade", "usage", "vim",
}
_SLASH_RE = re.compile(r"^/(" + _NAME + r")(?=\s|$)")


def _skill_roots(cwd: str, home: str | None = None, install: str | None = None) -> list[str]:
    """Directories a /name can resolve a skill from: global, project-level, agent-local, config alias."""
    home = home if home is not None else os.path.expanduser("~")
    install = install if install is not None else _install_dir()
    roots = [os.path.join(home, ".claude", "skills"), os.path.join(install, ".claude", "skills")]
    if cwd:
        roots.append(os.path.join(cwd, ".claude", "skills"))
        roots.append(os.path.join(cwd, ".claude-config", "skills"))
    return roots


def _classify_prompt(prompt, cwd: str, home: str | None = None, install: str | None = None) -> list[tuple[str, str, str]]:
    """UserPromptSubmit: a prompt that starts with /<name> and names an existing skill is a slash use.

    Not a use: a built-in command (/clear, /help, /rename ...), a name no skill directory carries (this also
    drops plugin-qualified names like /plugin:skill, which have no directory here), a path (/home/x), and
    anything that does not START with the slash (no leading whitespace is tolerated, the harness would not
    treat it as a command either). A slash use maps to trigger_type tool_call: it invokes the skill, like
    the Skill tool does.
    """
    if not isinstance(prompt, str):
        return []
    m = _SLASH_RE.match(prompt)
    if not m:
        return []
    name = m.group(1)
    if name in _BUILTIN_COMMANDS:
        return []
    if not any(os.path.isdir(os.path.join(root, name)) for root in _skill_roots(cwd, home, install)):
        return []
    return [(name, "tool_call", "slash")]


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    session_id = payload.get("session_id") or None
    cwd = payload.get("cwd") or ""

    if not tool_name and "prompt" in payload:
        # UserPromptSubmit carries a prompt and no tool.
        hits = _classify_prompt(payload.get("prompt"), cwd)
    else:
        hits = _classify_all(tool_name, tool_input)
    if not hits:
        sys.exit(0)

    agent_id = _agent_id_from_cwd(cwd)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    # This hook runs on every Bash call and every prompt, so logging must never hold the agent up: all the
    # POSTs share ONE time budget. The work runs in a daemon thread the main thread waits for at most
    # _POST_BUDGET_SECS, then exits whatever the thread is doing (a hung dashboard costs the budget once,
    # not once per hit; the row is simply not written).
    port = _web_port()
    deadline = time.monotonic() + _POST_BUDGET_SECS

    def send_all() -> None:
        for skill_name, trigger_type, source in hits:
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                return
            body = json.dumps({
                "agent_id": agent_id,
                "skill_name": skill_name,
                "trigger_type": trigger_type,
                "session_id": session_id,
                "source": source,
            }).encode()
            try:
                urllib.request.urlopen(
                    urllib.request.Request(
                        f"http://localhost:{port}/api/skill-usage",
                        data=body,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {token}",
                        },
                        method="POST",
                    ),
                    timeout=remaining,
                )
            except Exception:
                pass  # never block the agent

    worker = threading.Thread(target=send_all, daemon=True)
    worker.start()
    worker.join(timeout=_POST_BUDGET_SECS)
    sys.exit(0)


if __name__ == "__main__":
    main()
