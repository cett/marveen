#!/usr/bin/env python3
"""
PostToolUse hook: sync edited SKILL.md files back to the skills SQL table.

Fires for Edit / Write / MultiEdit calls on paths matching **/skills/**/SKILL.md.
Derives the SQL skill id (inverse of resolveSkillPath in src/web/skill-regen.ts)
and UPSERTs the file's current content into the skills table.

Design invariants:
  - Never breaks the agent: always exits 0.
  - Idempotent: content unchanged -> UPDATE changes=0, no-op.
  - Direct SQLite, not the HTTP API. Skill ids contain '/' which the route regex
    /api/skills/sql/:id ([^/]+) cannot match after URL-path splitting.
  - Reads MAIN_AGENT_ID from .env (default: jarvis).
  - BLOCKS 716-D fleet-wide SQL regen (SKILL_SQL_REGEN kill-switch) from
    clobbering hand-edited SQL rows between startup regens.
"""
import json
import os
import sqlite3
import sys
import time

MARVEEN_ROOT = "/Users/jonasgergo/marveen"
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


def _upsert_skill(skill_id: str, name: str, content: str) -> None:
    now = int(time.time())
    is_global = 1 if skill_id.startswith("global/") else 0
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
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
        sys.exit(0)

    try:
        with open(file_path) as f:
            content = f.read()
    except OSError:
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
