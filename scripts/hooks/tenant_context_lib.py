"""Resolve the tenant of the request an agent is serving, from the prompt it just received.

Shared by the UserPromptSubmit hook (tenant-context.py, writes the context) and the use-time
skill gate (reads it). Pure stdlib, no node startup.

The tenant is NEVER taken from free text. It comes from a database row that the source proves:
  <channel source=.. chat_id=..>       -> tenant_channel_bindings (agent, channel, chat_id)
  inter-agent delivery frame (msg_id:N) -> agent_messages row N (to_agent must be this agent):
                                          a tenant-stamped message wins, else the binding
                                          (agent, 'inter-agent', from_agent), else default
  <scheduled-task source="scheduled-task:NAME"> -> schedules row (id=NAME, agent=this agent)
  no source marker at all              -> the local operator: default tenant

Only the TOP-LEVEL structure of the prompt is read (tag blocks are consumed whole, so a marker
forged inside a chat message body is never seen as a source). Anything that cannot be identified
or verified is 'unknown'; sources of different tenants in one prompt are 'conflict'. Both mean
"no tenant skills" to the gate, which is the safe direction: a forged extra marker can only
turn a request into unknown/conflict, never widen it.
"""
import os
import re
import sqlite3
import time

DEFAULT_TENANT = "default"

# agent_tenant_context is owned by migration 0065. These hooks never run DDL: a missing table makes the prompt
# hook refuse the prompt and the gate deny (fail closed), it is not created here.

# One alternation, leftmost-first, non-overlapping: a tag block is consumed whole, so tags
# nested inside a chat/peer body are part of that body and never separate sources.
BLOCK_RX = re.compile(
    r'<(channel|trusted-peer|untrusted|scheduled-task)\b([^>]*)>(.*?)</\1>',
    re.DOTALL,
)
# Delivery frame written by the message router / drain endpoint OUTSIDE the wrapped body.
FRAME_RX = re.compile(r'\[Uzenet\b[^\]\n]*?\]')
MSG_ID_RX = re.compile(r'msg_id:(\d+)')
CHANNEL_RX = re.compile(r'^[a-z][a-z0-9_-]{0,31}$')


def _attr(attrs, name):
    m = re.search(r'(?<![\w-])' + name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def channel_name(source):
    """plugin:telegram:telegram -> telegram, plugin:slack-channel:x -> slack-channel."""
    if not source:
        return None
    parts = source.split(":")
    name = parts[1] if parts[0] == "plugin" and len(parts) > 1 else parts[0]
    name = name.lower()
    return name if CHANNEL_RX.match(name) else None


def parse_sources(prompt):
    """List of source dicts found in the top-level structure of the prompt.

    kind: channel | message | scheduled ; a source that is present but unusable has kind
    'unknown' (with a reason).
    """
    sources = []
    frame_parts = []
    pos = 0
    for m in BLOCK_RX.finditer(prompt):
        frame_parts.append(prompt[pos:m.start()])
        pos = m.end()
        tag, attrs = m.group(1), m.group(2)
        if tag == "channel":
            channel = channel_name(_attr(attrs, "source"))
            ext = _attr(attrs, "chat_id")
            if channel and ext:
                sources.append({"kind": "channel", "channel": channel, "external_id": ext})
            else:
                sources.append({"kind": "unknown", "reason": "channel tag without a usable source/chat_id"})
        elif tag == "scheduled-task":
            src = _attr(attrs, "source") or ""
            name = src[len("scheduled-task:"):] if src.startswith("scheduled-task:") else ""
            if name:
                sources.append({"kind": "scheduled", "name": name})
            else:
                sources.append({"kind": "unknown", "reason": "scheduled-task tag without a task name"})
        # trusted-peer / untrusted blocks are message BODIES: only their frame line matters
    frame_parts.append(prompt[pos:])
    frame = "".join(frame_parts)
    for fm in FRAME_RX.finditer(frame):
        idm = MSG_ID_RX.search(fm.group(0))
        if idm:
            sources.append({"kind": "message", "msg_id": int(idm.group(1))})
        else:
            sources.append({"kind": "unknown", "reason": "inter-agent frame without a msg_id"})
    return sources


def _one(con, sql, params):
    try:
        return con.execute(sql, params).fetchone()
    except sqlite3.Error:
        return None


def _binding(con, agent_id, channel, external_id):
    row = _one(
        con,
        "SELECT tenant_id FROM tenant_channel_bindings WHERE agent_id=? AND channel=? AND external_id=?",
        (agent_id, channel, external_id),
    )
    return row[0] if row else None


def _serves(con, agent_id, tenant_id):
    """True iff the agent (still) serves the tenant: the tenant is not disabled and the agent is either its
    main agent or enabled for it in tenant_agent_availability. Same rule as agentServesTenant() in
    src/db/tenant-channel-bindings.ts. A binding, a tenant-stamped message or a tenant-owned task can outlive
    the availability row; an agent disabled for a tenant must not keep resolving to it. Lookup errors count
    as not serving (fail closed)."""
    return _one(
        con,
        "SELECT 1 FROM tenants t WHERE t.id=? AND t.disabled_at IS NULL AND (t.main_agent_id=? OR EXISTS "
        "(SELECT 1 FROM tenant_agent_availability a WHERE a.tenant_id=t.id AND a.agent_id=? AND a.enabled=1))",
        (tenant_id, agent_id, agent_id),
    ) is not None


def _tenant_result(con, agent_id, tenant_id, desc):
    if not tenant_id or tenant_id == DEFAULT_TENANT:
        return ("default", DEFAULT_TENANT, desc)
    if not _serves(con, agent_id, tenant_id):
        return ("unknown", "", desc + " (agent not enabled for tenant %s)" % tenant_id)
    return ("bound", tenant_id, desc)


def resolve_source(con, agent_id, src):
    """-> (status, tenant_id, description) for one source; status is bound|default|unknown."""
    kind = src["kind"]
    if kind == "channel":
        desc = "channel:%s:%s" % (src["channel"], src["external_id"])
        return _tenant_result(con, agent_id, _binding(con, agent_id, src["channel"], src["external_id"]), desc)
    if kind == "message":
        desc = "message:%d" % src["msg_id"]
        row = _one(con, "SELECT to_agent, from_agent, tenant_id FROM agent_messages WHERE id=?", (src["msg_id"],))
        if not row or row[0] != agent_id:
            return ("unknown", "", desc + " (not found or not for this agent)")
        stamped = row[2]
        if stamped and stamped != DEFAULT_TENANT:
            return _tenant_result(con, agent_id, stamped, desc)
        return _tenant_result(con, agent_id, _binding(con, agent_id, "inter-agent", row[1] or ""), desc)
    if kind == "scheduled":
        desc = "scheduled:%s" % src["name"]
        row = _one(con, "SELECT tenant_id FROM schedules WHERE id=? AND agent=?", (src["name"], agent_id))
        if not row:
            return ("unknown", "", desc + " (no such task for this agent)")
        return _tenant_result(con, agent_id, row[0], desc)
    return ("unknown", "", src.get("reason", "unidentified source"))


def resolve_prompt(con, agent_id, prompt):
    """-> (status, tenant_id, source_description) for a whole prompt."""
    sources = parse_sources(prompt or "")
    if not sources:
        return ("default", DEFAULT_TENANT, "local")
    results = [resolve_source(con, agent_id, s) for s in sources]
    desc = ",".join(r[2] for r in results)[:500]
    if any(r[0] == "unknown" for r in results):
        return ("unknown", "", desc)
    tenants = {r[1] for r in results}
    if len(tenants) > 1:
        return ("conflict", "", desc)
    status = "bound" if any(r[0] == "bound" for r in results) else "default"
    return (status, tenants.pop(), desc)


def connect(path):
    con = sqlite3.connect(path, timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    return con


def write_context(con, agent_id, status, tenant_id, source, session_id):
    con.execute(
        "INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (agent_id, tenant_id, status, source, session_id or "", int(time.time())),
    )
    con.commit()


def read_context(con, agent_id):
    """-> dict(status, tenant_id, source, session_id, updated_at), or None when there is no row."""
    row = _one(
        con,
        "SELECT status, tenant_id, source, session_id, updated_at FROM agent_tenant_context WHERE agent_id=?",
        (agent_id,),
    )
    if not row:
        return None
    return {"status": row[0], "tenant_id": row[1], "source": row[2], "session_id": row[3], "updated_at": row[4]}


# ── use-time skill access (read side, used by tenant-skill-gate.py) ─────────────────────────────

FLEET_TENANT = "fleet"
SAFE_SEGMENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
# A skill directory under ANY skill root: <..>/.claude/skills/<dir> (global, project-level, agent-local) or
# <..>/.claude-config/skills/<dir>, the config alias the harness gives each agent (a symlink onto the global
# root). Missing the alias made the gate see no directory there and wave the call through (fail-open).
SKILL_DIR_RX = re.compile(r'(?<![\w.-])\.claude(?:-config)?/skills/([^/\s\'"`;|&<>()$*?\[\]{}\\]+)')
FRONTMATTER_NAME_RX = re.compile(r'\A---\s*\n(.*?)\n---', re.DOTALL)


def skill_dir_name(skill_id):
    """Same mapping as tenantSkillDirName() in src/web/skill-regen.ts."""
    d = re.sub(r'^[.-]+', '', re.sub(r'[^A-Za-z0-9._-]', '-', skill_id or ''))
    return d if SAFE_SEGMENT.match(d) else None


def _frontmatter_name(content):
    m = FRONTMATTER_NAME_RX.match(content or "")
    if not m:
        return None
    nm = re.search(r'^name:\s*(.+?)\s*$', m.group(1), re.MULTILINE)
    return nm.group(1).strip().strip('"\'') if nm else None


def load_tenant_skills(con):
    """Every non-fleet skill: [{id, tenant_id, dir, names(set), granted(set of tenant ids)}].

    Raises sqlite3.Error when the skills table cannot be read (the gate fails closed on that)."""
    rows = con.execute("SELECT id, name, content, tenant_id FROM skills WHERE tenant_id != ?", (FLEET_TENANT,)).fetchall()
    grants = {}
    try:
        for sid, tid in con.execute("SELECT skill_id, tenant_id FROM skill_tenant_access"):
            grants.setdefault(sid, set()).add(tid)
    except sqlite3.Error:
        pass  # no grants table (older schema) = no grants
    out = []
    for sid, name, content, tenant in rows:
        names = {n for n in (name, _frontmatter_name(content), skill_dir_name(sid)) if n}
        out.append({"id": sid, "tenant_id": tenant, "dir": skill_dir_name(sid), "names": names,
                    "granted": grants.get(sid, set())})
    return out


def usable_context(ctx, now=None, max_age=None):
    """-> (tenant_id or None, reason). None = no tenant skill may be used."""
    if ctx is None:
        return None, "nincs rogzitett tenant-kontextus ehhez az agenshez"
    if ctx["status"] not in ("bound", "default") or not ctx["tenant_id"]:
        return None, "a keres tenantja nem azonosithato (%s)" % ctx["status"]
    if max_age is None:
        try:
            max_age = int(os.environ.get("TENANT_CONTEXT_MAX_AGE_SECONDS", "43200"))
        except ValueError:
            max_age = 43200
    age = (now if now is not None else int(time.time())) - int(ctx["updated_at"] or 0)
    if max_age > 0 and age > max_age:
        return None, "a rogzitett tenant-kontextus elavult (%d mp)" % age
    return ctx["tenant_id"], ""


def context_still_serves(con, agent_id, ctx):
    """Re-check, at use time, that a recorded 'bound' context still holds: the agent must still be enabled for
    the tenant. The context row is written once per prompt, so without this a tenant disabled for the agent
    after the prompt would keep being served until the next one. Errors count as not serving."""
    if ctx["status"] != "bound":
        return True
    return _serves(con, agent_id, ctx["tenant_id"])


def skill_accessible(skill, tenant_id):
    return skill["tenant_id"] == tenant_id or tenant_id in skill["granted"]
