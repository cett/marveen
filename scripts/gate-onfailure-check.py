#!/usr/bin/env python3
"""Read-only check that every PreToolUse gate hook entry carries onFailure:"block".

  python3 scripts/gate-onfailure-check.py            # human report
  python3 scripts/gate-onfailure-check.py --json     # machine-readable

Why: the host counts a hook that times out, does not start or ends with a non-zero exit other than 2 as a
NON-blocking error, so a gate that cannot finish waves the tool call through. `"onFailure": "block"` on the hook
entry makes those cases a deny. The key is accepted by claude 2.1.295 and later (checked against 2.1.310), so an
older binary is a FAIL as well.

Checks (each line is OK, WARN or FAIL):
  1. the installed `claude --version` is at least 2.1.295 (WARN when the binary cannot be run or parsed)
  2. every gate entry in the tracked project settings, in every sub-agent's settings and in the user-level
     settings (~/.claude) has onFailure "block"; one line per settings file

A gate entry is a PreToolUse hook whose command names one of GATE_SCRIPTS (the same list as GATE_HOOK_SCRIPTS in
src/web/agent-scaffold-hooks.ts; a test keeps the two equal). Logging and capture hooks are not gates and need
nothing. tenant-gate-rollout-check.py and doctor.sh run this check.

Exit code: 0 = no FAIL, 1 = at least one FAIL. Nothing is written anywhere.
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.dirname(HERE)
MIN_CLAUDE = (2, 1, 295)
GATE_SCRIPTS = (
    "email-send-gate.mjs",
    "self-pace-gate.mjs",
    "egress-gate.mjs",
    "bash-egress-parser.mjs",
    "destructive-gate.py",
    "auth-admin-gate.py",
    "secret-read-gate.py",
    "email-approval-gate.py",
    "outgoing-copy-gate.py",
    "tenant-skill-gate.py",
)


def is_gate_command(command):
    return any("/" + s in command for s in GATE_SCRIPTS)


def parse_version(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else None


def claude_version():
    """-> (version tuple or None, reason). Never raises."""
    try:
        p = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as err:
        return None, "cannot run `claude --version` (%s)" % type(err).__name__
    v = parse_version(p.stdout)
    return (v, "") if v else (None, "cannot read a version from `claude --version`")


def gates_without_field(settings):
    """-> (gate entries seen, commands of those without onFailure "block")."""
    seen, missing = 0, []
    hooks = (settings or {}).get("hooks")
    ptu = hooks.get("PreToolUse") if isinstance(hooks, dict) else None
    for entry in ptu if isinstance(ptu, list) else []:
        for h in (entry or {}).get("hooks") or []:
            command = (h or {}).get("command")
            if isinstance(command, str) and is_gate_command(command):
                seen += 1
                if h.get("onFailure") != "block":
                    missing.append(command)
    return seen, missing


def _load(path):
    try:
        with open(path) as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, "absent"
    except (OSError, ValueError) as err:
        return None, "unreadable (%s)" % err


def main_agent_id(root):
    """The main agent's id: MAIN_AGENT_ID from the environment, else from root/.env, else the product default."""
    value = os.environ.get("MAIN_AGENT_ID", "").strip()
    if not value:
        try:
            with open(os.path.join(root, ".env")) as f:
                for line in f:
                    if line.startswith("MAIN_AGENT_ID="):
                        value = line.split("=", 1)[1].strip().strip("\"'")
                        break
        except OSError:
            pass
    return value or "marveen"


def check(root, home=None, version=None, version_reason="", main_agent=None):
    """version: the installed claude version tuple, or None with version_reason saying why.
    main_agent: the main agent's id (default: main_agent_id(root)); its agents/<id>/.claude/settings.json is not
    written by the dashboard, so its hint is a hand edit."""
    results = []
    main_agent = main_agent_id(root) if main_agent is None else main_agent

    def add(level, subject, message):
        results.append({"level": level, "subject": subject, "message": message})

    if version is None:
        add("WARN", "claude", "%s: the onFailure support (2.1.295 and later) is not checked" % (version_reason or "version unknown"))
    elif version < MIN_CLAUDE:
        add("FAIL", "claude", "%s is older than %s: onFailure is not honoured (or the settings are refused); update the binary"
            % (".".join(map(str, version)), ".".join(map(str, MIN_CLAUDE))))
    else:
        add("OK", "claude", "%s supports onFailure (>= %s)" % (".".join(map(str, version)), ".".join(map(str, MIN_CLAUDE))))

    files = [("project settings", os.path.join(root, ".claude", "settings.json"))]
    agents_dir = os.path.join(root, "agents")
    if os.path.isdir(agents_dir):
        for name in sorted(os.listdir(agents_dir)):
            p = os.path.join(agents_dir, name, ".claude", "settings.json")
            if not name.startswith(".") and os.path.isfile(p):
                files.append(("agent %s" % name, p))
    home = os.path.expanduser("~") if home is None else home
    files.append(("user settings", os.path.join(home, ".claude", "settings.json")))

    for subject, path in files:
        settings, why = _load(path)
        if settings is None:
            if why == "absent":
                if subject == "project settings":
                    add("FAIL", subject, "%s missing" % path)
                continue  # an agent or user without a settings file has no gate entries to check
            add("FAIL", subject, "%s: %s" % (path, why))
            continue
        seen, missing = gates_without_field(settings)
        if missing:
            if subject == "agent %s" % main_agent:
                fix = ("main agent: not written by the dashboard; add onFailure:block by hand, "
                       "then restart the session")
            elif subject.startswith("agent "):
                fix = "restart the dashboard (the startup backfill writes it), then respawn the agent"
            else:
                fix = "add it by hand: the scaffold never writes this file"
            add("FAIL", subject, "%d of %d gate entries without onFailure \"block\" (%s); %s"
                % (len(missing), seen, "; ".join(re.sub(r"\s+", " ", m)[:60] for m in missing[:3]), fix))
        elif seen:
            add("OK", subject, "%d gate entries, all with onFailure \"block\"" % seen)
        else:
            add("INFO", subject, "no gate entries")
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=DEFAULT_ROOT, help="project root (default: this checkout)")
    ap.add_argument("--home", default=None, help="home directory holding the user-level .claude (default: ~)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()
    version, reason = claude_version()
    results = check(args.root, args.home, version, reason)
    fails = sum(1 for r in results if r["level"] == "FAIL")
    warns = sum(1 for r in results if r["level"] == "WARN")
    if args.json:
        print(json.dumps({"results": results, "fail": fails, "warn": warns}, indent=2))
    else:
        for r in results:
            print("%-5s %-18s %s" % (r["level"], r["subject"], r["message"]))
        print("\n%d FAIL, %d WARN" % (fails, warns))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
