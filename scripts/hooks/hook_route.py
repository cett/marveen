"""The dashboard route client of the PostgreSQL-mode tenant hooks (tenant-context.py, tenant-skill-gate.py).

A gate hook runs inside the harness timeout of 10 s, and an `onFailure: block` entry turns a timeout into a refusal. The
client therefore spends ONE shared Deadline over everything a hook run asks the dashboard (the facts, the record, the
invalidation), well inside that timeout:
  - one attempt is at most ATTEMPT_TIMEOUT_S (3 s) and never longer than what the deadline has left;
  - at most MAX_ATTEMPTS (2) per call, and the retry only while the deadline still has MIN_ATTEMPT_S left;
  - TOTAL_DEADLINE_S (7.5 s) for the whole run: with the interpreter start the worst case stays under 8 s, not 3 x 3 s;
  - a refused connection is NOT retried (the dashboard is down: deny fast, do not wait), nor is an HTTP answer in
    the 4xx range (deterministic: asking again gives the same answer). A timeout, a reset or a 5xx is retried once.
There is no cache and no fallback to another source: an answer that does not come in time is a failure, and the
caller fails closed. The token is the calling agent's own (dashboard_api / agent_token) and never appears in an error.
"""
import os
import socket
import sys
import time
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dashboard_api  # noqa: E402

TOTAL_DEADLINE_S = 7.5
ATTEMPT_TIMEOUT_S = 3.0
MAX_ATTEMPTS = 2
MIN_ATTEMPT_S = 0.3


class RouteError(Exception):
    """The dashboard did not answer usably. The text never carries the token or a response body."""


class Deadline:
    """One budget for a whole hook run. `clock` is a seam for the timing cells."""

    def __init__(self, total=TOTAL_DEADLINE_S, clock=time.monotonic):
        self._clock = clock
        self._end = clock() + total

    def remaining(self):
        return self._end - self._clock()


def _refused(err):
    reason = getattr(err, "reason", err)
    return isinstance(reason, ConnectionRefusedError)


def call(method, path, body, agent_id, deadline, session_id=None, max_attempts=MAX_ATTEMPTS):
    """One route call under the shared deadline -> the decoded JSON answer, or RouteError. `max_attempts` defaults to the
    tenant gates' 2; a hook that runs on every tool call (context-watchdog.py) passes 1: no retry."""
    last = "no attempt could start, the deadline is spent"
    for _ in range(max_attempts):
        left = deadline.remaining()
        if left < MIN_ATTEMPT_S:
            break
        try:
            return dashboard_api.request(
                method, path, body, timeout=min(ATTEMPT_TIMEOUT_S, left), agent_id=agent_id, session_id=session_id)
        except urllib.error.HTTPError as err:
            if err.code < 500:
                raise RouteError("%s %s: HTTP %d" % (method, path, err.code)) from None
            last = "HTTP %d" % err.code
        except urllib.error.URLError as err:
            if _refused(err):
                raise RouteError("%s %s: connection refused" % (method, path)) from None
            last = "unreachable (%s)" % type(getattr(err, "reason", err)).__name__
        except (socket.timeout, TimeoutError):
            last = "timeout"
        except ConnectionRefusedError:
            raise RouteError("%s %s: connection refused" % (method, path)) from None
        except OSError as err:
            last = "network error (%s)" % type(err).__name__
        except ValueError:
            # a body that is not JSON: the dashboard answered, asking again changes nothing
            raise RouteError("%s %s: the answer is not JSON" % (method, path)) from None
    raise RouteError("%s %s: %s" % (method, path, last))
