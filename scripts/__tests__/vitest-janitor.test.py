#!/usr/bin/env python3
"""Tests for scripts/vitest-janitor.py.

The `ps` listing, the directory check, the pid re-read, the signals and the clock are all injected, so no
process is touched except in the one end-to-end case at the bottom (a real orphan we create ourselves).
Pinned: the three rules and their edges, what must NOT be killed (young, live parent, not vitest, a plain
`node` with parent 1), the pid-reuse re-read, dry-run, the log (one line per finding, silent when nothing),
and the R3 group rule (a group shared with a non-vitest process is never killed as a group).

Privacy: generic paths and pids only.
"""
import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(os.path.dirname(_HERE), "vitest-janitor.py")
_spec = importlib.util.spec_from_file_location("vitest_janitor", _SCRIPT)
jan = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(jan)  # type: ignore[union-attr]

ROOT = "/work/repo-a"
WORKER = "/usr/local/bin/node %s/node_modules/vitest/dist/workers/forks.js" % ROOT
MAIN = "node %s/node_modules/vitest/vitest.mjs run src/x.test.ts" % ROOT
NPM_EXEC = "npm exec vitest run"
OWN_PID = 4242
OWN_PGID = 4242


def proc(pid, ppid=1, pgid=None, age=300, command=WORKER):
    return {"pid": pid, "ppid": ppid, "pgid": pgid if pgid is not None else pid, "age": age, "command": command}


def exists_all(_path):
    return True


def plan_of(procs, exists=exists_all):
    return jan.plan(procs, exists, OWN_PID, OWN_PGID)


def rules(actions):
    return {a["pid"]: a["rule"] for a in actions}


class ParseTest(unittest.TestCase):
    def test_etime_formats(self):
        self.assertEqual(jan.parse_etime("00:05"), 5)
        self.assertEqual(jan.parse_etime("02:00"), 120)
        self.assertEqual(jan.parse_etime("1:02:03"), 3723)
        self.assertEqual(jan.parse_etime("2-03:04:05"), 2 * 86400 + 3 * 3600 + 4 * 60 + 5)
        for bad in ("", "abc", "5", "1:2:3:4", "-"):
            self.assertIsNone(jan.parse_etime(bad), bad)

    def test_parse_ps_keeps_spaces_in_the_command_and_skips_junk(self):
        text = "\n".join([
            "  101     1   101    03:00 node /a b/node_modules/vitest/x.js --flag",
            "  garbage line",
            "  102     1   102   notatime node y",
            "  103   101   101    00:01 node",
        ])
        procs = jan.parse_ps(text)
        self.assertEqual([p["pid"] for p in procs], [101, 103])  # the junk line and the bad etime are skipped
        self.assertEqual(procs[0]["command"], "node /a b/node_modules/vitest/x.js --flag")
        self.assertEqual(procs[0]["age"], 180)


class CandidateTest(unittest.TestCase):
    def test_vitest_shapes_are_candidates(self):
        for cmd in (WORKER, MAIN, NPM_EXEC, "node vitest.mjs related a.ts --run", "npx vitest run",
                    "node ./node_modules/vitest/vitest.mjs run"):
            with self.subTest(cmd=cmd):
                self.assertTrue(jan.is_candidate(cmd))

    def test_everything_else_is_not(self):
        for cmd in (
            "node /srv/app/dashboard.js",  # a plain node
            "node /srv/app/node_modules/other/index.js",
            "python3 /work/scripts/vitest-guard.py -- run",  # not node / npm / npx
            "bash -c vitest run",
            "node vitest-janitor.js",
            "node /work/vitest.mjs watch",  # watch is not run / related
            "vim node_modules/vitest/package.json",
            "",
        ):
            with self.subTest(cmd=cmd):
                self.assertFalse(jan.is_candidate(cmd))

    def test_install_root(self):
        self.assertEqual(jan.install_root(WORKER), ROOT)
        self.assertEqual(jan.install_root("node /a/node_modules/b/node_modules/vitest/x.js"), "/a/node_modules/b")
        self.assertIsNone(jan.install_root("node ./node_modules/vitest/vitest.mjs run"))  # relative: unknown
        self.assertIsNone(jan.install_root(NPM_EXEC))


class RuleTest(unittest.TestCase):
    def test_r1_orphan_of_three_minutes_is_killed(self):
        self.assertEqual(rules(plan_of([proc(10, ppid=1, age=180)])), {10: "R1"})

    def test_r1_edge_is_two_minutes(self):
        self.assertEqual(rules(plan_of([proc(10, age=119)])), {})
        self.assertEqual(rules(plan_of([proc(11, age=120)])), {11: "R1"})

    def test_r1_young_orphan_is_left_alone(self):
        self.assertEqual(plan_of([proc(10, ppid=1, age=30)]), [])

    def test_live_parent_is_left_alone(self):
        # Another agent's run in progress: the parent is alive (not pid 1) and the install exists.
        self.assertEqual(plan_of([proc(10, ppid=777, age=600), proc(777, ppid=5, command="node " + ROOT + "/node_modules/vitest/vitest.mjs run")]), [])

    def test_non_vitest_node_with_parent_one_is_left_alone(self):
        self.assertEqual(plan_of([proc(10, ppid=1, age=99999, command="node /srv/app/dashboard.js")]), [])

    def test_the_janitor_never_kills_itself(self):
        self.assertEqual(plan_of([proc(OWN_PID, ppid=1, age=999, command=MAIN)]), [])

    def test_r2_missing_install_is_killed_even_with_a_live_parent_and_young(self):
        gone = lambda path: path != ROOT  # noqa: E731
        got = rules(plan_of([proc(10, ppid=777, age=5)], exists=gone))
        self.assertEqual(got, {10: "R2"})

    def test_r2_not_applied_when_the_install_is_there_or_unknown(self):
        self.assertEqual(plan_of([proc(10, ppid=777, age=5)]), [])
        rel = proc(11, ppid=777, age=5, command="node ./node_modules/vitest/vitest.mjs run")
        self.assertEqual(plan_of([rel], exists=lambda p: False), [])

    def test_r3_three_hour_run_is_killed_one_hour_is_not(self):
        live_main = proc(10, ppid=777, age=3 * 3600, command=MAIN)
        self.assertEqual(rules(plan_of([live_main])), {10: "R3"})
        self.assertEqual(plan_of([proc(11, ppid=777, age=3600, command=MAIN)]), [])
        self.assertEqual(plan_of([proc(12, ppid=777, age=7199, command=MAIN)]), [])
        self.assertEqual(rules(plan_of([proc(13, ppid=777, age=7200, command=MAIN)])), {13: "R3"})

    def test_a_detached_run_is_an_orphan_from_the_start_and_goes_after_two_minutes(self):
        # nohup / disown: parent pid 1 from the beginning, a perfectly healthy run. The docs say so.
        detached = proc(10, ppid=1, age=119, command=MAIN)
        self.assertEqual(plan_of([detached]), [])
        self.assertEqual(rules(plan_of([proc(10, ppid=1, age=121, command=MAIN)])), {10: "R1"})

    def test_a_watch_mode_session_goes_after_two_hours_not_before(self):
        watch = "node %s/node_modules/vitest/vitest.mjs" % ROOT  # no run / related: the interactive mode
        self.assertTrue(jan.is_candidate(watch))
        self.assertEqual(plan_of([proc(10, ppid=777, age=7199, command=watch)]), [])
        self.assertEqual(rules(plan_of([proc(10, ppid=777, age=7200, command=watch)])), {10: "R3"})

    def test_r2_and_r3_do_not_look_at_the_parent_r2_not_at_the_age(self):
        gone = lambda path: False  # noqa: E731
        self.assertEqual(rules(plan_of([proc(10, ppid=777, age=1)], exists=gone)), {10: "R2"})
        self.assertEqual(rules(plan_of([proc(11, ppid=777, age=9000, command=MAIN)])), {11: "R3"})

    def test_rule_order_r1_wins_over_r3(self):
        self.assertEqual(rules(plan_of([proc(10, ppid=1, age=99999)])), {10: "R1"})


class GroupRuleTest(unittest.TestCase):
    def test_r3_kills_the_group_when_every_member_is_vitest(self):
        main = proc(100, ppid=777, pgid=100, age=8000, command=MAIN)
        worker = proc(101, ppid=100, pgid=100, age=8000)
        acts = plan_of([main, worker])
        by_pid = {a["pid"]: a for a in acts}
        self.assertEqual(by_pid[100]["kill"], "group")
        self.assertEqual(by_pid[100]["pgid"], 100)

    def test_r3_kills_pids_only_when_the_group_is_shared_with_something_else(self):
        main = proc(100, ppid=777, pgid=50, age=8000, command=MAIN)
        shell = proc(50, ppid=1, pgid=50, age=9000, command="bash -c run-tests.sh")
        (act,) = plan_of([main, shell])
        self.assertEqual(act["kill"], "pid")

    def test_r3_never_takes_the_janitors_own_group(self):
        main = proc(100, ppid=777, pgid=OWN_PGID, age=8000, command=MAIN)
        (act,) = plan_of([main])
        self.assertEqual(act["kill"], "pid")

    def test_r1_is_always_by_pid(self):
        (act,) = plan_of([proc(10, ppid=1, pgid=10, age=500)])
        self.assertEqual(act["kill"], "pid")


class ExecuteTest(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.action = plan_of([proc(10, age=300)])[0]

    def send(self, action, sig):
        self.sent.append((action["pid"], sig))

    def test_dry_run_sends_nothing_and_does_not_even_read_again(self):
        def boom(_pid):
            raise AssertionError("dry-run must not touch the process")
        out = jan.execute(self.action, reread=boom, send=self.send, sleep=lambda s: None, dry_run=True)
        self.assertEqual(out, "dry-run")
        self.assertEqual(self.sent, [])

    def test_pid_reuse_second_read_has_another_command(self):
        reused = proc(10, age=400, command="node /srv/app/dashboard.js")
        out = jan.execute(self.action, reread=lambda pid: reused, send=self.send, sleep=lambda s: None)
        self.assertEqual(out, "skipped-changed")
        self.assertEqual(self.sent, [])

    def test_pid_reuse_second_read_is_younger(self):
        younger = proc(10, age=3)
        out = jan.execute(self.action, reread=lambda pid: younger, send=self.send, sleep=lambda s: None)
        self.assertEqual(out, "skipped-changed")
        self.assertEqual(self.sent, [])

    def test_pid_gone_between_listing_and_kill(self):
        out = jan.execute(self.action, reread=lambda pid: None, send=self.send, sleep=lambda s: None)
        self.assertEqual(out, "skipped-changed")
        self.assertEqual(self.sent, [])

    def test_term_is_enough(self):
        reads = iter([proc(10, age=300), None])
        out = jan.execute(self.action, reread=lambda pid: next(reads), send=self.send, sleep=lambda s: None)
        self.assertEqual(out, "killed")
        self.assertEqual(self.sent, [(10, signal.SIGTERM)])

    def test_stubborn_process_gets_kill_after_the_grace(self):
        alive = proc(10, age=303)
        reads = iter([proc(10, age=300), alive, None])
        slept = []
        out = jan.execute(self.action, reread=lambda pid: next(reads), send=self.send, sleep=slept.append)
        self.assertEqual(out, "killed-with-kill")
        self.assertEqual(self.sent, [(10, signal.SIGTERM), (10, signal.SIGKILL)])
        self.assertEqual(slept[0], jan.TERM_GRACE_SECS)

    def test_a_pid_that_survives_kill_is_reported_failed(self):
        alive = proc(10, age=304)
        reads = iter([proc(10, age=300), alive, alive])
        out = jan.execute(self.action, reread=lambda pid: next(reads), send=self.send, sleep=lambda s: None)
        self.assertEqual(out, "failed")


class RunAndLogTest(unittest.TestCase):
    def test_nothing_found_is_silent_and_writes_no_file(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "store", "vitest-janitor.jsonl")
            buf = io.StringIO()
            lines = jan.run(log_path=log, exists=exists_all, procs=[proc(10, age=5), proc(11, ppid=1, command="node /srv/x.js")],
                            out=buf)
            self.assertEqual(lines, [])
            self.assertEqual(buf.getvalue(), "")
            self.assertFalse(os.path.exists(log))

    def test_one_json_line_per_finding_on_stdout_and_in_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "store", "vitest-janitor.jsonl")
            buf = io.StringIO()
            procs = [proc(10, age=300), proc(11, age=400, command=WORKER + " " + "x" * 500)]
            lines = jan.run(dry_run=True, log_path=log, exists=exists_all, procs=procs, out=buf, now=lambda: 1_800_000_000)
            self.assertEqual(len(lines), 2)
            printed = [json.loads(x) for x in buf.getvalue().splitlines()]
            filed = [json.loads(x) for x in open(log).read().splitlines()]
            self.assertEqual(printed, filed)
            self.assertEqual({x["pid"] for x in printed}, {10, 11})
            for x in printed:
                self.assertEqual(x["outcome"], "dry-run")
                self.assertEqual(x["rule"], "R1")
                self.assertEqual(x["ts"], 1_800_000_000)
                self.assertLessEqual(len(x["command"]), jan.COMMAND_LOG_CHARS)

    def test_dry_run_through_run_kills_nothing(self):
        sent = []
        jan.run(dry_run=True, exists=exists_all, procs=[proc(10, age=300)], send=lambda a, s: sent.append(s),
                reread=lambda pid: proc(10, age=300), out=io.StringIO())
        self.assertEqual(sent, [])

    def test_a_real_pass_through_run_kills_and_records(self):
        sent = []
        reads = iter([proc(10, age=300), None])
        buf = io.StringIO()
        lines = jan.run(exists=exists_all, procs=[proc(10, age=300)], send=lambda a, s: sent.append(s), sleep=lambda s: None,
                        reread=lambda pid: next(reads), out=buf)
        self.assertEqual(sent, [signal.SIGTERM])
        self.assertEqual(lines[0]["outcome"], "killed")

    def test_the_log_starts_over_past_the_size_cap(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "j.jsonl")
            with open(log, "w") as fh:
                fh.write("x" * (jan.LOG_MAX_BYTES + 1))
            jan.append_log(log, [{"a": 1}])
            self.assertTrue(os.path.exists(log + ".1"))
            self.assertEqual(open(log).read(), '{"a": 1}\n')

    def test_usage_error_for_an_unknown_argument(self):
        self.assertEqual(jan.main(["--kill-everything"]), 2)


class EndToEndTest(unittest.TestCase):
    """A real orphan: a fake 'vitest worker' whose parent dies. The janitor sees a node-less fake, so the
    classification is exercised through the real `ps`, but the kill itself is covered by the injected tests."""

    def test_real_ps_listing_parses_and_contains_this_process(self):
        procs = jan.read_ps()
        mine = [p for p in procs if p["pid"] == os.getpid()]
        self.assertEqual(len(mine), 1)
        self.assertGreaterEqual(mine[0]["age"], 0)
        self.assertEqual(jan.read_one(os.getpid())["command"], mine[0]["command"])
        self.assertIsNone(jan.read_one(2 ** 22 + 12345))

    def test_a_plain_python_orphan_with_parent_one_is_not_a_candidate(self):
        # Spawn a grandchild whose parent exits at once, so it is reparented to pid 1.
        code = "import subprocess,sys;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(p.pid)"
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=20)
        pid = int(out.stdout.strip())
        try:
            time.sleep(0.5)
            row = jan.read_one(pid)
            self.assertIsNotNone(row)
            self.assertEqual(row["ppid"], 1)
            acts = jan.plan(jan.read_ps(), os.path.isdir, os.getpid(), os.getpgrp())
            self.assertNotIn(pid, [a["pid"] for a in acts])
        finally:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
