#!/usr/bin/env python3
"""Interrupted-turn hint (5aa63510 W3 / J1): one thin hook, three modes.

  inflight-turn.py begin    UserPromptSubmit: note that a turn started
  inflight-turn.py end      Stop:             the turn finished, drop the note
  inflight-turn.py replay   SessionStart:     if a note is still there (young, not offered yet) the
                                              previous turn was cut off: tell the new session

Claude Code does not re-run a turn that a crash, a watchdog respawn or a host restart cut off, so an
inter-agent message or a channel prompt injected right before the death used to vanish without a
trace. This hook only ADVISES the new session ("your previous turn was cut off, decide whether it
needs doing again, check for side effects first"); it never replays anything.

Known false positive: a user interrupt (Esc) runs no Stop hook, so the note survives and one needless
hint can follow the next restart. The server bounds it: 6 hours TTL and a single offer per note.

Thin by design, like taskstate-replay.py: classification, the TTL, the single-offer rule and the hint
text all live in the dashboard (src/db/agent-inflight-turns.ts, unit-tested). This script carries the
agent, the head of the prompt and a hash, and prints what the dashboard returns.

This is a LOGGING hook, not a gate: it must never break the session. A UserPromptSubmit or Stop hook
that exits non-zero blocks the prompt / the stop, so every path ends in exit 0, begin and end print
nothing (UserPromptSubmit stdout would be added to the prompt as context), and a dashboard that is
down or an agent that cannot be resolved is a silent no-op.
"""
import hashlib
import json
import os
import sys
import urllib.parse

# The server caps prompt_head at 4000 UTF-16 code units. A Python slice counts code points, and an
# astral character (an emoji) is two units, so 2000 code points can never exceed the cap.
HEAD_CHARS = 2000
WRITE_TIMEOUT = 2
# The offer is the one call where waiting is worth it: it runs once per session start.
READ_TIMEOUT = 5


def _agent_and_api(payload):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import agent_token
    import dashboard_api
    import ledger_lib
    agent = ledger_lib.ledger_agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        return None, dashboard_api
    # No own token file, no call: the shared token is never used, and an unsigned request is only
    # refused (same rule as taskstate-replay.py).
    if not agent_token.resolve(agent_id=agent, store_dir=dashboard_api.store_dir()).token:
        return None, dashboard_api
    return agent, dashboard_api


def _path(agent, action):
    return "/api/agent-inflight-turn/%s/%s" % (urllib.parse.quote(agent, safe=""), action)


def begin(payload, agent, api):
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        return
    api.request("POST", _path(agent, "begin"), {
        "prompt_head": prompt[:HEAD_CHARS],
        "prompt_hash": hashlib.sha256(prompt.encode("utf-8", "replace")).hexdigest()[:16],
    }, timeout=WRITE_TIMEOUT, agent_id=agent)


def end(payload, agent, api):
    api.request("POST", _path(agent, "end"), {}, timeout=WRITE_TIMEOUT, agent_id=agent)


def replay(payload, agent, api):
    source = payload.get("source")
    if not isinstance(source, str):
        return
    res = api.request("GET", _path(agent, "replay") + "?source=" + urllib.parse.quote(source, safe=""),
                      timeout=READ_TIMEOUT, agent_id=agent) or {}
    text, turn_id = res.get("additionalContext"), res.get("turn_id")
    if not text or not turn_id:
        return
    # PRINT first, consume after: a crash before the print leaves the note unconsumed, so the next
    # start still offers it.
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}},
                     ensure_ascii=False))
    sys.stdout.flush()
    try:
        api.request("POST", _path(agent, "consume"), {"turn_id": turn_id}, timeout=WRITE_TIMEOUT, agent_id=agent)
    except Exception:
        pass  # worst case the hint is offered once more at the next start


MODES = {"begin": begin, "end": end, "replay": replay}


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    handler = MODES.get(mode)
    if handler is None:
        return
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        return
    agent, api = _agent_and_api(payload)
    if not agent:
        return  # an unknown cwd (a scratch dir, a worktree) is not an agent identity
    handler(payload, agent, api)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception:
        pass  # dashboard down, bad payload, import trouble: never block the session
    sys.exit(0)
