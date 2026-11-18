#!/bin/bash
# Claude Code statusLine command -- and, as a side effect, the fleet's only
# token-free source of truth about the subscription quota.
#
# WHY THIS EXISTS: the owner asked to be warned when the 5-hour or the weekly
# Claude quota runs out. The agent itself cannot report that -- it is the one
# without tokens -- so the warning has to come from outside Claude. Scraping the
# tmux pane for banner wording is guesswork (measured 2026-08-18: the wordings
# closest to the question did not match), but Claude Code hands the statusLine
# command a JSON payload that ALREADY carries the numbers:
#
#   rate_limits.five_hour.{used_percentage,resets_at}
#   rate_limits.seven_day.{used_percentage,resets_at}
#
# (Optional block: present only for subscription accounts, after the first API
# response of a session.) This script stores that block in
# store/.claude-rate-limits.json on every render, costing zero tokens, and
# scripts/limit-monitor.sh -- a plain systemd timer, no Claude involved --
# reads the file and alerts the owner.
#
# Per-plan copy: the global file above holds whoever rendered last, so it cannot
# say which login a number belongs to. The same record (plus config_dir and
# config_dir_source) is therefore also written to
# store/.claude-rate-limits.d/<sha256(realpath(CLAUDE_CONFIG_DIR))[:8]>.json,
# read by src/web/plan-usage-source.ts for the plan-rotation monitor. The id
# rule lives in src/web/plan-config-hash.ts and a test runs this script against it.
#
# Contract: stdin = payload JSON, stdout = one status line. Never fails loudly:
# a broken status line would be visible in every pane forever.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$INSTALL_DIR/store/.claude-rate-limits.json"

PAYLOAD="$(cat)"

printf '%s' "$PAYLOAD" | RL_OUT="$OUT" python3 -c '
import hashlib, json, os, sys, time

out = os.environ["RL_OUT"]
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit(0)

model = (d.get("model") or {}).get("display_name") or ""
cw = d.get("context_window") or {}
used = cw.get("used_percentage")
rl = d.get("rate_limits") or {}

# Persist the quota block for the out-of-Claude monitor. Written only when the
# payload actually carries it: an empty write would look like a fresh, healthy
# reading and would silently disarm the alert.
def write_atomic(path, rec):
    # tmp name carries the pid: several sessions on one plan render at the
    # same time and a shared tmp name would let one clobber the other.
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass

if rl:
    # Which login is this session on? CLAUDE_CONFIG_DIR is how the fleet pins a
    # session to a plan; unset means the default ~/.claude. The source is
    # recorded so a reader never has to guess: "default" can also mean "the
    # statusLine process did not inherit the variable".
    env_dir = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    cfg_source = "env" if env_dir else "default"
    cfg_expanded = os.path.expanduser(env_dir or "~/.claude")
    cfg_dir = os.path.realpath(cfg_expanded)

    rec = {
        "written_at": int(time.time()),
        "session_id": d.get("session_id"),
        "cwd": d.get("cwd"),
        "config_dir": cfg_dir,
        "config_dir_source": cfg_source,
        "rate_limits": rl,
    }
    # Legacy global file: last renderer wins. limit-monitor / dashboard strip
    # keep reading it unchanged (extra keys are ignored by them).
    write_atomic(out, rec)

    # Per-plan file: store/.claude-rate-limits.d/<sha256(realpath dir)[:8]>.json,
    # the same id src/web/plan-config-hash.ts computes (shared fixture). Only
    # when the configured path is absolute after ~ expansion: a relative one
    # would hash differently per working directory and has no stable id.
    # Nothing here ever deletes a file: other sessions own their own files.
    if os.path.isabs(cfg_expanded):
        plan_id = hashlib.sha256(cfg_dir.encode("utf-8")).hexdigest()[:8]
        plan_dir = os.path.join(os.path.dirname(out), ".claude-rate-limits.d")
        try:
            os.makedirs(plan_dir, exist_ok=True)
            write_atomic(os.path.join(plan_dir, plan_id + ".json"), rec)
        except Exception:
            pass

parts = []
if model:
    parts.append(model)
if isinstance(used, (int, float)):
    parts.append("ctx %d%%" % round(used))
for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
    w = rl.get(key) or {}
    p = w.get("used_percentage")
    if isinstance(p, (int, float)):
        parts.append("%s %d%%" % (label, round(p)))
print(" | ".join(parts))
' 2>/dev/null || printf ''
