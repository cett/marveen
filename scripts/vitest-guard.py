#!/usr/bin/env python3
"""vitest-guard: run vitest under a hard time limit and kill the WHOLE process group when it is over.

    python3 scripts/vitest-guard.py [--limit SEC] -- <vitest arguments>
    python3 scripts/vitest-guard.py -- run src/__tests__/x.test.ts
    python3 scripts/vitest-guard.py -- related a.ts b.ts --run --passWithNoTests

Why it exists. A killed or timed-out vitest main process leaves its forked workers behind (parent pid 1,
sleeping, 0 % CPU, for ever). `timeout` and `npx` are not available or not enough on every machine
(`npm exec` is itself one of the sources of orphans), so this wrapper:

  - starts `node node_modules/vitest/vitest.mjs <args>` directly (no npx / npm exec in between), in a NEW
    session, so the vitest main and every worker it forks share one process group;
  - lets the output through to its own stdout / stderr (inherited, NOT a pipe: a full pipe can block the child
    and the output cannot leak into anything else);
  - on timeout, and on SIGINT / SIGTERM / SIGHUP, sends TERM to the group, waits a grace period (5 s), sends
    KILL to the group, then checks the group by pgid with `ps` and kills any leftover member by pid;
  - after a NORMAL exit it sweeps the group the same way: a worker that outlived the main process is exactly
    the orphan this tool is about, and the group id is still the group's until its last member is gone.

Exit code: the vitest's own code (128 + n when a signal ended it); 124 on a timeout (the GNU `timeout`
convention) with one line on stderr; 128 + n when the wrapper itself got signal n; 2 on a usage error; 127
when vitest cannot be found.

Default limit: 1200 s for a whole suite, 600 s for `related` or when a file path is among the arguments.
The path test is a heuristic (an argument with a "/" or a "." that is not an option); a bare name filter
counts as a whole suite, the longer limit, which is the safe direction. Override with --limit SEC or
VITEST_GUARD_SECS; 0, a negative, a non-number or more than 86400 is an error, never "no limit". The limit
is wide on purpose: on a loaded machine (parallel QA runs) a suite is slow and that is not the test's fault;
the limit is a protection against a hang, and the wrapper says so when it fires.

What it does not cover: SIGKILL of the wrapper itself leaves the group alive (nothing can run after a
SIGKILL); scripts/vitest-janitor.py reaps those orphans by pid. A descendant that starts its own session
(setsid) is not in the group and is not reached.

Test hooks (documented, for scripts/__tests__/vitest-guard.test.py only): VITEST_GUARD_CMD replaces
`node node_modules/vitest/vitest.mjs` (split like a shell would, the vitest arguments are appended) and
VITEST_GUARD_TERM_GRACE replaces the 5 s TERM-to-KILL grace.

Standard library only, `python3 -I` compatible.
"""
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time

DEFAULT_FULL_SECS = 1200
DEFAULT_RELATED_SECS = 600
MAX_SECS = 86400
TERM_GRACE_SECS = 5.0
POLL_STEP = 0.05
EXIT_TIMEOUT = 124
EXIT_USAGE = 2
EXIT_NOT_FOUND = 127

USAGE = "usage: vitest-guard.py [--limit SEC] -- <vitest arguments>"


def err(msg):
    """One line on stderr, flushed, always prefixed so it can be told from vitest's own output."""
    sys.stderr.write("vitest-guard: " + msg + "\n")
    sys.stderr.flush()


def parse_secs(raw, source):
    """A positive whole number of seconds up to MAX_SECS, or a ValueError that names the source."""
    text = str(raw).strip()
    # ASCII digits only: str.isdigit() alone also takes full-width and other Unicode digits
    if not (text.isascii() and text.isdigit()):  # also rejects "-5", "1.5", "", "nan", "1e3"
        raise ValueError("%s must be a whole number of seconds, got %r" % (source, raw))
    value = int(text)
    if value < 1 or value > MAX_SECS:
        raise ValueError("%s must be between 1 and %d seconds, got %d" % (source, MAX_SECS, value))
    return value


def parse_grace(raw):
    """The test-only grace period: a positive number of seconds (fractions allowed), at most 60."""
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError("VITEST_GUARD_TERM_GRACE must be a number, got %r" % (raw,))
    if not (0 < value <= 60):  # also false for nan
        raise ValueError("VITEST_GUARD_TERM_GRACE must be above 0 and at most 60, got %r" % (raw,))
    return value


def _file_like(arg):
    return "/" in arg or "." in arg


def default_limit(vitest_args):
    """600 s for `related` or a run with a file path among the arguments, else 1200 s."""
    positionals = [a for a in vitest_args if not a.startswith("-")]
    if positionals and positionals[0] == "related":
        return DEFAULT_RELATED_SECS
    if any(_file_like(a) for a in positionals):
        return DEFAULT_RELATED_SECS
    return DEFAULT_FULL_SECS


def split_args(argv):
    """argv -> (limit option or None, vitest arguments). Raises ValueError on a usage error."""
    if "--" not in argv:
        raise ValueError("missing '--' before the vitest arguments")
    cut = argv.index("--")
    own, vitest_args = argv[:cut], argv[cut + 1:]
    if not vitest_args:
        raise ValueError("no vitest arguments after '--'")
    limit = None
    i = 0
    while i < len(own):
        a = own[i]
        if a == "--limit":
            if i + 1 >= len(own):
                raise ValueError("--limit needs a value")
            limit = parse_secs(own[i + 1], "--limit")
            i += 2
        elif a.startswith("--limit="):
            limit = parse_secs(a[len("--limit="):], "--limit")
            i += 1
        else:
            raise ValueError("unknown option %r" % a)
    return limit, vitest_args


def find_vitest(cwd, repo_root):
    """The vitest entry point: the caller's node_modules first, then the repository this script lives in."""
    for root in (cwd, repo_root):
        path = os.path.join(root, "node_modules", "vitest", "vitest.mjs")
        if os.path.isfile(path):
            return path
    return None


def build_command(vitest_args, cwd, repo_root, env):
    """argv of the child, or None when vitest cannot be found."""
    override = env.get("VITEST_GUARD_CMD")
    if override:
        return shlex.split(override) + list(vitest_args)
    entry = find_vitest(cwd, repo_root)
    node = shutil.which("node")
    if entry is None or node is None:
        return None
    return [node, entry] + list(vitest_args)


def group_members(pgid):
    """Pids (not zombies) whose process group is pgid, from `ps`. None when ps itself fails."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,pgid=,stat="], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    members = []
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            pid, grp = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        if grp == pgid and pid != os.getpid() and not parts[2].startswith("Z"):
            members.append(pid)
    return members


def _group_alive(pgid):
    members = group_members(pgid)
    if members is not None:
        return bool(members)
    try:  # ps unavailable: ask the kernel (a zombie-only group may still answer yes, so this is the fallback)
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _send_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def _wait_gone(pgid, proc, seconds):
    """Reap the leader and poll until the group has no live member; True when it is gone."""
    deadline = time.monotonic() + seconds
    while True:
        if proc is not None:
            proc.poll()  # reaps the leader, a zombie leader would keep the group listed
        if not _group_alive(pgid):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(POLL_STEP)


def kill_group(pgid, proc, grace):
    """TERM the group, wait `grace`, KILL it, verify by pgid, KILL leftovers by pid. True when nothing is left."""
    _send_group(pgid, signal.SIGTERM)
    if _wait_gone(pgid, proc, grace):
        return True
    _send_group(pgid, signal.SIGKILL)
    if _wait_gone(pgid, proc, 2.0):
        return True
    for pid in group_members(pgid) or []:  # a member that left the group view but still carries the pgid
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    gone = _wait_gone(pgid, proc, 2.0)
    if not gone:
        err("could not kill every member of process group %d: %s" % (pgid, group_members(pgid)))
    return gone


def run(vitest_args, limit, env=None):
    """Start the child in its own session and supervise it. Returns the exit code."""
    env = os.environ if env is None else env
    try:
        grace = parse_grace(env["VITEST_GUARD_TERM_GRACE"]) if "VITEST_GUARD_TERM_GRACE" in env else TERM_GRACE_SECS
    except ValueError as exc:
        err(str(exc))
        return EXIT_USAGE
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cmd = build_command(vitest_args, os.getcwd(), repo_root, env)
    if cmd is None:
        err("cannot find node or node_modules/vitest/vitest.mjs (run npm ci)")
        return EXIT_NOT_FOUND

    state = {"proc": None, "fired": False}

    def on_signal(signum, _frame):
        if state["fired"]:
            return
        state["fired"] = True
        proc = state["proc"]
        if proc is not None:
            kill_group(proc.pid, proc, grace)
        err("received %s, killed the process group" % signal.Signals(signum).name)
        raise SystemExit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)

    try:
        # stdout / stderr are inherited (no pipe); stdin is closed to the child (a run never reads it, and a
        # new session has no controlling terminal to read from anyway).
        proc = subprocess.Popen(cmd, start_new_session=True, stdin=subprocess.DEVNULL)
    except OSError as exc:
        err("cannot start %s: %s" % (cmd[0], exc))
        return EXIT_NOT_FOUND
    state["proc"] = proc
    pgid = proc.pid  # start_new_session: the child is a session and group leader, its pid is the group id

    try:
        code = proc.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        kill_group(pgid, proc, grace)
        err("timeout after %d s, killed the process group (a slow machine is not a failing test: raise "
            "--limit or VITEST_GUARD_SECS if the suite is just slow)" % limit)
        return EXIT_TIMEOUT

    # The main process is gone; a worker that outlived it is an orphan in the making. Sweep the group.
    if _group_alive(pgid):
        err("vitest exited but left processes in its group, killing them")
        kill_group(pgid, proc, grace)
    return code if code >= 0 else 128 - code


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        limit_opt, vitest_args = split_args(argv)
        if limit_opt is not None:
            limit = limit_opt
        elif "VITEST_GUARD_SECS" in os.environ:
            limit = parse_secs(os.environ["VITEST_GUARD_SECS"], "VITEST_GUARD_SECS")
        else:
            limit = default_limit(vitest_args)
    except ValueError as exc:
        err(str(exc))
        sys.stderr.write(USAGE + "\n")
        return EXIT_USAGE
    return run(vitest_args, limit)


if __name__ == "__main__":
    sys.exit(main())
