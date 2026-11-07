#!/usr/bin/env python3
"""vitest-janitor: stop orphaned vitest processes, by PID, with narrow rules.

    python3 scripts/vitest-janitor.py [--dry-run]

A killed or timed-out vitest leaves its forked workers behind: parent pid 1, asleep, 0 % CPU, for ever
(scripts/vitest-guard.py prevents that for runs that go through it; this reaps the rest). It is meant to be
run every few minutes as a `type=command` scheduled task.

A candidate is a `node` process whose command line is vitest: it names `/node_modules/vitest/` (a worker or
the main) or is `vitest.mjs run|related` / `vitest run` (the main, or the `npm exec` that started it). Nothing
else is ever looked at: not "every process with parent pid 1" (a machine has hundreds of those), not a name
match with pkill.

Rules, first match wins:
  R1 parent pid 1 and running for at least 2 minutes: an orphan. Kill the pid.
  R2 the install the command line points into (`<root>/node_modules/vitest/`) no longer exists: kill the pid.
  R3 running for at least 2 hours: a run that got away. Kill its process group, but ONLY when every member of
     that group is itself a vitest candidate and the group is not this janitor's own; otherwise kill the
     candidate pids alone (a group shared with a shell or a script would take that down too).
A young process, or one whose parent is alive (another agent's run in progress), is never touched.

Before a kill the pid is read again (same command line and parent, not younger), so a pid that was reused
since the first listing is left alone. TERM, 3 s, KILL; by pid, or by group for R3.

Every kill (and every dry-run finding) is ONE JSON line, appended to <store>/vitest-janitor.jsonl and
printed on stdout; a run that finds nothing prints nothing and writes nothing. (The scheduler's command-task
runner discards stdout, so the file is the record.) Exit 0, or 1 when `ps` itself fails.

--dry-run only lists what it would do. The first run on a machine should be one.

Standard library only, `python3 -I` compatible.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time

ORPHAN_MIN_SECS = 120
RUNAWAY_MIN_SECS = 7200
TERM_GRACE_SECS = 3.0
LOG_MAX_BYTES = 1_000_000
COMMAND_LOG_CHARS = 200

_PS_FIELDS = "pid=,ppid=,pgid=,etime=,command="
_VITEST_DIR = re.compile(r"/node_modules/vitest/")
_VITEST_MAIN = re.compile(r"(?:^|[\s/])vitest(?:\.mjs)?\s+(?:run|related)(?:\s|$)")
_ROOT = re.compile(r"(?P<root>/\S*?)/node_modules/vitest/")


def parse_etime(text):
    """ps etime ([[dd-]hh:]mm:ss) -> seconds, or None when it does not parse."""
    m = re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", text.strip())
    if not m:
        return None
    days, hours, mins, secs = (int(x) if x else 0 for x in m.groups())
    return ((days * 24 + hours) * 60 + mins) * 60 + secs


def parse_ps(text):
    """`ps -axo pid=,ppid=,pgid=,etime=,command=` output -> list of dicts; unparsable lines are skipped."""
    procs = []
    for line in text.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        etime = parse_etime(parts[3])
        try:
            pid, ppid, pgid = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        if etime is None:
            continue
        procs.append({"pid": pid, "ppid": ppid, "pgid": pgid, "age": etime, "command": parts[4]})
    return procs


def is_candidate(command):
    """A node (or npm / npx exec) process that is vitest, by its command line. Nothing else qualifies."""
    exe = os.path.basename(command.split(None, 1)[0]) if command.split() else ""
    if exe not in ("node", "npm", "npx"):
        return False
    if exe == "node" and _VITEST_DIR.search(command):
        return True
    return bool(_VITEST_MAIN.search(command))


def install_root(command):
    """The directory whose node_modules/vitest the command line points into, or None (relative path)."""
    m = _ROOT.search(command)
    return m.group("root") if m else None


def plan(procs, exists, own_pid, own_pgid):
    """Decide what to do. `exists(path)` tells whether a directory is there. Returns a list of actions:
    {rule, pid, kill: 'pid' | 'group', pgid, proc}."""
    candidates = [p for p in procs if is_candidate(p["command"]) and p["pid"] != own_pid]
    by_group = {}
    for p in procs:
        by_group.setdefault(p["pgid"], []).append(p)
    actions = []
    for p in candidates:
        rule = None
        root = install_root(p["command"])
        if p["ppid"] == 1 and p["age"] >= ORPHAN_MIN_SECS:
            rule = "R1"
        elif root is not None and not exists(root):
            rule = "R2"
        elif p["age"] >= RUNAWAY_MIN_SECS:
            rule = "R3"
        if rule is None:
            continue
        kill = "pid"
        if rule == "R3":
            members = by_group.get(p["pgid"], [])
            pure = bool(members) and all(is_candidate(m["command"]) for m in members)
            if pure and p["pgid"] > 1 and p["pgid"] != own_pgid:
                kill = "group"
        actions.append({"rule": rule, "pid": p["pid"], "kill": kill, "pgid": p["pgid"], "proc": p})
    return actions


def read_ps():
    out = subprocess.run(["ps", "-axo", _PS_FIELDS], capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise OSError("ps failed: %s" % out.stderr.strip()[:200])
    return parse_ps(out.stdout)


def read_one(pid):
    """The current ps row of one pid, or None when it is gone."""
    out = subprocess.run(["ps", "-p", str(pid), "-o", _PS_FIELDS], capture_output=True, text=True, timeout=10)
    rows = parse_ps(out.stdout)
    return rows[0] if rows else None


def still_same(before, now):
    """The pid still is the process we listed: same command line and parent, and not younger."""
    return now is not None and now["command"] == before["command"] and now["ppid"] == before["ppid"] \
        and now["age"] >= before["age"]


def _signal(action, sig):
    try:
        if action["kill"] == "group":
            os.killpg(action["pgid"], sig)
        else:
            os.kill(action["pid"], sig)
    except (ProcessLookupError, PermissionError):
        pass


def execute(action, reread=read_one, send=_signal, sleep=time.sleep, dry_run=False, grace=TERM_GRACE_SECS):
    """Carry out (or only report) one action. Returns the outcome string for the log."""
    if dry_run:
        return "dry-run"
    if not still_same(action["proc"], reread(action["pid"])):
        return "skipped-changed"
    send(action, signal.SIGTERM)
    sleep(grace)
    now = reread(action["pid"])
    if now is None:
        return "killed"
    if not still_same(action["proc"], now):
        return "killed"  # the pid was reused in the meantime: ours is gone, nothing more to do
    send(action, signal.SIGKILL)
    sleep(0.2)
    gone = reread(action["pid"])
    return "killed-with-kill" if gone is None or not still_same(action["proc"], gone) else "failed"


def log_line(action, outcome, now_ts):
    p = action["proc"]
    return {
        "ts": now_ts,
        "rule": action["rule"],
        "outcome": outcome,
        "kill": action["kill"],
        "pid": p["pid"],
        "ppid": p["ppid"],
        "pgid": p["pgid"],
        "age_s": p["age"],
        "command": p["command"][:COMMAND_LOG_CHARS],
    }


def store_dir():
    """Where the log goes: MARVEEN_STORE_DIR, else <repo>/store (the same rule as src/config.ts)."""
    env = os.environ.get("MARVEEN_STORE_DIR")
    if env:
        return env
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "store")


def append_log(path, lines):
    """Append JSON lines; start over when the file is past LOG_MAX_BYTES (a janitor must not fill a disk)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        if os.path.getsize(path) > LOG_MAX_BYTES:
            os.replace(path, path + ".1")
    except OSError:
        pass
    with open(path, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line, sort_keys=True) + "\n")


def run(dry_run=False, log_path=None, procs=None, exists=os.path.isdir, reread=read_one, send=_signal,
        sleep=time.sleep, now=time.time, out=sys.stdout):
    """One pass. Returns the list of log lines (empty when nothing was found)."""
    procs = read_ps() if procs is None else procs
    actions = plan(procs, exists, os.getpid(), os.getpgrp())
    lines = []
    for action in actions:
        outcome = execute(action, reread=reread, send=send, sleep=sleep, dry_run=dry_run)
        lines.append(log_line(action, outcome, int(now())))
    if lines:
        for line in lines:
            out.write(json.dumps(line, sort_keys=True) + "\n")
        out.flush()
        if log_path is not None:
            try:
                append_log(log_path, lines)
            except OSError as exc:
                sys.stderr.write("vitest-janitor: cannot write the log: %s\n" % exc)
    return lines


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if any(a not in ("--dry-run",) for a in argv):
        sys.stderr.write("usage: vitest-janitor.py [--dry-run]\n")
        return 2
    try:
        run(dry_run="--dry-run" in argv, log_path=os.path.join(store_dir(), "vitest-janitor.jsonl"))
    except (OSError, subprocess.SubprocessError) as exc:
        sys.stderr.write("vitest-janitor: %s\n" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
