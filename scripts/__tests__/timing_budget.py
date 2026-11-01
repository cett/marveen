"""The one timing ceiling of the linear-time gate tests. Imported by them; not a test (the runner takes *.test.py only).

These tests feed a 550 kB hostile input to a gate function and check that it answers in linear time. The ceiling
therefore separates a linear scan from a quadratic one; it is not a claim about how fast a machine is. The old
quadratic patterns need seconds already at 40 kB and from tens of seconds to many minutes at 550 kB, the linear code
needs well under 0.3 s on a loaded machine (20 runs, 20 busy loops on 10 cpus, 5 tests at once: worst 0.26 s), so a
2 s ceiling still tells them apart, and a slow shared CI runner cannot trip it (a run measured 0.304 s against the
earlier 0.3 s ceiling).

Raise it only together with a measurement: the ceiling must stay far below the time of the quadratic pattern.

best_of() runs each measured call in a forked child process and cuts it off on the wall clock. Without that, a
quadratic regression would not print a FAIL: the call would run for minutes (a regex holds the interpreter, so a
thread could not be interrupted either) and CI would end in a job timeout with nothing to read. With it the
regression is a readable FAIL within a few seconds per input.
"""
import math
import multiprocessing
import time

LINEAR_CEILING_SEC = 2.0
# A call still running this long after it started is cut off. A little above the ceiling, so a slow but linear run
# still reports its real time and a quadratic one is stopped after seconds, not minutes.
CUTOFF_SEC = LINEAR_CEILING_SEC + 1.0
# Two cut-off runs of the three decide it; one stalled run (a paused CI runner) does not fail a linear gate.
MAX_CUTOFFS = 2


def _child(fn, conn):
    try:
        t = time.perf_counter()
        fn()
        conn.send(("ok", time.perf_counter() - t))
    except BaseException as exc:  # reported to the parent, which raises it
        conn.send(("error", "%s: %s" % (type(exc).__name__, exc)))
    finally:
        conn.close()


def best_of(fn, runs=3, cutoff=CUTOFF_SEC):
    """The smallest wall-clock time of `runs` calls of fn(), in seconds; math.inf when the calls do not finish.

    Each call runs in its own forked child and is killed once `cutoff` seconds have passed; after MAX_CUTOFFS cut-off
    calls the answer is math.inf at once (the remaining calls are not made). Format the result with describe()."""
    ctx = multiprocessing.get_context("fork")  # the closure and the big input are inherited, nothing is pickled
    best, cut = math.inf, 0
    for _ in range(runs):
        recv, send = ctx.Pipe(duplex=False)
        proc = ctx.Process(target=_child, args=(fn, send), daemon=True)
        proc.start()
        send.close()
        got = None
        try:
            if recv.poll(cutoff):
                got = recv.recv()
        except EOFError:
            got = ("error", "the measured call ended without a result (killed or crashed)")
        if got is None:
            proc.kill()
            cut += 1
        proc.join()
        recv.close()
        if got is not None:
            if got[0] == "error":
                raise RuntimeError("measured call failed: %s" % got[1])
            best = min(best, got[1])
        if cut >= MAX_CUTOFFS:
            return math.inf
    return best


def describe(seconds, cutoff=CUTOFF_SEC):
    """'0.123 s', or the cut-off text for math.inf."""
    if seconds == math.inf:
        return "cut off after %.1f s (over the %.1f s ceiling, not linear)" % (cutoff, LINEAR_CEILING_SEC)
    return "%.3f s" % seconds
