#!/usr/bin/env python3
"""UserPromptSubmit hook: staleness guard.

Inbound channel messages carry the ORIGINAL send time on the <channel ... ts="...">
envelope. When the channel is healthy the gap between send and processing is a few
seconds. But when the poller lags or a backfill/watchdog re-delivers an orphaned
message (e.g. after a session restart), a message written much earlier can be
processed NOW -- and the agent, lacking that context, may execute a stale
instruction (the 2026-06-24 incident: a delayed "Küldd is el" triggered a client
email send via a raw API fallback).

This hook compares each inbound <channel> message's `ts` against the current time.
If the delivery gap exceeds STALENESS_THRESHOLD_SEC (default 300s = 5 min) it emits
a context note on stdout asking the agent to re-confirm before any irreversible or
outward-facing action. It NEVER blocks the prompt (always exit 0) and stays silent
for normal, fresh messages so it adds no noise.

Coverage note: this covers any channel that stamps `ts` on the <channel> envelope
(Telegram and the other native channel plugins). The marveenchat web UI does not
currently stamp inbound text with a timestamp, so web-chat inputs are not covered
here -- that needs the web layer to emit a send time (tracked separately).
"""
import sys
import os
import re
import json
from datetime import datetime, timezone

# Default 5 minutes; override with STALENESS_THRESHOLD_SEC.
DEFAULT_THRESHOLD_SEC = 300

# <channel source="..." chat_id="X" message_id="Y" ... ts="2026-06-24T05:40:30.000Z"> ... </channel>
# Only the OPENER is a pattern. A `<channel\s+([^>]*)>` span with no upper bound made a
# prompt full of openers and no '>' quadratic (550 kB held this hook for ~85 s, past
# its timeout). channel_attr_strings() looks up the closing '>' with one forward
# str.find shared by all openers, and takes an opener as a real envelope only when
# its attribute string is at most CHANNEL_ATTRS_MAX characters; a real envelope is a
# few hundred.
CHANNEL_OPEN_RX = re.compile(r'<channel\s+')
CHANNEL_ATTRS_MAX = 2000


def channel_attr_strings(prompt):
    """The attribute string of every <channel ...> envelope in the prompt, in order."""
    found = []
    copied = 0  # prompt[:copied] is inside an envelope already taken
    gt = -2  # first '>' at or after the last probe; -1 = none left, -2 = not probed yet
    for m in CHANNEL_OPEN_RX.finditer(prompt):
        start, end = m.span()
        if start < copied:
            continue
        if gt != -1 and gt < end:
            gt = prompt.find('>', end)
        if gt == -1:
            break  # no '>' left, so no later opener can close either
        if gt - end > CHANNEL_ATTRS_MAX:
            continue  # not an envelope: an over-long span is never a delivery frame
        found.append(prompt[end:gt])
        copied = gt + 1
    return found


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def _parse_ts(ts):
    """Parse an ISO-8601 UTC timestamp (trailing Z) to an aware datetime, or None."""
    if not ts:
        return None
    try:
        # Normalise trailing Z to +00:00 for fromisoformat.
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _threshold():
    raw = os.environ.get("STALENESS_THRESHOLD_SEC")
    if raw:
        try:
            v = int(float(raw))
            if v > 0:
                return v
        except Exception:
            pass
    return DEFAULT_THRESHOLD_SEC


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    prompt = payload.get("prompt") or ""
    if "<channel" not in prompt:
        sys.exit(0)

    threshold = _threshold()
    now = datetime.now(timezone.utc)

    # Find the largest delivery gap across all <channel> blocks in this prompt.
    worst_gap = -1
    for attrs in channel_attr_strings(prompt):
        ts = _parse_ts(_attr(attrs, "ts"))
        if ts is None:
            continue
        gap = (now - ts).total_seconds()
        if gap > worst_gap:
            worst_gap = gap

    if worst_gap < threshold:
        sys.exit(0)  # fresh enough -> stay silent

    mins = int(worst_gap // 60)
    # UserPromptSubmit stdout (exit 0) is injected into the model context.
    print(
        f"⚠️ FRISSESSEG-FIGYELMEZTETES (staleness guard): a fenti bejovo "
        f"uzenet kuldese ota mar legalabb ~{mins} perc telt el (a ts mezo alapjan). "
        f"Ez azt jelenti, hogy az uzenet KESLELTETVE lett kezbesitve (lagolo poller / "
        f"backfill / ujrakezbesites), ezert LEHET ELAVULT. Mielott barmilyen "
        f"visszafordithatatlan vagy kimeno muveletet vegrehajtasz (email-kuldes, fajl "
        f"torles/feluliras, kulso API hivas, fizetes), eloszor ellenorizd hogy a keres "
        f"meg aktualis-e, es kerdezz vissza a feladonal ha barmi ketseg van. NE "
        f"hajtsd vegre vakon a kesve erkezett utasitast."
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
