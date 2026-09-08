#!/usr/bin/env python3
"""PostToolUse hook: block tool responses that carry an explicit prompt-injection
marker, before that content reaches the model's context.

Scope (Jonas' decision): only external-content-bearing tools -- mcp__* and
WebFetch. Bash/Read/Edit are internal/trusted sources and are skipped.

Detection (Jonas' decision): "Level A" only -- explicit, low-false-positive
injection phrases (role-switch markers, "ignore previous instructions", chat
template delimiters). No size/entropy heuristics yet (tracked separately).

Contract: exit 0 = allow (silent, matches CC's PostToolUse convention), exit 2
= block (stderr is surfaced to the model in place of the tool result).

Fail-closed (CLAUDE.md "Hook fail-closed policy", approved 2026-09-08): unlike
the logging-only tool-log-capture.py (which always exits 0), THIS hook is an
interception gate -- any internal failure (unparseable payload, unexpected
exception) is treated as DENY, not silently passed through. Only the two
best-effort notification calls (audit-log POST, Jarvis alert POST) are
allowed to fail without affecting the verdict; they never widen or narrow it.

Registered ahead of tool-log-capture.py in the PostToolUse array so a block
here is what CC/the model actually sees; tool-log-capture still runs after
(CC invokes every matching PostToolUse hook regardless of an earlier block).
"""
import sys
import os
import re
import json
import hashlib
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# In scope: MCP tool calls and WebFetch (external content). Everything else
# (Bash, Read, Edit, Write, Grep, Glob, WebSearch's own query, ...) is skipped.
def _in_scope(tool_name: str) -> bool:
    return tool_name.startswith('mcp__') or tool_name == 'WebFetch'


# "Level A" -- explicit injection phrases only, (name, compiled pattern).
_PATTERNS = [
    ('ignore_instructions', re.compile(r'(?i)\bignore (all )?(previous|prior|above) instructions?\b')),
    ('forget_everything', re.compile(r'(?i)\bforget (everything|all|previous)\b')),
    ('fake_turn_marker', re.compile(r'(?i)\n\s*(Human|Assistant|System)\s*:')),
    ('chatml_marker', re.compile(r'(?i)<\|im_(start|end)\|>')),
    ('llama_inst_marker', re.compile(r'\[INST\]|\[/INST\]')),
]


def _stringify(resp) -> str:
    """Flatten whatever shape tool_response takes (str / dict / content-block
    list / nested) into a single string to scan. Best-effort, never raises."""
    if resp is None:
        return ''
    if isinstance(resp, str):
        return resp
    if isinstance(resp, list):
        return '\n'.join(_stringify(item) for item in resp)
    if isinstance(resp, dict):
        for key in ('content', 'text', 'output', 'result'):
            if key in resp:
                val = _stringify(resp[key])
                if val:
                    return val
        return '\n'.join(_stringify(v) for v in resp.values())
    return str(resp)


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_project_root(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ''


def _post(base_url: str, token: str, endpoint: str, payload: dict) -> None:
    """Best-effort POST -- never raises, never affects the verdict."""
    if not token:
        return
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f'{base_url}{endpoint}',
                data=json.dumps(payload).encode(),
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
                method='POST',
            ),
            timeout=3,
        )
    except Exception:
        pass


def _notify_block(agent_id, session_id, tool_name, reason, content_hash) -> None:
    token = _dashboard_token()
    base_url = f'http://localhost:{_web_port()}/api'

    _post(base_url, token, '/hook-audit', {
        'agent_id': agent_id,
        'hook_type': 'PostToolUse',
        'verdict': 'deny',
        'tool_name': tool_name,
        'content_hash': content_hash,
        'reason': reason,
        'session_id': session_id,
    })

    # Rare event by design -- worth a visible Telegram alert, not just a log
    # row. Jarvis is the fleet's supervision channel and relays urgent
    # inter-agent messages to Telegram itself.
    _post(base_url, token, '/messages', {
        'from': agent_id or 'unknown',
        'to': 'jarvis',
        'content': (
            f"[HOOK-ALERT] post-tool-injection-gate BLOKKOLT: agent={agent_id or '?'} "
            f"tool={tool_name} reason={reason} session={session_id or '?'}. "
            f"Reszletek: GET /api/hook-audit?verdict=deny"
        ),
    })


def _deny(reason: str, detail: str) -> None:
    sys.stderr.write(
        "POST-TOOL INJECTION GATE: BLOKKOLVA.\n"
        f"Ok: {reason}\n{detail}\n"
        "A tool eredmenye gyanus injection-mintat tartalmazott (vagy a kapu nem "
        "tudta ertelmesen megvizsgalni -- fail-closed), ezert nem kerult be a "
        "kontextusba. Reszletek: GET /api/hook-audit?verdict=deny\n"
    )
    sys.exit(2)


def main():
    try:
        raw = sys.stdin.read()
    except Exception as exc:
        _deny('stdin_read_failed', repr(exc))
        return

    try:
        payload = json.loads(raw)
    except Exception as exc:
        _deny('payload_unparseable', repr(exc))
        return

    try:
        tool_name = str(payload.get('tool_name') or '')
        session_id = payload.get('session_id') or None
        cwd = payload.get('cwd') or ''
        agent_id = ledger_lib.agent_id_from_cwd(cwd)

        if not _in_scope(tool_name):
            sys.exit(0)

        text = _stringify(payload.get('tool_response'))
        if not text:
            sys.exit(0)  # nothing to inspect -- not an error, just empty content

        for reason, pattern in _PATTERNS:
            if pattern.search(text):
                content_hash = hashlib.sha256(text[:4096].encode('utf-8', errors='replace')).hexdigest()
                try:
                    _notify_block(agent_id, session_id, tool_name, reason, content_hash)
                except Exception:
                    pass  # notification failures never change the verdict
                _deny(f'injection_pattern_{reason}', f'tool={tool_name}')
                return

        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate: any internal failure fails CLOSED here
        _deny('internal_error', repr(exc))


if __name__ == '__main__':
    main()
