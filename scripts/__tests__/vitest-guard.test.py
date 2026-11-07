#!/usr/bin/env python3
"""Tests for scripts/vitest-guard.py.

The real vitest is replaced by small fake children (VITEST_GUARD_CMD, a documented test hook), so every case
runs in seconds and needs no node_modules. What is pinned:

  (a) a quick child: its exit code goes through (0 and a failing code);
  (b) a child that runs too long: exit 124, the line on stderr, the whole group is gone;
  (c) a child and a grandchild that both ignore SIGTERM: the KILL step reaches both (a kill of the child
      pid alone, or no KILL step, leaves the grandchild alive);
  (d) the wrapper itself gets SIGTERM: the child group dies, exit 143;
  (e) the output is passed through live (not buffered in a pipe) and a large output does not block;
  (f) a worker left behind by a child that exited normally is swept;
  (g) the limit is validated (0, negative, text, too big are errors and nothing is started), and the default
      limit depends on the arguments.

Privacy: no real names, hosts or ids; the fixtures are generic.
"""
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(os.path.dirname(_HERE), "vitest-guard.py")
_spec = importlib.util.spec_from_file_location("vitest_guard", _SCRIPT)
guard = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(guard)  # type: ignore[union-attr]

PY = sys.executable

# A fake "vitest": writes its pid (and its grandchild's) into the file named by FAKE_PIDS, then behaves as
# FAKE_MODE says. Plain python so the test needs nothing else.
FAKE = r'''
import os, signal, subprocess, sys, time
mode = os.environ["FAKE_MODE"]
pids = os.environ["FAKE_PIDS"]

def record(*ps):
    with open(pids, "a") as fh:
        for p in ps:
            fh.write("%d\n" % p)
        fh.flush()

SLEEPER = "import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(300)"
if mode == "exit":
    sys.exit(int(os.environ.get("FAKE_CODE", "0")))
elif mode == "marker":
    record(os.getpid())  # proves the child was started at all
elif mode == "hang":
    record(os.getpid())
    time.sleep(300)
elif mode == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    gc = subprocess.Popen([sys.executable, "-c", SLEEPER])
    record(os.getpid(), gc.pid)
    time.sleep(300)
elif mode == "leave-worker":
    gc = subprocess.Popen([sys.executable, "-c", SLEEPER], stdout=subprocess.DEVNULL)
    record(gc.pid)
    sys.exit(0)
elif mode == "stream":
    print("first line", flush=True)
    record(os.getpid())
    time.sleep(3)
    print("second line", flush=True)
elif mode == "flood":
    chunk = "x" * 1023 + "\n"
    for _ in range(4096):
        sys.stdout.write(chunk)
    sys.stdout.flush()
    sys.stderr.write("done\n")
elif mode == "args":
    print("ARGS=" + "|".join(sys.argv[1:]))
'''


def pid_alive(pid):
    """True when the pid is a live process (a zombie counts as dead)."""
    out = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")


def read_pids(path, expected, timeout=10.0):
    """Wait until the fake wrote `expected` pids, return them."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with open(path) as fh:
                vals = [int(x) for x in fh.read().split()]
            if len(vals) >= expected:
                return vals
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raise AssertionError("the fake child did not write %d pid(s) in time" % expected)


def wait_dead(pids, timeout=8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(pid_alive(p) for p in pids):
            return True
        time.sleep(0.05)
    return False


class GuardRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = os.path.join(self.tmp, "fake.py")
        with open(self.fake, "w") as fh:
            fh.write(FAKE)
        self.pids = os.path.join(self.tmp, "pids")
        self.spawned = []

    def tearDown(self):
        # Safety net: whatever a failing test left behind must not outlive it.
        try:
            with open(self.pids) as fh:
                for p in [int(x) for x in fh.read().split()]:
                    try:
                        os.kill(p, signal.SIGKILL)
                    except OSError:
                        pass
        except OSError:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def env(self, mode, **extra):
        env = dict(os.environ)
        env.pop("VITEST_GUARD_SECS", None)
        env.update({
            "VITEST_GUARD_CMD": "%s %s" % (PY, self.fake),
            "FAKE_MODE": mode,
            "FAKE_PIDS": self.pids,
            "VITEST_GUARD_TERM_GRACE": "0.5",
        })
        env.update(extra)
        return env

    def run_guard(self, mode, args=("--limit", "30"), vitest_args=("run",), timeout=60, **extra):
        return subprocess.run(
            [PY, _SCRIPT, *args, "--", *vitest_args],
            env=self.env(mode, **extra), capture_output=True, text=True, timeout=timeout,
        )

    # (a) exit code goes through
    def test_quick_child_exit_zero_goes_through(self):
        r = self.run_guard("exit")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_quick_child_failing_code_goes_through(self):
        r = self.run_guard("exit", FAKE_CODE="7")
        self.assertEqual(r.returncode, 7, r.stderr)

    def test_vitest_arguments_reach_the_child_unchanged(self):
        r = self.run_guard("args", vitest_args=("related", "a.ts", "--run", "--passWithNoTests"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ARGS=related|a.ts|--run|--passWithNoTests", r.stdout)

    # (b) timeout
    def test_timeout_is_124_with_a_line_and_the_group_is_gone(self):
        t0 = time.monotonic()
        r = self.run_guard("hang", args=("--limit", "1"))
        self.assertEqual(r.returncode, 124, r.stderr)
        self.assertIn("vitest-guard: timeout after 1 s, killed the process group", r.stderr)
        self.assertLess(time.monotonic() - t0, 20)
        (pid,) = read_pids(self.pids, 1)[:1]
        self.assertTrue(wait_dead([pid]), "the hanging child is still alive")

    # (c) SIGTERM ignored by the child and the grandchild: the KILL step is what ends them
    def test_term_ignoring_child_and_grandchild_are_killed(self):
        r = self.run_guard("stubborn", args=("--limit", "1"))
        self.assertEqual(r.returncode, 124, r.stderr)
        child, grandchild = read_pids(self.pids, 2)[:2]
        self.assertTrue(wait_dead([child, grandchild]), "a process of the group survived the KILL step")

    # (d) the wrapper gets SIGTERM
    def test_wrapper_sigterm_kills_the_child_group(self):
        p = subprocess.Popen(
            [PY, _SCRIPT, "--limit", "60", "--", "run"],
            env=self.env("stubborn"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            child, grandchild = read_pids(self.pids, 2)[:2]
            p.send_signal(signal.SIGTERM)
            out, err = p.communicate(timeout=30)
        finally:
            if p.poll() is None:
                p.kill()
            p.stdout.close()
            p.stderr.close()
        self.assertEqual(p.returncode, 128 + signal.SIGTERM, err)
        self.assertIn("received SIGTERM, killed the process group", err)
        self.assertTrue(wait_dead([child, grandchild]), "the group survived the wrapper's SIGTERM")

    # (e) the output is live and a flood does not block
    def test_output_is_passed_through_live_not_buffered(self):
        p = subprocess.Popen(
            [PY, _SCRIPT, "--limit", "60", "--", "run"],
            env=self.env("stream"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            t0 = time.monotonic()
            first = p.stdout.readline()
            elapsed = time.monotonic() - t0
            self.assertEqual(first.strip(), "first line")
            # The child sleeps 3 s after the first line: a wrapper that collects the output (a pipe read to
            # the end) would only show it after the child is done.
            self.assertLess(elapsed, 2.5, "the first line arrived only after the child finished")
            rest = p.stdout.read()
            p.wait(timeout=30)
        finally:
            if p.poll() is None:
                p.kill()
            p.stdout.close()
            p.stderr.close()
        self.assertIn("second line", rest)
        self.assertEqual(p.returncode, 0)

    def test_two_megabytes_of_output_do_not_block_and_arrive_whole(self):
        r = self.run_guard("flood", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        self.assertEqual(len(r.stdout), 4096 * 1024)
        self.assertIn("done", r.stderr)

    # (f) a worker that outlived a normally exited main process
    def test_survivor_of_a_normal_exit_is_swept(self):
        r = self.run_guard("leave-worker")
        self.assertEqual(r.returncode, 0, r.stderr)  # the child's own code is kept
        self.assertIn("left processes in its group", r.stderr)
        (worker,) = read_pids(self.pids, 1)[:1]
        self.assertTrue(wait_dead([worker]), "the orphan worker was not swept")

    # (g) validation: nothing is started on a bad limit
    def assert_usage_error(self, args, **extra):
        r = subprocess.run(
            [PY, _SCRIPT, *args],
            env=self.env("marker", **extra), capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertFalse(os.path.exists(self.pids), "the child was started on a usage error")
        return r

    def test_bad_limits_are_usage_errors(self):
        for bad in ("0", "-5", "abc", "1.5", "", "86401", "1e3"):
            with self.subTest(limit=bad):
                r = self.assert_usage_error(["--limit", bad, "--", "run"])
                self.assertIn("--limit", r.stderr)

    def test_bad_env_limit_is_an_error_not_ignored(self):
        for bad in ("0", "-1", "soon"):
            with self.subTest(env=bad):
                r = self.assert_usage_error(["--", "run"], VITEST_GUARD_SECS=bad)
                self.assertIn("VITEST_GUARD_SECS", r.stderr)

    def test_missing_separator_and_empty_vitest_arguments(self):
        self.assert_usage_error(["--limit", "5", "run"])
        self.assert_usage_error(["--limit", "5", "--"])
        self.assert_usage_error([])
        self.assert_usage_error(["--bogus", "--", "run"])

    def test_limit_equals_form_and_env_are_read(self):
        # A valid limit through each route lets a quick child through.
        r = self.run_guard("exit", args=("--limit=30",))
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_guard("exit", args=(), VITEST_GUARD_SECS="30")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_missing_vitest_is_127(self):
        env = self.env("exit")
        env.pop("VITEST_GUARD_CMD")
        bare = os.path.join(self.tmp, "no-repo")
        os.makedirs(bare)
        # Run a COPY of the script so its repo root (the parent of its directory) has no node_modules either.
        scripts = os.path.join(bare, "scripts")
        os.makedirs(scripts)
        shutil.copy(_SCRIPT, scripts)
        r = subprocess.run([PY, os.path.join(scripts, "vitest-guard.py"), "--limit", "5", "--", "run"],
                           env=env, cwd=bare, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 127, r.stderr)
        self.assertIn("npm ci", r.stderr)


class PureHelpersTest(unittest.TestCase):
    def test_default_limit_by_arguments(self):
        full = guard.DEFAULT_FULL_SECS
        short = guard.DEFAULT_RELATED_SECS
        self.assertEqual(full, 1800)
        self.assertEqual(short, 600)
        on_disk = {"src/__tests__", "tests"}  # directories that "exist" for the injected exists()
        cases = [
            (["run"], full),
            (["run", "--reporter", "verbose"], full),  # an option value is not a file
            (["run", "--coverage"], full),
            (["related", "a.ts", "--run", "--passWithNoTests"], short),
            (["run", "src/__tests__/x.test.ts"], short),
            (["run", "x.test.ts", "y.test.ts"], short),
            (["x.test.ts"], short),
            (["run", "prompt-safety"], full),  # a bare name filter: the longer, safe limit
            # The value of an option is never a file, whatever it looks like (these four were wrongly "short")
            (["run", "--config", "vitest.config.ts"], full),
            (["run", "--project", "unit.node"], full),
            (["run", "--root", "./x"], full),
            (["run", "--outputFile", "out/r.json"], full),
            (["--config", "vitest.config.ts", "run"], full),  # the option comes first
            (["run", "--config=vitest.config.ts"], full),  # the = form is one argument
            # ... but a file after an option is still seen when the option is known to take no value
            (["run", "--coverage", "src/a.test.ts"], short),
            (["run", "--silent", "src/a.test.ts"], short),
            # an unknown flag swallows the next argument: the longer limit, the safe direction
            (["run", "--someFlag", "src/a.test.ts"], full),
            # a name with a dot or a slash that is neither a source file nor on disk is not a file
            (["run", "foo.bar"], full),
            (["run", "no/such/dir"], full),
            # a directory that exists, with and without a trailing slash
            (["run", "src/__tests__"], short),
            (["run", "tests"], short),
            # every source extension counts
            (["run", "a.mts"], short),
            (["run", "a.jsx"], short),
            (["run", "a.cjs"], short),
            # `related` wins however the options are placed
            (["--reporter", "dot", "related", "a.ts"], short),
        ]
        for args, want in cases:
            with self.subTest(args=args):
                self.assertEqual(guard.default_limit(args, exists=lambda p: p in on_disk), want)

    def test_default_limit_uses_the_real_file_system_by_default(self):
        with tempfile.TemporaryDirectory() as d:
            existing = os.path.join(d, "plain-name")
            os.makedirs(existing)
            self.assertEqual(guard.default_limit(["run", existing]), guard.DEFAULT_RELATED_SECS)
            self.assertEqual(guard.default_limit(["run", os.path.join(d, "missing-name")]), guard.DEFAULT_FULL_SECS)

    def test_parse_secs_edges(self):
        self.assertEqual(guard.parse_secs("1", "x"), 1)
        self.assertEqual(guard.parse_secs(" 86400 ", "x"), 86400)
        for bad in ("0", "86401", "-1", "1.0", "", " ", "NaN", "inf", "0x10", "１２"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                guard.parse_secs(bad, "x")

    def test_parse_grace_rejects_nan_and_zero(self):
        self.assertEqual(guard.parse_grace("0.5"), 0.5)
        for bad in ("0", "-1", "nan", "61", "abc"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                guard.parse_grace(bad)

    def test_find_vitest_prefers_the_callers_tree_then_the_repo(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            self.assertIsNone(guard.find_vitest(a, b))
            repo_entry = os.path.join(b, "node_modules", "vitest", "vitest.mjs")
            os.makedirs(os.path.dirname(repo_entry))
            open(repo_entry, "w").close()
            self.assertEqual(guard.find_vitest(a, b), repo_entry)
            cwd_entry = os.path.join(a, "node_modules", "vitest", "vitest.mjs")
            os.makedirs(os.path.dirname(cwd_entry))
            open(cwd_entry, "w").close()
            self.assertEqual(guard.find_vitest(a, b), cwd_entry)

    def test_no_npx_or_npm_exec_in_the_command(self):
        with tempfile.TemporaryDirectory() as a:
            entry = os.path.join(a, "node_modules", "vitest", "vitest.mjs")
            os.makedirs(os.path.dirname(entry))
            open(entry, "w").close()
            cmd = guard.build_command(["run"], a, a, {})
            if cmd is None:
                self.skipTest("node is not installed")
            self.assertEqual(cmd[1:], [entry, "run"])
            self.assertTrue(os.path.basename(cmd[0]).startswith("node"))


if __name__ == "__main__":
    unittest.main()
