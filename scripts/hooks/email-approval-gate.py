#!/usr/bin/env python3
"""PreToolUse gate on the MAIN agent's outbound email: no mail leaves without the owner's approval.

What it enforces (the email_send autonomy category at level 2, made real):

  * A call that sends a mail is bound to the sha256 of the mail it sends (scripts/lib/email_extract.py
    reads the call, the dashboard server computes the same hash from the same fields). The gate spends
    ONE approval for that hash with POST /api/approvals/claim, made with the main agent's own token.
    The server hands an approval over only when it is approved, inside its use window, not used yet,
    requested by this agent for this hash and decided by a person on the dashboard.
  * No usable approval: the call is refused and, when there is none open, a request is opened for the
    owner (POST /api/approvals). The refusal text says what to do next.
  * Everything else about the call is refused too: level 1, an unreadable level, a server that does not
    enforce human-only decisions (the agent could approve its own mail), a mail the reader cannot state
    exactly, a dashboard that does not answer.

The copy gate (outgoing-copy-gate.py) runs FIRST, in this process, so the owner never decides on a text
the copy gate would bounce and no approval burns on a refused call. Its verdict (exit code, stderr and
the systemMessage on stdout) is taken as it is.

FAIL CLOSED, no switch. Every failure is exit 2 with the reason: bad input, a part that does not load
(named by file), an unreadable mail, a service that does not answer or answers nonsense. There is no
shadow mode and no environment flag that relaxes this. The base URL is NOT taken from the agent's
environment (an agent that can set DASHBOARD_BASE_URL must not be able to point its gate at a server
that says yes): it is WEB_PORT from <install>/.env, else 3420, on the IP address the dashboard listens on (WEB_HOST from
.env when that is an IP address, else 127.0.0.1; never the name localhost, which can resolve to ::1 where a
listener of the agent's could answer; a WEB_HOST that is a name makes every call fail closed), no proxy, no redirect. The claim answer must name this mail's hash, this
category, this agent and this use (the reference the gate made up): a listener that is not the dashboard cannot.
The answer must also be SIGNED: `sig` is HMAC-SHA256 of v1|hash|category|agent_id|ref|consumed_at under the key in
<install>/store/.claim-signing-key (the dashboard writes it; read here from the gate's own install path, never
from the environment). A mirror of the request that echoes every field still has no key: a missing or wrong `sig`,
a missing, unreadable or short key, or a missing consumed_at refuses the call (code claim_unsigned). The key file is
protected only as far as the hooks that guard the store's secrets protect it (see SECURITY.md).

Honest limit: this fires on the calls it recognises (Bash mail commands, the mail tools). A mail sent
by a script the agent writes itself is not seen; the official sender (K8) and its sender-side claim
narrow that, they do not close it.

Contract: PreToolUse. stdin = the hook payload; exit 0 = allow (stdout may carry a systemMessage),
exit 2 = block (stderr goes back to the model). Every verdict about a mail call is one line in
store/email-approval-gate.log (never the mail text: the hash prefix, the number of recipients, the
level, the reason). Registered in the root .claude/settings.json by the owner (matcher: EMAIL_GATE_MATCHER);
a session reads settings at start, so a registration needs a restart.

Standard library only.
"""
from __future__ import annotations

import hmac
import importlib.util
import io
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
INSTALL = os.path.dirname(SCRIPTS)
STORE = os.path.join(INSTALL, 'store')
LOG_PATH = os.path.join(STORE, 'email-approval-gate.log')

REL_COPY_GATE = 'scripts/hooks/outgoing-copy-gate.py'
REL_EXTRACT = 'scripts/lib/email_extract.py'
REL_TOKEN = 'scripts/hooks/agent_token.py'

# The tool names the gate is registered for (settings.json matcher). A drift test keeps the registered
# matcher and this constant equal, and checks that every tool the classifier calls a send matches it.
EMAIL_GATE_MATCHER = 'Bash|.*send_email.*|.*manage_email.*|.*[Gg]mail.*__.*|.*draft_email.*'

CATEGORY = 'email_send'
CONSUMER = 'email-approval-gate'
CLAIM_KEY_PATH = os.path.join(STORE, '.claim-signing-key')
_KEY_HEX = re.compile(r'[0-9a-f]{64}')
TOTAL_BUDGET_S = 7.0   # the registration wraps the script in `timeout -k 1 8`; three calls fit in this
CALL_TIMEOUT_S = 2.0
MAX_RESPONSE_BYTES = 1024 * 1024
DEFAULT_PORT = '3420'
DEFAULT_HOST = '127.0.0.1'

# Claim answers (HTTP 409 `reason`) after which a new request is opened for the owner.
OPEN_REQUEST_REASONS = frozenset(('none', 'expired', 'already_consumed', 'rejected', 'not_human_decided'))

# manage_email / connector actions that are certainly not a send. Anything else on those tools is a send
# (an unknown action is read as the dangerous one).
NON_SEND_ACTIONS = frozenset((
    'search', 'read', 'list', 'get', 'fetch', 'count', 'mark', 'mark_read', 'mark_unread', 'label', 'unlabel',
    'archive', 'unarchive', 'trash', 'untrash', 'delete', 'move', 'star', 'unstar', 'draft', 'create_draft',
    'update_draft', 'list_labels', 'get_thread', 'get_message',
))

_CONTROL = re.compile(r'[\x00-\x1f\x7f  ]+')


class Deny(Exception):
    """A refusal: `code` goes to the log, `text` to the model."""

    def __init__(self, code: str, text: str) -> None:
        super().__init__(code)
        self.code = code
        self.text = text


# ---------------------------------------------------------------------------------------------------
# Guarded loading. A part that fails to load is a refusal that names the file, never an exit 1 (which
# PreToolUse reads as "not blocking").
# ---------------------------------------------------------------------------------------------------

def _load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError('no loader for ' + path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _try_load(name: str, rel: str) -> Tuple[Any, Optional[str]]:
    try:
        return _load_module(name, os.path.join(INSTALL, rel)), None
    except BaseException as exc:  # noqa: BLE001 -- SystemExit from a broken module too
        return None, '%s (%s)' % (rel, type(exc).__name__)


def _need(mod: Any, err: Optional[str], rel: str) -> Any:
    if mod is None:
        raise Deny('load_error', _deny_text('a kapu egyik resze nem toltheto be: %s.' % (err or rel)))
    return mod


# ---------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------

def _clean(text: Any, limit: int) -> str:
    s = _CONTROL.sub(' ', str(text if text is not None else ''))
    s = re.sub(r' {2,}', ' ', s).strip()
    return s if len(s) <= limit else s[:limit] + '...'


def _env_file_value(key: str) -> Optional[str]:
    # The install's .env only. Not os.environ: that is the agent's to set.
    try:
        with open(os.path.join(INSTALL, '.env'), encoding='utf-8') as fh:
            for line in fh:
                if line.startswith(key + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def _port() -> str:
    v = _env_file_value('WEB_PORT')
    return v if v and v.isdigit() and 0 < int(v) < 65536 else DEFAULT_PORT


def _host() -> str:
    """The address the dashboard listens on: WEB_HOST from .env when it is an IP address, else 127.0.0.1.
    Never the name 'localhost': a name can resolve to ::1 as well, where a listener the agent started could
    answer in the dashboard's place."""
    v = _env_file_value('WEB_HOST')
    if v is not None and v != '':
        try:
            ip = ipaddress.ip_address(v)
        except ValueError:
            # A name may resolve differently for the dashboard (which binds it) and for the gate: no guessing.
            raise Unavailable('WEB_HOST is not an IP address')
        if not ip.is_unspecified:
            return '[%s]' % ip if ip.version == 6 else str(ip)
    return DEFAULT_HOST


def base_url() -> str:
    return 'http://%s:%s' % (_host(), _port())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any):  # noqa: D401
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


class Unavailable(Exception):
    pass


def _http(method: str, path: str, body: Optional[Dict[str, Any]], headers: Dict[str, str], deadline: float) -> Tuple[int, Any]:
    """(status, parsed JSON or None). Raises Unavailable when there is no answer at all."""
    remaining = deadline - time.monotonic()
    if remaining < 0.3:
        raise Unavailable('time budget used up')
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers=headers)
    try:
        with _OPENER.open(req, timeout=min(CALL_TIMEOUT_S, remaining)) as resp:
            status, raw = resp.status, resp.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        try:
            status, raw = exc.code, exc.read(MAX_RESPONSE_BYTES + 1)
        except Exception:  # noqa: BLE001
            status, raw = exc.code, b''
    except Exception as exc:  # noqa: BLE001 -- refused, timed out, DNS, reset ...
        raise Unavailable(type(exc).__name__)
    if len(raw) > MAX_RESPONSE_BYTES:
        return status, None
    try:
        return status, json.loads(raw.decode('utf-8')) if raw else None
    except Exception:  # noqa: BLE001
        return status, None


# ---------------------------------------------------------------------------------------------------
# Which calls are sends
# ---------------------------------------------------------------------------------------------------

def tool_is_send(tool: str, tool_input: Dict[str, Any]) -> bool:
    """A mail tool call that sends (a draft, a search, a label change are not sends)."""
    name = tool.lower()
    last = name.split('__')[-1]
    if 'send_email' in name:
        return True
    if 'manage_email' in name:
        if tool_input.get('draft') is True or str(tool_input.get('draft')).lower() == 'true':
            return False
        action = str(tool_input.get('action') or tool_input.get('operation') or '').strip().lower()
        return action not in NON_SEND_ACTIONS
    if 'gmail' in name:
        # reply, reply_all, send_message, forward, gmail_send_email, send_draft ...; a name with a verb
        # of sending is a send even when it also says draft (send_draft sends text the gate cannot see).
        return any(w in last for w in ('send', 'reply', 'forward'))
    return False


def call_is_send(tool: str, tool_input: Dict[str, Any], copy_gate: Any, extract: Any, extract_err: Optional[str] = None) -> bool:
    if tool == 'Bash':
        cmd = tool_input.get('command')
        if not isinstance(cmd, str):
            raise Deny('bad_input', 'a Bash hivas parancsa nem szoveg, igy nem ertelmezheto.')
        if copy_gate.is_send_invocation(cmd):
            return True
        if extract is None:
            # No second list of mail program names lives here (it would go stale): without the reader a
            # Bash call cannot be told from a send, so it is refused, naming the file.
            raise Deny('load_error', _deny_text('a kapu egyik resze nem toltheto be: %s (Bash hivas nem osztalyozhato nelkule).' % extract_err))
        return bool(extract.command_sends_mail(cmd))
    return tool_is_send(tool, tool_input)


class BadSignature(Exception):
    """The claim answer is not signed by the dashboard; the text says why (never the key)."""


def check_claim_signature(got: Dict[str, Any], approval: Dict[str, Any], expect: Dict[str, Any], ref: str) -> None:
    """Raise BadSignature unless `got['sig']` is the dashboard's signature of this claim.

    The signed text is built from the values the gate EXPECTS (hash, category, agent, its own ref), which the
    echo check has just compared with the answer, plus consumed_at, which only the answer can supply."""
    def refuse(why: str) -> BadSignature:
        return BadSignature(why)

    try:
        with open(CLAIM_KEY_PATH, encoding='ascii') as fh:
            key_text = fh.read(256).strip()
    except (OSError, UnicodeDecodeError):
        raise refuse('az alairo kulcs (store/.claim-signing-key) nem olvashato')
    if not _KEY_HEX.fullmatch(key_text):
        raise refuse('az alairo kulcs nem 64 hex karakter')
    consumed_at = approval.get('consumed_at')
    if not isinstance(consumed_at, int) or isinstance(consumed_at, bool) or consumed_at <= 0:
        raise refuse('hianyzik a consumed_at')
    sig = got.get('sig')
    if not isinstance(sig, str) or not sig:
        raise refuse('hianyzik a sig')
    text = 'v1|%s|%s|%s|%s|%d' % (expect['content_hash'], expect['category'], expect['agent_id'], ref, consumed_at)
    want = hmac.new(bytes.fromhex(key_text), text.encode('utf-8'), 'sha256').hexdigest()
    try:
        same = hmac.compare_digest(sig.encode('ascii'), want.encode('ascii'))
    except UnicodeEncodeError:
        same = False
    if not same:
        raise refuse('rossz sig')


# ---------------------------------------------------------------------------------------------------
# The copy gate, in this process, first
# ---------------------------------------------------------------------------------------------------

def run_copy_gate(copy_gate: Any, raw: str) -> Tuple[int, str, str]:
    """(exit code, stderr, stdout) the copy gate gives for this payload. Any other end is a refusal."""
    old_in, old_out, old_err = sys.stdin, sys.stdout, sys.stderr
    out, err = io.StringIO(), io.StringIO()
    sys.stdin, sys.stdout, sys.stderr = io.StringIO(raw), out, err
    code: Any = 0
    try:
        try:
            copy_gate.main()
        except SystemExit as exc:
            code = exc.code
    except Exception as exc:  # noqa: BLE001
        code = 2
        err.write('KIMENO-SZOVEG KAPU: TILTVA, belso hiba a vizsgalat kozben (%r).\n' % (exc,))
    finally:
        sys.stdin, sys.stdout, sys.stderr = old_in, old_out, old_err
    if code in (None, 0):
        return 0, err.getvalue(), out.getvalue()
    return 2, err.getvalue(), out.getvalue()


def _system_messages(stdout_text: str) -> List[str]:
    msgs: List[str] = []
    for line in stdout_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(obj, dict) and isinstance(obj.get('systemMessage'), str):
            msgs.append(obj['systemMessage'])
    return msgs


# ---------------------------------------------------------------------------------------------------
# The approval logic
# ---------------------------------------------------------------------------------------------------

FOOTER = (
    '\nA jovahagyast CSAK a tulajdonos adhatja, a dashboardon. TILOS az onjovahagyas, es a jovahagyas-adatok '
    '(fajl, adatbazis) kozvetlen szerkesztese; ez a hivas nem megy ki jovahagyas nelkul.\n'
)


def _mail_summary(env: Dict[str, Any], h12: str) -> str:
    def addrs(k: str) -> str:
        v = env.get(k) or []
        return ', '.join(_clean(a, 120) for a in v[:10]) + (' ...' if len(v) > 10 else '')
    lines = ['  hash: %s' % h12, '  cimzettek: %s' % addrs('to')]
    if env.get('cc'):
        lines.append('  cc: %s' % addrs('cc'))
    if env.get('bcc'):
        lines.append('  bcc: %s' % addrs('bcc'))
    lines.append('  targy: %s' % _clean(env.get('subject'), 120))
    lines.append('  torzs eleje: %s' % _clean(env.get('body'), 120))
    return '\n'.join(lines)


def _deny_text(head: str, env: Optional[Dict[str, Any]] = None, h12: str = '', tail: str = '') -> str:
    parts = ['EMAIL-JOVAHAGYAS KAPU: TILTVA -- %s\n' % head]
    if env is not None:
        parts.append(_mail_summary(env, h12) + '\n')
    if tail:
        parts.append(tail.rstrip('\n') + '\n')
    parts.append(FOOTER)
    return ''.join(parts)


def _level_of(obj: Any) -> Tuple[int, Optional[bool]]:
    """(effective level of email_send, approvalHumanOnlyEnforce). Raises Deny when it cannot be decided."""
    if not isinstance(obj, dict) or not isinstance(obj.get('categories'), list):
        raise Deny('autonomy_unreadable', _deny_text('az email_send szintje nem eldontheto (a dashboard valasza ertelmezhetetlen).'))
    row = next((c for c in obj['categories'] if isinstance(c, dict) and c.get('key') == CATEGORY), None)
    if row is None:
        raise Deny('autonomy_unreadable', _deny_text('az email_send kategoria nincs a dashboard valaszaban, a szint nem eldontheto; ez NEM level 1 csendben.'))
    level, cap = row.get('level'), row.get('maxLevel')
    if isinstance(level, bool) or not isinstance(level, int):
        raise Deny('autonomy_unreadable', _deny_text('az email_send szintje nem szam, a szint nem eldontheto.'))
    effective = min(level, cap) if (isinstance(cap, int) and not isinstance(cap, bool)) else level
    enforce = obj.get('approvalHumanOnlyEnforce')
    return effective, (enforce if isinstance(enforce, bool) else None)


def decide(raw: str, log: Dict[str, Any]) -> str:
    """Run the whole gate. Returns the stdout text (a systemMessage or nothing) on an allow; raises Deny on a refusal."""
    # 2. input
    try:
        payload = json.loads(raw)
    except Exception:  # noqa: BLE001
        raise Deny('bad_input', _deny_text('a hook bemenete nem ertheto (nem JSON); egy vizsgalhatatlan hivas nem mehet at.'))
    if not isinstance(payload, dict) or not isinstance(payload.get('tool_name'), str) or not isinstance(payload.get('tool_input'), dict):
        raise Deny('bad_input', _deny_text('a hook bemenete nem ertheto (nincs tool_name vagy a tool_input nem objektum).'))
    tool, tool_input = payload['tool_name'], payload['tool_input']
    log['tool'] = tool[:80]

    # 3 + 4. the copy gate, first, always
    copy_gate, copy_err = _try_load('outgoing_copy_gate_in_email_gate', REL_COPY_GATE)
    _need(copy_gate, copy_err, REL_COPY_GATE)
    code, copy_stderr, copy_stdout = run_copy_gate(copy_gate, raw)
    if code != 0:
        raise Deny('copy_gate', copy_stderr or 'KIMENO-SZOVEG KAPU: TILTVA (a masolat-kapu nem adott okot).\n')
    messages = _system_messages(copy_stdout)

    extract, extract_err = _try_load('email_extract_in_email_gate', REL_EXTRACT)

    # 1. not a send: nothing more to do, the dashboard is not called
    if not call_is_send(tool, tool_input, copy_gate, extract, extract_err):
        return _emit(messages)
    log['send'] = True
    if extract is None:
        raise Deny('load_error', _deny_text('a kapu egyik resze nem toltheto be: %s.' % extract_err))
    token_mod, token_err = _try_load('agent_token_in_email_gate', REL_TOKEN)
    _need(token_mod, token_err, REL_TOKEN)

    resolved = token_mod.resolve(kind=token_mod.KIND_MAIN, store_dir=STORE)
    if not resolved.token or resolved.source != token_mod.SOURCE_AGENT or not resolved.agent_id:
        raise Deny('no_own_token', _deny_text('a fo agens sajat tokenje nem olvashato, igy a jovahagyas nem kerdezheto le. Egy megosztott token nem azonositja a kerot.'))
    headers = resolved.headers({'Content-Type': 'application/json'})
    deadline = time.monotonic() + TOTAL_BUDGET_S

    # 5-8. the level
    try:
        status, auto = _http('GET', '/api/autonomy', None, headers, deadline)
    except Unavailable as exc:
        raise Deny('autonomy_unavailable', _deny_text('az email_send szintje nem eldontheto (a dashboard nem valaszol: %s).' % exc))
    if status != 200:
        raise Deny('autonomy_unavailable', _deny_text('az email_send szintje nem eldontheto (a dashboard HTTP %d-et adott).' % status))
    level, enforce = _level_of(auto)
    log['level'] = level
    if level <= 1:
        raise Deny('level1', _deny_text('az email_send szintje %d: a kuldes KEMENYEN tiltva, nincs hatso ajto. Ne probalkozz masik uttal.' % level))
    if level >= 3:
        raise Deny('level_high', _deny_text('az email_send szintje %d, a kapu csak a 2-est fogadja el (fail-closed).' % level))
    if level != 2:
        raise Deny('autonomy_unreadable', _deny_text('az email_send szintje (%r) ervenytelen.' % level))
    if enforce is not True:
        raise Deny('enforce_off', _deny_text('a human-only kikenyszeritas nincs bekapcsolva a dashboardon, igy a jovahagyas nem bizonyitek (az ugynok sajat tokenjevel is jovahagyhatna). A tulajdonosnak be kell kapcsolnia.'))

    # 9. the mail
    built = extract.envelope_of_call(tool, tool_input, resolved.agent_id, payload.get('cwd') if isinstance(payload.get('cwd'), str) else None)
    if not built.get('ok'):
        why = _clean(built.get('hint') or built.get('field') or 'ismeretlen ok', 400)
        log['unreadable'] = why[:200]
        raise Deny('unreadable', _deny_text(
            'a levelet nem tudom pontosan kiolvasni a hivasbol: %s' % why,
            tail='Tedd olvashatova: egyetlen levelet kuldj hivasonkent, a cimzettek (to), a targy es a torzs LITERAL ertek legyen '
                 '(shell-valtozo, behelyettesites, pipe nelkul; hosszu torzs: fajl abszolut utvonallal), valaszhoz is add meg a cimzettet.'))
    env, canon, content_hash = built['envelope'], built['canon'], built['hash']
    h12 = content_hash[:12]
    log['hash'] = h12
    log['rcpt'] = sum(len(env.get(k) or []) for k in ('to', 'cc', 'bcc'))
    if env.get('html_sha256'):
        # The owner is shown the text part and the fingerprint of the HTML; the recipient reads the HTML.
        # Harmless text could be approved and another page sent. Refused until the HTML can be shown as text.
        log['unreadable'] = 'html part'
        raise Deny('html_part', _deny_text(
            'HTML resz nem ellenorizheto jovahagyaskor: a tulajdonos a szoveget latja, a cimzett a HTML-t kapja.', env, h12,
            'Kuldd a levelet csak szovegkent (html / --html / HTML mime-resz nelkul).'))
    if not (env.get('to')) or (not str(env.get('body') or '').strip() and not env.get('html_sha256')):
        raise Deny('unreadable', _deny_text('a level cimzettje vagy torzse ures, egy ures level nem jovahagyhato.', env, h12))

    # 10-13. spend an approval
    claim_body = {'category': CATEGORY, 'content_hash': content_hash, 'consumer': CONSUMER, 'ref': 'gate-' + uuid.uuid4().hex}
    try:
        status, got = _http('POST', '/api/approvals/claim', claim_body, headers, deadline)
    except Unavailable as exc:
        raise Deny('claim_unavailable', _deny_text('a jovahagyas-szolgaltatas nem elerheto (%s); fail-closed, ujra kell probalni.' % exc, env, h12))
    if status == 200:
        approval = got.get('approval') if isinstance(got, dict) else None
        if isinstance(got, dict) and got.get('ok') is True and isinstance(approval, dict):
            # The answer must be about THIS mail, this agent and this use: a listener that is not the dashboard
            # can say 200, it cannot know the hash and the reference the gate just made up.
            expect = {'content_hash': content_hash, 'category': CATEGORY, 'agent_id': resolved.agent_id, 'status': 'approved',
                      'consumed_by': resolved.agent_id, 'consumed_ref': claim_body['ref']}
            wrong = [k for k, v in expect.items() if approval.get(k) != v]
            if wrong:
                log['reason'] = 'mismatch ' + ','.join(wrong)
                raise Deny('claim_mismatch', _deny_text('a jovahagyas-szolgaltatas valasza nem erre a levelre / erre az ugynokre / erre a felhasznalasra szol (%s); fail-closed.' % ', '.join(wrong), env, h12))
            try:
                check_claim_signature(got, approval, expect, claim_body['ref'])
            except BadSignature as bad:
                log['reason'] = 'unsigned'
                raise Deny('claim_unsigned', _deny_text('a jovahagyas-szolgaltatas valasza alairatlan vagy az alairas nem ervenyes (%s); fail-closed.' % bad, env, h12))
            log['approval'] = _clean(approval.get('id'), 40)
            messages.append('Email-jovahagyas elfogyasztva (id %s, hash %s): ez a level egyszer kuldheto el.' % (_clean(approval.get('id'), 40), h12))
            return _emit(messages)
        raise Deny('claim_bad_answer', _deny_text('a jovahagyas-szolgaltatas valasza ertelmezhetetlen; fail-closed.', env, h12))
    if status != 409 or not isinstance(got, dict) or not isinstance(got.get('reason'), str):
        raise Deny('claim_unavailable', _deny_text('a jovahagyas-szolgaltatas nem elerheto (HTTP %d); fail-closed, ujra kell probalni.' % status, env, h12))
    reason = got['reason']
    log['reason'] = reason[:40]
    if reason == 'pending':
        aid = _clean(got.get('approval_id'), 60)
        raise Deny('pending', _deny_text(
            'erre a levelre mar van fuggo jovahagyasi kerelem (id %s), a tulajdonos meg nem dontott.' % aid, env, h12,
            'Ne kerj ujat. A dashboard Jovahagyasok oldalan (%s) dont; a dontesrol rendszeruzenetet kapsz, utana kuldd ujra PONTOSAN ugyanezt a levelet.' % base_url()))
    if reason not in OPEN_REQUEST_REASONS:
        raise Deny('claim_unexpected', _deny_text('a jovahagyas-szolgaltatas ismeretlen okot adott (%s); fail-closed.' % _clean(reason, 40), env, h12))

    # 12/14. nothing usable: open a request for the owner, then refuse
    try:
        status, opened = _http('POST', '/api/approvals', {
            'agent_id': resolved.agent_id, 'category': CATEGORY, 'content_hash': content_hash, 'action_payload': canon,
        }, headers, deadline)
    except Unavailable as exc:
        raise Deny('request_failed', _deny_text('a jovahagyasi kerelmet nem sikerult megnyitni (%s).' % exc, env, h12))
    if status in (200, 201) and isinstance(opened, dict) and isinstance(opened.get('id'), str):
        oid = _clean(opened['id'], 60)
        log['approval'] = oid
        raise Deny('requested', _deny_text(
            'a levelhez a tulajdonos jovahagyasa kell; a kerelem %s (id %s, elozo allapot: %s).' % (
                'mar nyitva volt' if opened.get('deduplicated') else 'megnyitva', oid, reason),
            env, h12,
            'A tulajdonos a dashboard Jovahagyasok oldalan (%s) dont. A dontesrol rendszeruzenetet kapsz; utana kuldd ujra PONTOSAN ugyanezt a levelet '
            '(barmi valtozik benne, uj jovahagyas kell). A jovahagyas egyszer hasznalhato es korlatozott ideig ervenyes.' % base_url()))
    detail = ''
    if isinstance(opened, dict):
        detail = _clean(opened.get('hint') or opened.get('reason') or opened.get('error'), 200)
    raise Deny('request_failed', _deny_text('a jovahagyasi kerelmet nem sikerult megnyitni (HTTP %d%s).' % (status, ': ' + detail if detail else ''), env, h12))


def _emit(messages: List[str]) -> str:
    return json.dumps({'systemMessage': ' | '.join(messages)}) + '\n' if messages else ''


# ---------------------------------------------------------------------------------------------------
# Log and entry point
# ---------------------------------------------------------------------------------------------------

def _write_log(log: Dict[str, Any], verdict: str, code: str, started: float) -> None:
    """One line per verdict about a mail call (and per refusal of anything). A failure to write the
    log changes no verdict."""
    try:
        entry = {'ts': datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'), 'verdict': verdict, 'code': code,
                 'ms': int((time.monotonic() - started) * 1000)}
        entry.update({k: v for k, v in log.items() if k != 'send'})
        os.makedirs(STORE, exist_ok=True)
        with open(LOG_PATH, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + '\n')
    except Exception:  # noqa: BLE001
        pass


def _write(stream: Any, text: str) -> None:
    if not text:
        return
    try:
        stream.buffer.write(text.encode('utf-8', 'replace'))
        stream.buffer.flush()
    except AttributeError:
        stream.write(text)
        stream.flush()


def main() -> None:
    started = time.monotonic()
    log: Dict[str, Any] = {}
    raw = sys.stdin.read()
    try:
        out = decide(raw, log)
    except Deny as d:
        _write_log(log, 'deny', d.code, started)
        _write(sys.stderr, d.text if d.text.endswith('\n') else d.text + '\n')
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001 -- a bug is a refusal, never a pass
        _write_log(log, 'deny', 'internal_error', started)
        _write(sys.stderr, 'EMAIL-JOVAHAGYAS KAPU: TILTVA, belso hiba (%s). Fail-closed.\n' % type(exc).__name__)
        sys.exit(2)
    if log.get('send'):
        _write_log(log, 'allow', 'consumed', started)
    _write(sys.stdout, out)
    sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 -- deliberate blanket: an unhandled crash exits 1, which does NOT block
        try:
            sys.stderr.write('EMAIL-JOVAHAGYAS KAPU: TILTVA, belso hiba (%s). Fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki.\n' % type(exc).__name__)
        except Exception:  # noqa: BLE001
            pass
        sys.exit(2)
