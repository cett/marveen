"""The one timing ceiling of the linear-time gate tests. Imported by them; not a test (the runner takes *.test.py only).

These tests feed a 550 kB hostile input to a gate function and check that it answers in linear time. The ceiling
therefore separates a linear scan from a quadratic one; it is not a claim about how fast a machine is. The old
quadratic patterns need seconds already at 40 kB and from tens of seconds to many minutes at 550 kB, the linear code
needs well under 0.3 s on a loaded machine (20 runs, 20 busy loops on 10 cpus, 5 tests at once: worst 0.26 s), so a
2 s ceiling still tells them apart, and a slow shared CI runner cannot trip it (a run measured 0.304 s against the
earlier 0.3 s ceiling).

Raise it only together with a measurement: the ceiling must stay far below the time of the quadratic pattern.
"""
import time

LINEAR_CEILING_SEC = 2.0


def best_of(fn, runs=3):
    """The smallest of `runs` wall-clock times of fn(), in seconds."""
    best = None
    for _ in range(runs):
        t = time.perf_counter()
        fn()
        dt = time.perf_counter() - t
        best = dt if best is None else min(best, dt)
    return best
