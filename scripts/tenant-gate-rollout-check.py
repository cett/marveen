#!/usr/bin/env python3
"""Read-only rollout check for the tenant skill gate (tenant-context.py + tenant-skill-gate.py).

Run it BEFORE and AFTER the dashboard restart that wires the hooks into the sub-agents' settings.json:

  python3 scripts/tenant-gate-rollout-check.py            # human report
  python3 scripts/tenant-gate-rollout-check.py --strict   # exit 1 on warnings too
  python3 scripts/tenant-gate-rollout-check.py --json     # machine-readable

Checks (each line is OK, WARN, FAIL or INFO):
  1. migrations 0064 (tenant_channel_bindings) and 0065 (agent_tenant_context) are applied, the tables exist
  2. the hook scripts exist in scripts/hooks
  3. every sub-agent's settings.json carries both hooks in the current form (fail-closed command, gate matcher)
  4. the main agent is NOT gated (it is exempt on purpose)
  5. live evidence per agent: an agent_tenant_context row means the hook ran for that agent (a wired agent
     with no row has not been restarted yet, or has not received a prompt since)
  6. multi-tenant agents (enabled for 2+ tenants) that have no channel binding at all: every source of
     theirs resolves to the default tenant, so no tenant skill is usable for them

The database-side facts (checks 1, 5 and 6) come from the running dashboard, GET /api/admin/tenant-gate-status,
so the dashboard must be up; the rest is read from the files on disk. The dashboard base URL is
MARVEEN_DASHBOARD_BASE, else http://localhost:<WEB_PORT> (environment, then the install's .env, default 3420), and
the bearer token is read from <store>/.dashboard-token (MARVEEN_STORE_DIR overrides the store directory).

Exit code: 0 = no FAIL, 1 = at least one FAIL (or WARN with --strict). Nothing is written anywhere.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.dirname(HERE)
GATE_MATCHER = "Skill|Read|Edit|Write|NotebookEdit|Glob|Grep|Bash"
CONTEXT_SCRIPT = "tenant-context.py"
GATE_SCRIPT = "tenant-skill-gate.py"
LIB_SCRIPT = "tenant_context_lib.py"


def web_port(root):
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(root, ".env")) as f:
                for line in f:
                    m = re.match(r"\s*WEB_PORT\s*=\s*['\"]?([0-9]+)", line)
                    if m:
                        port = m.group(1)
                        break
        except OSError:
            pass
    return port or "3420"


def fetch_status(root, base_url=None):
    """-> (status, None, None) or (None, reason, level). One authenticated GET; nothing is written.

    level is WARN when the dashboard answers but predates the endpoint (the report is then run before the
    restart onto this version, which is the documented first run), FAIL for every other problem."""
    base = (base_url or os.environ.get("MARVEEN_DASHBOARD_BASE") or "http://localhost:%s" % web_port(root)).rstrip("/")
    store = os.environ.get("MARVEEN_STORE_DIR") or os.path.join(root, "store")
    try:
        with open(os.path.join(store, ".dashboard-token")) as f:
            token = f.read().strip()
    except OSError as err:
        return None, "cannot read the dashboard token (%s)" % err, "FAIL"
    req = urllib.request.Request(base + "/api/admin/tenant-gate-status", headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8")), None, None
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None, "%s has no tenant-gate-status endpoint yet (the running dashboard is older than this check); " \
                         "migrations and tenant context are unknown until it is restarted onto this version" % base, "WARN"
        return None, "%s answered %d" % (base, err.code), "FAIL"
    except (urllib.error.URLError, OSError, ValueError) as err:
        return None, "cannot reach %s (%s)" % (base, err), "FAIL"


def main_agent_id(root):
    if os.environ.get("MAIN_AGENT_ID"):
        return os.environ["MAIN_AGENT_ID"]
    try:
        with open(os.path.join(root, ".env")) as f:
            for line in f:
                m = re.match(r"\s*MAIN_AGENT_ID\s*=\s*['\"]?([^'\"\s#]+)", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return ""


def load_settings(path):
    try:
        with open(path) as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, "no settings.json"
    except (OSError, ValueError) as err:
        return None, "unreadable settings.json (%s)" % err


def hook_state(settings):
    """-> (context_wired, gate_wired, gate_matcher_ok, fail_closed_ok)."""
    hooks = (settings or {}).get("hooks") or {}
    ups = json.dumps(hooks.get("UserPromptSubmit") or [])
    gate_entry = None
    for e in hooks.get("PreToolUse") or []:
        if GATE_SCRIPT in json.dumps(e):
            gate_entry = e
    context_wired = CONTEXT_SCRIPT in ups
    gate_wired = gate_entry is not None
    matcher_ok = bool(gate_entry) and gate_entry.get("matcher") == GATE_MATCHER
    blob = ups + json.dumps(gate_entry or {})
    fail_closed = ("command -v python3" in blob and "exit 2" in blob) if (context_wired or gate_wired) else False
    return context_wired, gate_wired, matcher_ok, fail_closed


def check(root, status, status_error=None, status_level="FAIL"):
    """status: the dashboard's tenant-gate-status payload, or None with status_error saying why."""
    results = []  # (level, subject, message)

    def add(level, subject, message):
        results.append({"level": level, "subject": subject, "message": message})

    hooks_dir = os.path.join(root, "scripts", "hooks")
    for name in (CONTEXT_SCRIPT, GATE_SCRIPT, LIB_SCRIPT):
        if os.path.isfile(os.path.join(hooks_dir, name)):
            add("OK", "script", "%s present" % name)
        else:
            add("FAIL", "script", "%s missing in %s (the hook registration would be refused as unsafe)" % (name, hooks_dir))

    if status is None:
        add(status_level, "dashboard", "cannot read the tenant gate status: %s" % status_error)
    else:
        for m in status.get("migrations", []):
            if m.get("applied") and m.get("table_exists"):
                add("OK", "migration", "%04d applied, table %s exists" % (m["version"], m["table"]))
            else:
                add("FAIL", "migration",
                    "%04d not applied or table %s missing: migrate the dashboard first (the prompt hook refuses "
                    "prompts without agent_tenant_context)" % (m["version"], m["table"]))

    agents_dir = os.path.join(root, "agents")
    agents = sorted(d for d in os.listdir(agents_dir) if not d.startswith(".") and os.path.isdir(os.path.join(agents_dir, d))) \
        if os.path.isdir(agents_dir) else []
    wired = []
    main_id = main_agent_id(root)
    for name in agents:
        if name == main_id:
            continue  # the main agent is exempt on purpose, checked separately below
        settings, why = load_settings(os.path.join(agents_dir, name, ".claude", "settings.json"))
        if settings is None:
            add("FAIL", name, why)
            continue
        ctx, gate, matcher_ok, fail_closed = hook_state(settings)
        if ctx and gate and matcher_ok and fail_closed:
            add("OK", name, "both hooks wired (fail-closed form, gate matcher current)")
            wired.append(name)
        elif not ctx and not gate:
            add("FAIL", name, "tenant hooks not wired yet (restart the dashboard: the startup backfill writes them)")
        else:
            missing = [n for n, ok in (("tenant-context", ctx), ("tenant-skill-gate", gate),
                                       ("gate matcher", matcher_ok), ("fail-closed command", fail_closed)) if not ok]
            add("FAIL", name, "half-wired or stale: %s" % ", ".join(missing))

    if main_id:
        settings_paths = [os.path.join(root, ".claude", "settings.json"),
                          os.path.join(os.path.expanduser("~"), ".claude", "settings.json")]
        gated = False
        for p in settings_paths:
            s, _ = load_settings(p)
            ctx, gate, _, _ = hook_state(s)
            gated = gated or ctx or gate
        add("WARN" if gated else "OK", "main agent (%s)" % main_id,
            "is under the tenant gate but is meant to be exempt" if gated else "not gated (exempt on purpose)")
    else:
        add("INFO", "main agent", "MAIN_AGENT_ID not found (env or .env), exemption not checked")

    if status is not None:
        now = int(status.get("now") or 0)
        rows = {r["agent_id"]: r for r in status.get("contexts", [])}
        for name in wired:
            r = rows.get(name)
            if r is None:
                add("INFO", name, "no agent_tenant_context row yet: not restarted, or no prompt since the hooks were wired")
            else:
                add("INFO", name, "hook active: status=%s tenant=%s age=%ds" % (r["status"], r["tenant_id"] or "-", now - int(r["updated_at"] or 0)))
        for r in rows.values():
            if r["status"] in ("unknown", "conflict"):
                add("INFO", r["agent_id"], "current context is %s: tenant skills are denied until its next resolvable prompt" % r["status"])

        multi = status.get("multi_tenant_agents", [])
        for m in multi:
            if m["has_binding"]:
                add("OK", m["agent_id"], "multi-tenant agent (%d tenants) with channel bindings" % m["tenant_count"])
            else:
                add("WARN", m["agent_id"], "multi-tenant agent (%d tenants) with NO channel binding: every source resolves to the "
                                           "default tenant, no tenant skill is usable for it (PUT /api/v1/admin/channel-bindings)"
                    % m["tenant_count"])
        if not multi:
            add("INFO", "tenants", "no agent is enabled for 2+ tenants: the gate has nothing to separate yet")
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=DEFAULT_ROOT, help="project root (default: this checkout)")
    ap.add_argument("--base-url", default=None, help="dashboard base URL (default: MARVEEN_DASHBOARD_BASE or http://localhost:<WEB_PORT>)")
    ap.add_argument("--strict", action="store_true", help="exit 1 on WARN too")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()
    status, status_error, status_level = fetch_status(args.root, args.base_url)
    results = check(args.root, status, status_error, status_level)
    fails = sum(1 for r in results if r["level"] == "FAIL")
    warns = sum(1 for r in results if r["level"] == "WARN")
    if args.json:
        print(json.dumps({"results": results, "fail": fails, "warn": warns}, indent=2))
    else:
        for r in results:
            print("%-5s %-22s %s" % (r["level"], r["subject"], r["message"]))
        print("\n%d FAIL, %d WARN" % (fails, warns))
    sys.exit(1 if fails or (args.strict and warns) else 0)


if __name__ == "__main__":
    main()
