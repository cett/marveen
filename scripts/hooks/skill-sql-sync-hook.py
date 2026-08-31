#!/usr/bin/env python3
"""
PostToolUse hook: sync SKILL.md file edits back to the SQL skills table.

Fires after Edit, Write, or MultiEdit tool calls. Resolves the edited file
path to a SQL skill id, reads the new content, and upserts it into the
skills table so that the SQL store stays in sync with the file system.

Guarantees:
- Exit 0 always; SQL errors are logged but never block the agent.
- Path-safe: rejects path traversal, non-SKILL.md targets, and paths
  that don't resolve to a known skill base directory.
- Idempotent: INSERT OR REPLACE (upsert) semantics via ON CONFLICT DO UPDATE.
- No infinite loop: writes to SQL only, never back to the file.

ID scheme (must match materialize-skills.ts and skill-regen.ts):
  ~/.claude/skills/<name>/SKILL.md               -> global/<name>   is_global=1
  <project>/.claude/skills/<name>/SKILL.md       -> agent/<MAIN_AGENT_ID>/<name>  is_global=0
  <project>/agents/<id>/.claude/skills/<name>/SKILL.md -> agent/<id>/<name>  is_global=0
  All tenant_id = 'fleet'.
"""
import json
import os
import re
import sqlite3
import sys
import time


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _project_root() -> str:
    """Return the marveen project root, derived from CLAUDE_PROJECT_DIR env
    (set by Claude Code for hooks) or the script's own location as fallback."""
    return os.environ.get(
        'CLAUDE_PROJECT_DIR',
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    )


def _db_path() -> str:
    return os.path.join(_project_root(), 'store', 'claudeclaw.db')


def _env_value(key: str, fallback: str = '') -> str:
    val = os.environ.get(key)
    if val:
        return val
    try:
        with open(os.path.join(_project_root(), '.env')) as f:
            for line in f:
                if line.startswith(f'{key}='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return fallback


def _main_agent_id() -> str:
    return _env_value('MAIN_AGENT_ID', 'marveen')


# ---------------------------------------------------------------------------
# Skill path resolution
# ---------------------------------------------------------------------------

def _safe_name(s: str) -> bool:
    """Allow alphanumeric, hyphen, underscore only - no separators or traversal."""
    return bool(re.match(r'^[a-zA-Z0-9_\-]+$', s)) and 1 <= len(s) <= 128


def _resolve_skill_id(abs_path: str):
    """
    Return (sql_id, skill_name, is_global) or None if not a known skill path.

    Path must end with /SKILL.md and fall under one of the three known base dirs.
    Rejects path traversal and non-alphanumeric segment names.
    """
    norm = os.path.normpath(abs_path)

    # Guard: reject embedded path traversal
    if '..' in norm.split(os.sep):
        return None

    home = os.path.expanduser('~')
    project = _project_root()
    main_agent_id = _main_agent_id()
    agents_base = os.path.join(project, 'agents')

    # 1. ~/.claude/skills/<name>/SKILL.md -> global/<name>
    global_base = os.path.join(home, '.claude', 'skills')
    if norm.startswith(global_base + os.sep):
        rel = norm[len(global_base) + 1:]
        parts = rel.split(os.sep)
        if len(parts) == 2 and parts[1] == 'SKILL.md' and _safe_name(parts[0]):
            return (f'global/{parts[0]}', parts[0], True)

    # 2. <project>/.claude/skills/<name>/SKILL.md -> agent/<MAIN_AGENT_ID>/<name>
    main_base = os.path.join(project, '.claude', 'skills')
    if norm.startswith(main_base + os.sep):
        rel = norm[len(main_base) + 1:]
        parts = rel.split(os.sep)
        if len(parts) == 2 and parts[1] == 'SKILL.md' and _safe_name(parts[0]):
            return (f'agent/{main_agent_id}/{parts[0]}', parts[0], False)

    # 3. <project>/agents/<agentId>/.claude/skills/<name>/SKILL.md
    #    -> agent/<agentId>/<name>
    if norm.startswith(agents_base + os.sep):
        rel = norm[len(agents_base) + 1:]
        parts = rel.split(os.sep)
        # Expected: [agentId, '.claude', 'skills', skillName, 'SKILL.md']
        if (len(parts) == 5
                and parts[1] == '.claude'
                and parts[2] == 'skills'
                and parts[4] == 'SKILL.md'
                and _safe_name(parts[0])
                and _safe_name(parts[3])):
            return (f'agent/{parts[0]}/{parts[3]}', parts[3], False)

    return None


# ---------------------------------------------------------------------------
# SQL upsert
# ---------------------------------------------------------------------------

def _parse_description(content: str) -> str:
    fm = re.search(r'^---\s*\n([\s\S]*?)\n---', content)
    if not fm:
        return ''
    m = re.search(r'^description:\s*(.+)', fm.group(1), re.MULTILINE)
    if not m:
        return ''
    return m.group(1).strip().strip('"').strip("'")[:500]


def _upsert(db_path: str, sql_id: str, name: str, description: str,
            content: str, is_global: bool) -> None:
    now = int(time.time())
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute(
            '''INSERT INTO skills
                 (id, name, description, content, tenant_id, is_global,
                  created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'fleet', ?, NULL, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 content     = excluded.content,
                 description = excluded.description,
                 updated_at  = excluded.updated_at''',
            (sql_id, name, description, content,
             1 if is_global else 0, now, now)
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Hook entry point
# ---------------------------------------------------------------------------

def _extract_paths(payload: dict) -> list:
    paths = []
    tool_input = payload.get('tool_input') or {}
    fp = tool_input.get('file_path')
    if fp:
        paths.append(fp)
    # MultiEdit carries edits[], but file_path is still the top-level key
    return paths


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get('tool_name', '')
    if tool_name not in ('Edit', 'Write', 'MultiEdit'):
        sys.exit(0)

    paths = _extract_paths(payload)
    skill_paths = [
        p for p in paths
        if p.endswith('/SKILL.md') or p.endswith('\\SKILL.md')
    ]
    if not skill_paths:
        sys.exit(0)

    db = _db_path()
    if not os.path.exists(db):
        sys.exit(0)

    for abs_path in skill_paths:
        try:
            result = _resolve_skill_id(abs_path)
            if result is None:
                continue
            sql_id, name, is_global = result
            if not os.path.exists(abs_path):
                continue
            with open(abs_path, 'r', encoding='utf-8') as f:
                content = f.read()
            description = _parse_description(content)
            _upsert(db, sql_id, name, description, content, is_global)
        except Exception as exc:
            sys.stderr.write(f'skill-sql-sync-hook: {abs_path}: {exc}\n')

    sys.exit(0)


if __name__ == '__main__':
    main()
