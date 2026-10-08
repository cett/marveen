#!/usr/bin/env python3
"""
PostToolUse hook: sync edited SKILL.md files back to the skills SQL table.

Fires for Edit / Write / MultiEdit calls on paths matching **/skills/**/SKILL.md
(and on the companion files next to them). The hook does the file-system half:
it derives the SQL skill id (inverse of resolveSkillPath in
src/web/skill-regen.ts), parses the generated header, reads the file, and sends
the result to POST /api/skill-sync, which does the database half (upsert, the
tenant qualification check, the companion limits).

Design invariants:
  - Never breaks the agent: always exits 0.
  - Idempotent: unchanged content is a no-op write on the server.
  - Needs the dashboard. When it cannot be reached the write-back is lost, so the
    hook says so on stderr AND as additionalContext ("SKILL.md change NOT in DB"),
    so the agent knows the file and the row now differ.
  - Reads MAIN_AGENT_ID from .env (default: jarvis).
  - BLOCKS 716-D fleet-wide SQL regen (SKILL_SQL_REGEN kill-switch) from
    clobbering hand-edited SQL rows between startup regens.
"""
import base64
import json
import os
import re
import sys

# Hooks live in <install>/scripts/hooks/; resolve the install root from THIS
# file's location (same computation as ledger_lib.py's _install_dir()), so it
# is correct regardless of the machine or the session's cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import dashboard_api  # noqa: E402

MARVEEN_ROOT = os.path.dirname(os.path.dirname(_HERE))
AGENTS_BASE_DIR = os.path.join(MARVEEN_ROOT, "agents")
HOME = os.path.expanduser("~")
POST_TIMEOUT = 5

HANDLED_TOOLS = {"Edit", "Write", "MultiEdit"}


def _main_agent_id() -> str:
    env_file = os.path.join(MARVEEN_ROOT, ".env")
    try:
        with open(env_file) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return os.environ.get("MAIN_AGENT_ID", "jarvis")


def _skill_id_from_path(file_path: str) -> "str | None":
    """Inverse of resolveSkillPath (src/web/skill-regen.ts). Returns SQL id or None."""
    p = os.path.normpath(os.path.abspath(file_path))

    if not p.endswith("/SKILL.md"):
        return None

    skill_dir = os.path.dirname(p)           # .../skills/<name>
    name = os.path.basename(skill_dir)        # <name>
    skills_dir = os.path.dirname(skill_dir)   # .../skills

    # Reject path-escape attempts.
    if ".." in name or name.startswith("/"):
        return None

    # global: ~/.claude/skills/<name>/SKILL.md
    global_skills = os.path.normpath(os.path.join(HOME, ".claude", "skills"))
    if os.path.normpath(skills_dir) == global_skills:
        return f"global/{name}"

    # agent/<MAIN_AGENT_ID>/<name>: <MARVEEN_ROOT>/.claude/skills/<name>/SKILL.md
    main_agent_id = _main_agent_id()
    project_skills = os.path.normpath(os.path.join(MARVEEN_ROOT, ".claude", "skills"))
    if os.path.normpath(skills_dir) == project_skills:
        return f"agent/{main_agent_id}/{name}"

    # agent/<agentId>/<name>: <AGENTS_BASE_DIR>/<agentId>/.claude/skills/<name>/SKILL.md
    if os.path.basename(skills_dir) == "skills":
        claude_dir = os.path.dirname(skills_dir)
        if os.path.basename(claude_dir) == ".claude":
            agent_dir = os.path.dirname(claude_dir)
            agent_id = os.path.basename(agent_dir)
            agents_base = os.path.dirname(agent_dir)
            if os.path.normpath(agents_base) == os.path.normpath(AGENTS_BASE_DIR):
                if ".." not in agent_id and agent_id:
                    return f"agent/{agent_id}/{name}"

    return None


GENERATED_MARKER = "<!-- GENERATED from the skills DB"


def _post(payload: dict) -> str:
    """Send one write-back to the dashboard and return the message it logs.
    Raises when the dashboard cannot be reached or rejects the payload."""
    return dashboard_api.request("POST", "/api/skill-sync", payload, timeout=POST_TIMEOUT)["message"]


def read_generated_header(content: str) -> "tuple[str | None, bool] | None":
    """Mirror of readGeneratedHeader (src/skill-header.ts): (id, is_tenant) of the
    marker line, or None when the file carries none."""
    pos = 0
    while pos <= len(content):
        nl = content.find("\n", pos)
        line_end = len(content) if nl == -1 else nl
        if content.startswith(GENERATED_MARKER, pos) and content[pos:line_end].rstrip().endswith("-->"):
            m = re.search(r"\((tenant skill|skill) ([^)\s]+)\)", content[pos:line_end])
            return (m.group(2), m.group(1) == "tenant skill") if m else (None, False)
        if nl == -1:
            break
        pos = nl + 1
    return None


def tenant_dir_name(skill_id: str) -> "str | None":
    """Mirror of tenantSkillDirName (src/web/skill-regen.ts)."""
    d = re.sub(r"[^A-Za-z0-9._-]", "-", skill_id).lstrip(".-")
    return d if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", d or "") else None


def _agent_and_dir_from_path(file_path: str) -> "tuple[str, str] | None":
    """(agentId, skill dir) for <AGENTS_BASE_DIR>/<agentId>/.claude/skills/<dir>/SKILL.md."""
    p = os.path.normpath(os.path.abspath(file_path))
    skill_dir = os.path.dirname(p)
    skills_dir = os.path.dirname(skill_dir)
    claude_dir = os.path.dirname(skills_dir)
    agent_dir = os.path.dirname(claude_dir)
    if (os.path.basename(skills_dir) == "skills" and os.path.basename(claude_dir) == ".claude"
            and os.path.normpath(os.path.dirname(agent_dir)) == os.path.normpath(AGENTS_BASE_DIR)):
        return os.path.basename(agent_dir), os.path.basename(skill_dir)
    return None


def _sync_tenant_skill(file_path: str, content: str, header_id: str) -> str:
    """A generated tenant skill copy was edited: the dashboard updates THAT tenant
    row, never creates rows or falls back to agent/<id>/<dir>. The header is only a
    claim an agent could forge, so the edit is sent only when the file sits where
    regen would put this skill (an agent skills dir, the exact directory name); the
    server then checks that the agent qualifies for the row's tenant (owner or
    granted). Returns a log message."""
    where = _agent_and_dir_from_path(file_path)
    if not where:
        return "tenant header outside an agent skills dir, ignored"
    agent_id, dir_name = where
    if dir_name != tenant_dir_name(header_id):
        return f"tenant header id {header_id} does not match directory {dir_name}, ignored"
    return _post({"kind": "tenant", "header_id": header_id, "agent_id": agent_id,
                  "dir_name": dir_name, "content": content})


MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
_SKIP_SEGMENTS = {"node_modules", "__pycache__", ".git"}


def normalize_skill_rel_path(rel: str) -> "str | None":
    """Mirror of normalizeSkillRelPath (src/skill-files.ts)."""
    if not rel or len(rel) > 200 or re.search(r"[\x00-\x1f\x7f\\]", rel) or rel.startswith("/"):
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts) or rel == "SKILL.md":
        return None
    return rel


def _companion_location(file_path: str) -> "tuple[str, str] | None":
    """(skill dir, posix rel path) when file_path is a non-SKILL.md file inside a
    skill directory (any depth), else None. The skill dir is the nearest ancestor
    that _skill_id_from_path recognizes as a skill location."""
    p = os.path.normpath(os.path.abspath(file_path))
    if os.path.basename(p) == "SKILL.md":
        return None
    d = os.path.dirname(p)
    for _ in range(8):
        if _skill_id_from_path(os.path.join(d, "SKILL.md")):
            rel = os.path.relpath(p, d).replace(os.sep, "/")
            if rel.startswith("../") or set(rel.split("/")) & _SKIP_SEGMENTS:
                return None
            return d, rel
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def _sync_companion_file(file_path: str, skill_dir: str, rel: str) -> str:
    """A companion file (scripts/, references/, ...) of a skill was edited: the
    dashboard stores it in skill_files of the skill's row. Only for a skill that
    already has a row (SKILL.md is what creates rows); for a generated TENANT copy
    the row is the tenant one named in the header, with the same qualification
    check as the SKILL.md path."""
    rel_n = normalize_skill_rel_path(rel)
    if not rel_n:
        return f"companion path {rel!r} not accepted, ignored"
    try:
        st = os.stat(file_path)
        if not os.path.isfile(file_path) or os.path.islink(file_path):
            return "companion is not a regular file, ignored"
        if st.st_size > MAX_SKILL_FILE_BYTES:
            return f"companion {rel_n} over the size limit, ignored"
        with open(file_path, "rb") as f:
            data = f.read()
    except OSError:
        return "companion unreadable, ignored"

    skill_md = os.path.join(skill_dir, "SKILL.md")
    skill_id = _skill_id_from_path(skill_md)
    tenant_agent = None
    try:
        with open(skill_md) as f:
            hdr = read_generated_header(f.read())
    except OSError:
        hdr = None
    if hdr and hdr[1]:
        if not hdr[0]:
            return "tenant header without id, ignored"
        where = _agent_and_dir_from_path(skill_md)
        if not where or where[1] != tenant_dir_name(hdr[0]):
            return "tenant copy location does not match its header, ignored"
        skill_id, tenant_agent = hdr[0], where[0]
    if not skill_id:
        return "not inside a skill directory, ignored"

    payload = {"kind": "companion", "skill_id": skill_id, "rel_path": rel_n,
               "content_base64": base64.b64encode(data).decode("ascii"), "mode": st.st_mode & 0o777}
    if tenant_agent is not None:
        payload["tenant_agent"] = tenant_agent
    return _post(payload)


def _warn_not_synced(what: str, exc: Exception) -> None:
    """The write-back failed (dashboard down, rejected payload): tell the log AND
    the agent, because the file on disk and the row in the database now differ."""
    msg = f"skill-sql-sync: {what} NOT in DB ({exc})"
    print(msg, file=sys.stderr)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": f"{what} was saved to disk but NOT written back to the skills database "
                             f"(dashboard unreachable or rejected it: {exc}). Edit it again once the dashboard is up, "
                             "or the next skill regeneration may overwrite your change.",
    }}))


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name", "")
    if tool_name not in HANDLED_TOOLS:
        sys.exit(0)

    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    skill_id = _skill_id_from_path(file_path)
    if not skill_id:
        loc = _companion_location(file_path)
        if loc:
            try:
                print(f"skill-sql-sync: {_sync_companion_file(file_path, loc[0], loc[1])}", file=sys.stderr)
            except Exception as exc:
                _warn_not_synced(f"The companion file {loc[1]}", exc)
        sys.exit(0)

    try:
        with open(file_path) as f:
            content = f.read()
    except OSError:
        sys.exit(0)

    # A generated TENANT copy maps to its tenant row, not to agent/<id>/<dir>.
    hdr = read_generated_header(content)
    if hdr and hdr[1]:
        try:
            msg = _sync_tenant_skill(file_path, content, hdr[0]) if hdr[0] else "tenant header without id, ignored"
            print(f"skill-sql-sync: {msg}", file=sys.stderr)
        except Exception as exc:
            _warn_not_synced(f"The SKILL.md change of tenant skill {hdr[0]}", exc)
        sys.exit(0)

    try:
        print(f"skill-sql-sync: {_post({'kind': 'skill', 'skill_id': skill_id, 'content': content})}", file=sys.stderr)
    except Exception as exc:
        _warn_not_synced(f"The SKILL.md change of {skill_id}", exc)

    sys.exit(0)


if __name__ == "__main__":
    main()
