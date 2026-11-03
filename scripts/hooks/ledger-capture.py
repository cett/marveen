#!/usr/bin/env python3
"""UserPromptSubmit hook: capture inbound Telegram messages into the rolling
transcript (direction='in') BEFORE the agent processes the prompt. Deterministic
and agent-independent. agent_id is derived from the session's cwd so the hook is
generic across all three channel agents and never cross-contaminates. Never
blocks the prompt (always exit 0).
"""
import sys
import os
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# <channel source="plugin:telegram:telegram" chat_id="X" message_id="Y" ... ts="Z">
#   TEXT
# </channel>
#
# Only the OPENER is a pattern. The old single pattern `...([^>]*)>(.*?)</channel>` had no
# upper bound on either span, so a prompt full of openers and no '>' (or no closer) was
# quadratic (550 kB held this hook for ~20 s). channel_blocks() finds the closing '>' and
# `</channel>` with forward str.find calls whose results every later opener reuses, and
# takes an opener as an envelope only when its attribute span is at most
# CHANNEL_ATTRS_MAX characters; a real one is a few hundred.
CHANNEL_OPEN_RX = re.compile(r'<channel\s+source="plugin:telegram:telegram"')
CHANNEL_CLOSER = '</channel>'
CHANNEL_ATTRS_MAX = 2000


def channel_blocks(prompt):
    """[(attrs, text)] for every telegram <channel> envelope in the prompt, in order."""
    found = []
    pos = 0  # prompt[:pos] is inside an envelope already taken
    gt = -2  # first '>' at or after the last probe; -1 = none left, -2 = not probed yet
    ci = -2  # first closer at or after the last probe; -1 = none left, -2 = not probed yet
    for m in CHANNEL_OPEN_RX.finditer(prompt):
        start, end = m.span()
        if start < pos:
            continue
        if gt != -1 and gt < end:
            gt = prompt.find('>', end)
        if gt == -1:
            break  # no '>' left, so no later opener can close either
        if gt - end > CHANNEL_ATTRS_MAX:
            continue  # not an envelope: an over-long span is never a delivery frame
        if ci != -1 and ci < gt + 1:
            ci = prompt.find(CHANNEL_CLOSER, gt + 1)
        if ci == -1:
            break  # no closer left, so no later opener can close either
        found.append((prompt[end:gt], prompt[gt + 1:ci]))
        pos = ci + len(CHANNEL_CLOSER)
    return found


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    agent_id = ledger_lib.ledger_agent_id_from_cwd(payload.get("cwd"))
    if not agent_id:
        sys.exit(0)  # unknown cwd: not an agent, nothing to record
    prompt = payload.get("prompt") or ""
    for attrs, text in channel_blocks(prompt):
        chat_id = _attr(attrs, "chat_id")
        message_id = _attr(attrs, "message_id")
        ts = _attr(attrs, "ts")
        if chat_id and message_id:
            try:
                ledger_lib.log_inbound(agent_id, chat_id, message_id, text.strip(), ts)
            except Exception:
                pass  # never block the prompt on a ledger error
    sys.exit(0)


if __name__ == "__main__":
    main()
