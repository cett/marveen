#!/usr/bin/env python3
"""tenant-skill-gate.py -- PreToolUse gate: a tenant's skills are usable only in that tenant's requests.

The tenant of the request being served comes from agent_tenant_context (written by the
UserPromptSubmit hook tenant-context.py). This gate then refuses:
  Skill tool     -> a tenant skill (skills.tenant_id != 'fleet') the active tenant neither owns
                    nor has been granted (skill_tenant_access)
  Read/Edit/Write/NotebookEdit/Glob/Grep -> a path INSIDE such a skill's directory
                    (<..>/.claude/skills/<dir>/... or the <..>/.claude-config/skills/<dir>/... alias,
                    which includes its companion scripts; the path is also resolved through symlinks)
  Bash           -> a command that names such a skill directory (best effort, see below)
Fleet/global skills and everything that is not a tenant skill are never touched, and calls that
cannot involve a skill directory do not even open the database.

Fail closed: no context row, an unknown or conflicting tenant, a stale context (older than
TENANT_CONTEXT_MAX_AGE_SECONDS, default 12h), an unreadable database (for a call that needs it)
or an error in this gate all block the tool call. Contract: exit 0 = allow, exit 2 = block.

KNOWN LIMITS (owner decision: the shell side is best effort): a Bash command can build a path
indirectly (variables, globs over the skills root), and only its absolute and ~ path words are followed
through symlinks (a relative path through an unknown link is not); a Glob/Grep rooted ABOVE the skills
directories is allowed (it would otherwise break every repository-wide search).
"""
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import tenant_context_lib as tcl  # noqa: E402


def block(msg):
    sys.stderr.write("TENANT-SKILL-KAPU: %s\n" % msg)
    sys.exit(2)


def skill_dirs_in(text, cwd, resolve=False):
    """Skill directory names a path/command string points into (best effort).

    resolve=True also follows symlinks (os.path.realpath), so a path that reaches a skill directory through a
    link the textual pattern does not know (an alias onto the global skills root, a custom symlink) is still
    seen. realpath never raises for a missing path; a malformed one (embedded NUL) raises ValueError, which
    main() turns into a block."""
    found = []
    if not text:
        return found
    variants = [text]
    base = None
    if text.startswith("~"):
        base = os.path.expanduser(text)
    elif text.startswith("/"):
        base = text
    elif cwd:
        base = os.path.join(cwd, text)
    if base is not None:
        variants.append(os.path.normpath(base))
        if resolve:
            variants.append(os.path.realpath(base))
    for v in variants:
        if "skills/" not in v:
            continue
        for m in tcl.SKILL_DIR_RX.finditer(v):
            if m.group(1) not in found:
                found.append(m.group(1))
    return found


# Absolute or ~ path words in a shell command (separator and quoting characters end a word).
_BASH_PATH_RX = re.compile(r"(?:^|(?<=[\s'\"=(]))[~/][^\s'\"`;|&<>()$*?\[\]{}\\]*")


def bash_skill_dirs(command):
    """Directory names a shell command points into: the textual match plus symlink-resolved path words."""
    found = skill_dirs_in(command, None)
    for word in _BASH_PATH_RX.findall(command)[:20]:
        for d in skill_dirs_in(word, None, resolve=True):
            if d not in found:
                found.append(d)
    return found


def extract(tool, inp, cwd):
    """-> list of ('skill', name) / ('dir', dirname) targets; empty when the call cannot involve a tenant skill."""
    out = []
    if tool == "Skill":
        name = str(inp.get("skill") or inp.get("name") or "").strip()
        out.append(("skill", name))
    elif tool in ("Read", "Edit", "Write", "NotebookEdit"):
        for k in ("file_path", "notebook_path"):
            out += [("dir", d) for d in skill_dirs_in(str(inp.get(k) or ""), cwd, resolve=True)]
    elif tool in ("Glob", "Grep"):
        for k in ("path", "pattern", "glob"):
            out += [("dir", d) for d in skill_dirs_in(str(inp.get(k) or ""), cwd, resolve=True)]
    elif tool == "Bash":
        out += [("dir", d) for d in bash_skill_dirs(str(inp.get("command") or ""))]
    return out


def main():
    try:
        ev = json.loads(sys.stdin.read())
    except Exception:
        block("a bemenet nem olvashato, ezert BLOKKOL.")
    tool = ev.get("tool_name") or ""
    inp = ev.get("tool_input") or {}
    cwd = ev.get("cwd") or ""
    try:
        targets = extract(tool, inp, cwd)
        if not targets:
            sys.exit(0)
        agent_id = ledger_lib.agent_id_from_cwd(cwd)
        con = sqlite3.connect("file:%s?mode=ro" % ledger_lib.db_path(), uri=True, timeout=3)
        try:
            skills = tcl.load_tenant_skills(con)
            ctx = tcl.read_context(con, agent_id)
            serves = ctx is None or tcl.context_still_serves(con, agent_id, ctx)
        finally:
            con.close()
        tenant, why = tcl.usable_context(ctx)
        if tenant is not None and not serves:
            tenant, why = None, "az agens mar nincs engedelyezve a(z) '%s' tenanthez" % ctx["tenant_id"]
        for kind, value in targets:
            if kind == "skill":
                cands = [s for s in skills if value in s["names"]]
            else:
                cands = [s for s in skills if s["dir"] == value]
            if not cands:
                continue  # fleet/global/plugin skill or not a skill at all
            if tenant is None:
                block("a(z) '%s' tenant-skill nem hasznalhato: %s. Tenant-skill csak a sajat tenantja keresehez tartozik." % (value, why))
            if not any(tcl.skill_accessible(s, tenant) for s in cands):
                block("a(z) '%s' skill masik tenanthez tartozik, ez a keres a(z) '%s' tenanthe. A skill ebben a keresben nem hasznalhato." % (value, tenant))
    except SystemExit:
        raise
    except Exception as exc:
        block("a kapu maga hibara futott (%s: %s), ezert BLOKKOL. Ez a kapu hibaja, nem a tied." % (type(exc).__name__, exc))
    sys.exit(0)


if __name__ == "__main__":
    main()
