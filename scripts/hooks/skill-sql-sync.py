#!/usr/bin/env python3
"""
PostToolUse hook: sync edited SKILL.md files back to the skills SQL table.

Fires for Edit / Write / MultiEdit calls on paths matching **/skills/**/SKILL.md.
Derives the SQL skill id (inverse of resolveSkillPath in src/web/skill-regen.ts)
and UPSERTs the file's current content into the skills table.

Design invariants:
  - Never breaks the agent: always exits 0.
  - Idempotent: content unchanged -> UPDATE changes=0, no-op.
  - Direct SQLite, not the HTTP API. Skill ids contain '/', which the route only
    accepts percent-encoded (global%2F<dir>); going straight to the DB avoids
    depending on the dashboard being up.
  - Reads MAIN_AGENT_ID from .env (default: jarvis).
  - BLOCKS 716-D fleet-wide SQL regen (SKILL_SQL_REGEN kill-switch) from
    clobbering hand-edited SQL rows between startup regens.
"""
import json
import os
import re
import sqlite3
import sys
import time

# Hooks live in <install>/scripts/hooks/; resolve the install root from THIS
# file's location (same computation as ledger_lib.py's _install_dir()), so it
# is correct regardless of the machine or the session's cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
MARVEEN_ROOT = os.path.dirname(os.path.dirname(_HERE))
AGENTS_BASE_DIR = os.path.join(MARVEEN_ROOT, "agents")
HOME = os.path.expanduser("~")
DB_PATH = os.path.join(MARVEEN_ROOT, "store", "claudeclaw.db")

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


def strip_generated_header(content: str) -> str:
    """Mirror of stripGeneratedHeader (src/skill-header.ts): drop the one marker
    line that regen puts after the frontmatter, so the DB row never stores it."""
    pos = 0
    while pos <= len(content):
        nl = content.find("\n", pos)
        line_end = len(content) if nl == -1 else nl
        if content.startswith(GENERATED_MARKER, pos) and content[pos:line_end].rstrip().endswith("-->"):
            if nl == -1:  # header is the last line: also drop the newline before it
                if pos > 0 and content[pos - 1] == "\n":
                    return content[: pos - 1]
                return content[:pos]
            return content[:pos] + content[nl + 1:]
        if nl == -1:
            break
        pos = nl + 1
    return content


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


def _agent_qualifies(conn, skill_id: str, owner_tenant: str, agent_id: str) -> bool:
    """True when the agent has an enabled availability row for the skill's owning
    tenant or for a tenant it is granted to (the recipients regen writes to)."""
    tenants = {owner_tenant} | {r[0] for r in conn.execute(
        "SELECT tenant_id FROM skill_tenant_access WHERE skill_id = ?", (skill_id,))}
    ph = ",".join("?" * len(tenants))
    return conn.execute(
        f"SELECT 1 FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1 AND tenant_id IN ({ph})",
        (agent_id, *sorted(tenants))).fetchone() is not None


def _sync_tenant_skill(file_path: str, content: str, header_id: str) -> str:
    """A generated tenant skill copy was edited: update THAT tenant row, never
    create rows or fall back to agent/<id>/<dir>. The header is only a claim an
    agent could forge, so the edit is applied only when the file sits where regen
    would put this skill: an agent that qualifies for the row's tenant (owner or
    granted) and the exact directory name. Returns a log message."""
    where = _agent_and_dir_from_path(file_path)
    if not where:
        return "tenant header outside an agent skills dir, ignored"
    agent_id, dir_name = where
    if dir_name != tenant_dir_name(header_id):
        return f"tenant header id {header_id} does not match directory {dir_name}, ignored"
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        row = conn.execute("SELECT tenant_id FROM skills WHERE id = ?", (header_id,)).fetchone()
        if not row or row[0] == "fleet":
            return f"no tenant skill {header_id} in the DB, ignored"
        if not _agent_qualifies(conn, header_id, row[0], agent_id):
            return f"agent {agent_id} does not qualify for tenant skill {header_id}, ignored"
        conn.execute("UPDATE skills SET content = ?, updated_at = ? WHERE id = ?",
                     (strip_generated_header(content), int(time.time()), header_id))
        conn.commit()
        return f"updated tenant skill {header_id}"
    finally:
        conn.close()


MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
MAX_SKILL_FILES_PER_SKILL = 200
_SKIP_SEGMENTS = {"node_modules", "__pycache__", ".git"}


def normalize_skill_rel_path(rel: str) -> "str | None":
    """Mirror of normalizeSkillRelPath (src/skill-files.ts)."""
    if not rel or len(rel) > 200 or re.search(r"[\x00-\x1f\x7f\\]", rel) or rel.startswith("/"):
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts) or rel == "SKILL.md":
        return None
    return rel


def sanitize_skill_file_mode(mode: int) -> int:
    """Mirror of sanitizeSkillFileMode: 0755 when any exec bit is set, else 0644."""
    return 0o755 if mode & 0o111 else 0o644


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
    """A companion file (scripts/, references/, ...) of a skill was edited: store
    it in skill_files of the skill's row. Only for a skill that already has a row
    (SKILL.md is what creates rows); for a generated TENANT copy the row is the
    tenant one named in the header, with the same qualification check as the
    SKILL.md path."""
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

    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        row = conn.execute("SELECT tenant_id FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if not row:
            return f"no skill {skill_id} in the DB yet, companion ignored"
        if tenant_agent is not None:
            if row[0] == "fleet" or not _agent_qualifies(conn, skill_id, row[0], tenant_agent):
                return f"agent {tenant_agent} does not qualify for tenant skill {skill_id}, ignored"
        exists = conn.execute("SELECT 1 FROM skill_files WHERE skill_id = ? AND rel_path = ?", (skill_id, rel_n)).fetchone()
        if not exists:
            n = conn.execute("SELECT COUNT(*) FROM skill_files WHERE skill_id = ?", (skill_id,)).fetchone()[0]
            if n >= MAX_SKILL_FILES_PER_SKILL:
                return f"skill {skill_id} already has {n} companion files, ignored"
        now = int(time.time())
        conn.execute(
            """INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(skill_id, rel_path) DO UPDATE SET
                 content = excluded.content, mode = excluded.mode, updated_at = excluded.updated_at""",
            (skill_id, rel_n, data, sanitize_skill_file_mode(st.st_mode), now, now),
        )
        conn.commit()
        return f"stored companion {rel_n} of {skill_id}"
    finally:
        conn.close()


def _upsert_skill(skill_id: str, name: str, content: str) -> None:
    content = strip_generated_header(content)
    now = int(time.time())
    is_global = 1 if skill_id.startswith("global/") else 0
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        cur = conn.execute("SELECT id FROM skills WHERE id = ?", (skill_id,))
        if cur.fetchone():
            conn.execute(
                "UPDATE skills SET content = ?, updated_at = ? WHERE id = ?",
                (content, now, skill_id),
            )
        else:
            conn.execute(
                """INSERT INTO skills
                   (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
                   VALUES (?, ?, '', ?, 'fleet', ?, NULL, ?, ?)""",
                (skill_id, name, content, is_global, now, now),
            )
        conn.commit()
    finally:
        conn.close()


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
                print(f"skill-sql-sync: SQL error for companion {loc[1]}: {exc}", file=sys.stderr)
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
            print(f"skill-sql-sync: SQL error for tenant skill {hdr[0]}: {exc}", file=sys.stderr)
        sys.exit(0)

    name = skill_id.rsplit("/", 1)[-1]

    try:
        _upsert_skill(skill_id, name, content)
        print(f"skill-sql-sync: upserted {skill_id}", file=sys.stderr)
    except Exception as exc:
        print(f"skill-sql-sync: SQL error for {skill_id}: {exc}", file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    main()
