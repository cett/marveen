#!/usr/bin/env python3
"""The official plain-text mail sender: Gmail REST API, bound to ONE owner approval on the sender side.

    python3 scripts/gmail-send.py --to ADDR [--to ADDR ...] [--cc ADDR ...] [--bcc ADDR ...] --subject TEXT
        (--body TEXT | --body-file PATH | the body on stdin) [--attach PATH ...]
        [--from ADDR] [--reply-to ADDR] [--in-reply-to MESSAGE-ID]

There is no --html (an unknown option is refused): the owner approves the text, so the text is what is sent.

What it does, in this order (the first failure ends the run, and nothing before the claim spends anything):

  1. Reads the command line with scripts/lib/email_extract.py, the SAME reader the send gate
     (scripts/hooks/email-approval-gate.py) uses for this command, so the sha256 of the canonical envelope
     computed here is the hash the gate computes for the same command line.
  2. Refreshes the Gmail OAuth access token. FIRST, so a broken login does not burn an approval.
  3. Spends the owner's approval for that hash: POST /api/approvals/claim with the MAIN agent's own token
     (a shared-token fallback is refused). The dashboard address is built exactly like the gate builds it:
     WEB_PORT / WEB_HOST from <install>/.env only (never the environment), WEB_HOST must be an IP address,
     never the name localhost, no proxy, no redirect, short timeouts, capped answers.
  4. Only on a 200 whose approval names THIS hash, category, agent, status and use, it re-reads each
     attachment, checks sha256 and size against the envelope (a file that changed after the hash is NOT
     sent: the approval is already spent) and sends exactly the approved fields and the verified bytes
     with users.messages.send. Prints `SENT id=<id>`.
  5. With no usable approval it opens a request for the owner (POST /api/approvals) and exits 3: the owner
     decides on the dashboard, then the SAME command is run again. Any change to the mail needs a new
     approval; an approval is used once and only inside its window.

No flag and no environment variable skips the claim. Exit codes: 0 sent (or a dry run), 1 a failure
(Gmail login, the send, an attachment that changed), 2 the command line or the mail is not readable or
not sendable by this tool, 3 refused: no usable approval or the approval service cannot be trusted.
Messages carry fixed texts and ids only: never a token and never any part of the mail.

Environment (all optional; the first two are TEST SEAMS, not security switches):
  GMAIL_CRED_DIR        directory with token.json and credentials.json   (default ~/.gmail-mcp)
  GMAIL_SEND_API_BASE   base URL of the Gmail API                        (default https://gmail.googleapis.com)
  GMAIL_SEND_DRY_RUN=1  build the envelope and print `DRY-OK hash=<12 hex>`; NO network call, nothing is
                        sent, no approval is touched. (Not a command-line option: the gate's reader would
                        call that an unknown option.)

Honest limit: this is the official path, it does not stop an agent that writes its own script; the other
send routes (send.py, graph-mail, send-digest-email.py) are not converted yet. Standard library only.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import ipaddress
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email import encoders
from email.header import Header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.realpath(__file__))   # <install>/scripts
INSTALL = os.path.dirname(HERE)
STORE = os.path.join(INSTALL, 'store')
REL_EXTRACT = 'scripts/lib/email_extract.py'
REL_TOKEN = 'scripts/hooks/agent_token.py'

CATEGORY = 'email_send'
CONSUMER = 'gmail-send'
TOTAL_BUDGET_S = 7.0        # the dashboard calls (claim, and the request when there is none) fit in this
CALL_TIMEOUT_S = 2.0
MAX_RESPONSE_BYTES = 1024 * 1024
GOOGLE_TIMEOUT_S = 20.0
SEND_TIMEOUT_S = 60.0
DEFAULT_PORT = '3420'
DEFAULT_HOST = '127.0.0.1'
DEFAULT_GMAIL_BASE = 'https://gmail.googleapis.com'
# users.messages.send takes a base64url RFC 822 message in a JSON body; stay well inside what it accepts, and
# say so BEFORE an approval is spent.
MAX_ATTACHMENT_TOTAL = 18 * 1024 * 1024

# The options this tool reads. `html` is deliberately missing; the reader (email_extract) knows it and
# turns it into an html part, which this tool refuses too.
OPTIONS = {
    'to': 'repeat', 'cc': 'repeat', 'bcc': 'repeat', 'subject': 'value', 'body': 'value', 'body-file': 'value',
    'attach': 'repeat', 'from': 'value', 'reply-to': 'value', 'in-reply-to': 'value',
}
USAGE = ('usage: gmail-send.py --to ADDR [--cc ADDR] [--bcc ADDR] --subject TEXT (--body TEXT | --body-file PATH | stdin) '
         '[--attach PATH] [--from ADDR] [--reply-to ADDR] [--in-reply-to ID]  (plain text only, no --html)')

# Claim answers (HTTP 409 `reason`) after which a new request is opened for the owner.
OPEN_REQUEST_REASONS = frozenset(('none', 'expired', 'already_consumed', 'rejected', 'not_human_decided'))

_CONTROL = re.compile(r'[\x00-\x1f\x7f  ]+')

EXIT_OK, EXIT_FAIL, EXIT_UNREADABLE, EXIT_REFUSED = 0, 1, 2, 3


class Stop(Exception):
    """The run ends here: an exit code and one line for the caller."""

    def __init__(self, code: int, text: str) -> None:
        super().__init__(text)
        self.code = code
        self.text = text


class Unavailable(Exception):
    pass


def _clean(text: Any, limit: int) -> str:
    s = _CONTROL.sub(' ', str(text if text is not None else ''))
    s = re.sub(r' {2,}', ' ', s).strip()
    return s if len(s) <= limit else s[:limit] + '...'


def _load_module(name: str, rel: str) -> Any:
    try:
        spec = importlib.util.spec_from_file_location(name, os.path.join(INSTALL, rel))
        if spec is None or spec.loader is None:
            raise ImportError('no loader')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except BaseException as exc:  # noqa: BLE001 -- SystemExit from a broken module too
        raise Stop(EXIT_FAIL, 'REFUSED load_error: a part of the sender does not load: %s (%s). Nothing was sent.' % (rel, type(exc).__name__))


# ---------------------------------------------------------------------------------------------------
# The dashboard address and the calls to it: the same rules as the send gate
# ---------------------------------------------------------------------------------------------------

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
    Never the name 'localhost' (it can resolve to ::1 as well, where a listener the agent started could
    answer in the dashboard's place); a WEB_HOST that is a name is refused."""
    v = _env_file_value('WEB_HOST')
    if v is not None and v != '':
        try:
            ip = ipaddress.ip_address(v)
        except ValueError:
            raise Unavailable('WEB_HOST is not an IP address')
        if not ip.is_unspecified:
            return '[%s]' % ip if ip.version == 6 else str(ip)
    return DEFAULT_HOST


def base_url() -> str:
    return 'http://%s:%s' % (_host(), _port())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any):  # noqa: D401
        return None


_DASH_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def _dash(method: str, path: str, body: Dict[str, Any], headers: Dict[str, str], deadline: float, base: str) -> Tuple[int, Any]:
    """(status, parsed JSON or None). Raises Unavailable when there is no answer at all."""
    remaining = deadline - time.monotonic()
    if remaining < 0.3:
        raise Unavailable('time budget used up')
    req = urllib.request.Request(base + path, data=json.dumps(body).encode('utf-8'), method=method, headers=headers)
    try:
        with _DASH_OPENER.open(req, timeout=min(CALL_TIMEOUT_S, remaining)) as resp:
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
# Gmail
# ---------------------------------------------------------------------------------------------------

def _cred_dir() -> str:
    return os.environ.get('GMAIL_CRED_DIR') or os.path.expanduser('~/.gmail-mcp')


def _api_base() -> str:
    base = (os.environ.get('GMAIL_SEND_API_BASE') or DEFAULT_GMAIL_BASE).rstrip('/')
    if urllib.parse.urlsplit(base).scheme not in ('http', 'https'):
        raise Stop(EXIT_FAIL, 'REFUSED gmail_base: GMAIL_SEND_API_BASE is not an http(s) URL. Nothing was sent.')
    return base


def refresh_access_token() -> str:
    """A fresh OAuth access token from the stored refresh token (same files and flow as send-digest-email.py)."""
    d = _cred_dir()
    try:
        with open(os.path.join(d, 'token.json'), encoding='utf-8') as fh:
            token_data = json.load(fh)
        with open(os.path.join(d, 'credentials.json'), encoding='utf-8') as fh:
            cred = json.load(fh)
    except (OSError, ValueError):
        raise Stop(EXIT_FAIL, 'MISSING_CREDS: the Gmail login files are missing or unreadable. Nothing was sent, no approval was used.')
    try:
        inst = cred.get('installed', cred.get('web', cred))
        body = urllib.parse.urlencode({
            'client_id': inst['client_id'], 'client_secret': inst['client_secret'],
            'refresh_token': token_data['refresh_token'], 'grant_type': 'refresh_token',
        }).encode()
        token_uri = inst.get('token_uri', 'https://oauth2.googleapis.com/token')
        if urllib.parse.urlsplit(token_uri).scheme not in ('http', 'https'):
            raise ValueError('token_uri')
        req = urllib.request.Request(token_uri, data=body, method='POST')
        with urllib.request.urlopen(req, timeout=GOOGLE_TIMEOUT_S) as resp:
            access = json.loads(resp.read(MAX_RESPONSE_BYTES).decode('utf-8'))['access_token']
        if not isinstance(access, str) or not access:
            raise ValueError('access_token')
        return access
    except Exception:  # noqa: BLE001
        raise Stop(EXIT_FAIL, 'TOKEN_REFRESH_FAIL: the Gmail login could not be refreshed. Nothing was sent, no approval was used.')


def build_message(env: Dict[str, Any], attachments: List[Tuple[str, bytes]]) -> bytes:
    """The RFC 822 message for the approved fields (the envelope) and the verified attachment bytes."""
    text = MIMEText(env['body'], 'plain', 'utf-8')
    if attachments:
        msg: Any = MIMEMultipart('mixed')
        msg.attach(text)
        for name, data in attachments:
            ctype = mimetypes.guess_type(name, strict=False)[0] or 'application/octet-stream'
            maintype, _, subtype = ctype.partition('/')
            part = MIMEBase(maintype, subtype or 'octet-stream')
            part.set_payload(data)
            encoders.encode_base64(part)
            try:
                name.encode('ascii')
                part.add_header('Content-Disposition', 'attachment', filename=name)
            except UnicodeEncodeError:
                part.add_header('Content-Disposition', 'attachment', filename=('utf-8', '', name))
            msg.attach(part)
    else:
        msg = text
    msg['To'] = ', '.join(env['to'])
    if env.get('cc'):
        msg['Cc'] = ', '.join(env['cc'])
    if env.get('bcc'):
        msg['Bcc'] = ', '.join(env['bcc'])
    msg['Subject'] = Header(env['subject'], 'utf-8')
    if env.get('from'):
        msg['From'] = env['from']
    if env.get('reply_to'):
        msg['Reply-To'] = env['reply_to']
    if env.get('in_reply_to'):
        msg['In-Reply-To'] = Header(env['in_reply_to'], 'utf-8')
    return msg.as_bytes()


def send_via_gmail(access_token: str, raw_message: bytes) -> Any:
    """POST users/me/messages/send. Returns the parsed answer; raises HTTPError (Gmail said no) or another
    exception (no answer: the mail may or may not have left)."""
    raw = base64.urlsafe_b64encode(raw_message).decode('ascii')
    req = urllib.request.Request(
        _api_base() + '/gmail/v1/users/me/messages/send', data=json.dumps({'raw': raw}).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=SEND_TIMEOUT_S) as resp:
        data = resp.read(MAX_RESPONSE_BYTES)
    try:
        return json.loads(data.decode('utf-8'))
    except Exception:  # noqa: BLE001 -- a 2xx whose body is not JSON: the mail was accepted
        return None


# ---------------------------------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------------------------------

def _read_stdin_text(X: Any) -> Optional[str]:
    """The body from stdin, or None when there is no stdin to read (a terminal, or none)."""
    stream = sys.stdin
    if stream is None:
        return None
    try:
        if stream.isatty():
            return None
        data = stream.buffer.read(X.MAX_BODY_FILE_BYTES + 1)
    except (OSError, ValueError, AttributeError):
        return None
    if len(data) > X.MAX_BODY_FILE_BYTES:
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: the body on stdin is larger than %d bytes.' % X.MAX_BODY_FILE_BYTES)
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: the body on stdin is not valid UTF-8.')


def read_mail(args: List[str], cwd: str, X: Any) -> Tuple[Dict[str, Any], List[str]]:
    """(fields, attachment paths) for the command line, through the gate's own reader."""
    try:
        opts = X._argparse_options(args, OPTIONS, 'gmail-send.py')   # this tool's options: no --html
        stdin_text = None if ('body' in opts or 'body-file' in opts) else _read_stdin_text(X)
        fields = X.gmail_send_fields(args, cwd, stdin_text)
    except X.Unreadable as exc:
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: %s. %s' % (_clean(exc, 300), USAGE))
    if fields.get('html_sha256'):
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: an html part cannot be shown to the owner as text; this sender sends plain text only.')
    paths = [p if os.path.isabs(p) else os.path.join(cwd, p) for p in opts.get('attach', [])]
    if len(paths) != len(fields.get('attachments') or []):
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: the attachments could not be matched to files.')
    return fields, paths


def _claim(content_hash: str, h12: str, resolved: Any, canon: str, base: str) -> str:
    """Spend the owner's approval for this mail. Returns the approval id; raises Stop for every other end."""
    headers = resolved.headers({'Content-Type': 'application/json'})
    deadline = time.monotonic() + TOTAL_BUDGET_S
    claim_body = {'category': CATEGORY, 'content_hash': content_hash, 'consumer': CONSUMER, 'ref': 'send-' + uuid.uuid4().hex}
    tail = ' Nothing was sent.'
    try:
        status, got = _dash('POST', '/api/approvals/claim', claim_body, headers, deadline, base)
    except Unavailable as exc:
        raise Stop(EXIT_REFUSED, 'REFUSED claim_unavailable: the approval service does not answer (%s); fail-closed, run it again later.%s' % (exc, tail))
    if status == 200:
        approval = got.get('approval') if isinstance(got, dict) else None
        if not (isinstance(got, dict) and got.get('ok') is True and isinstance(approval, dict)):
            raise Stop(EXIT_REFUSED, 'REFUSED claim_bad_answer: the approval service answered nonsense; fail-closed.' + tail)
        # The answer must be about THIS mail, this agent and this use: a listener that is not the dashboard
        # can say 200, it cannot know the hash and the reference made up a moment ago.
        expect = {'content_hash': content_hash, 'category': CATEGORY, 'agent_id': resolved.agent_id, 'status': 'approved',
                  'consumed_by': resolved.agent_id, 'consumed_ref': claim_body['ref']}
        wrong = [k for k, v in expect.items() if approval.get(k) != v]
        if wrong:
            raise Stop(EXIT_REFUSED, 'REFUSED claim_mismatch: the approval service answered for another mail, agent or use (%s); fail-closed.%s' % (', '.join(wrong), tail))
        return _clean(approval.get('id'), 60)
    if status != 409 or not isinstance(got, dict) or not isinstance(got.get('reason'), str):
        raise Stop(EXIT_REFUSED, 'REFUSED claim_unavailable: the approval service answered HTTP %d; fail-closed, run it again later.%s' % (status, tail))
    reason = got['reason']
    if reason == 'pending':
        raise Stop(EXIT_REFUSED, 'REFUSED pending: an approval request for this mail is already open (id %s, mail %s); the owner has not decided yet. '
                   'Do not ask again; after the decision run the SAME command.%s' % (_clean(got.get('approval_id'), 60), h12, tail))
    if reason not in OPEN_REQUEST_REASONS:
        raise Stop(EXIT_REFUSED, 'REFUSED claim_unexpected: the approval service gave an unknown reason (%s); fail-closed.%s' % (_clean(reason, 40), tail))
    try:
        status, opened = _dash('POST', '/api/approvals', {
            'agent_id': resolved.agent_id, 'category': CATEGORY, 'content_hash': content_hash, 'action_payload': canon,
        }, headers, deadline, base)
    except Unavailable as exc:
        raise Stop(EXIT_REFUSED, 'REFUSED request_failed: no usable approval (%s) and the request could not be opened (%s).%s' % (reason, exc, tail))
    if status in (200, 201) and isinstance(opened, dict) and isinstance(opened.get('id'), str):
        raise Stop(EXIT_REFUSED, 'REFUSED needs_approval: approval request %s %s (mail %s, previous state: %s). The owner decides on the dashboard (%s); '
                   'then run the SAME command again (any change to the mail needs a new approval; an approval is used once and expires).%s' % (
                       _clean(opened['id'], 60), 'was already open' if opened.get('deduplicated') else 'is open', h12, reason, base, tail))
    raise Stop(EXIT_REFUSED, 'REFUSED request_failed: no usable approval (%s) and the request could not be opened (HTTP %d).%s' % (reason, status, tail))


def _reread_attachments(paths: List[str], held: List[Dict[str, Any]]) -> List[Tuple[str, bytes]]:
    """The bytes to send: each file read NOW and checked against the size and sha256 in the approved envelope."""
    out: List[Tuple[str, bytes]] = []
    for path, want in zip(paths, held):
        try:
            with open(path, 'rb') as fh:
                data = fh.read(int(want['size']) + 1)
        except OSError:
            data = None
        if data is None or len(data) != want['size'] or hashlib.sha256(data).hexdigest() != want['sha256']:
            raise Stop(EXIT_FAIL, 'ATTACHMENT_CHANGED: an attachment is not the file that was approved (%s). The approval is SPENT and nothing was sent; '
                       'restore the file or ask for a new approval.' % _clean(want['name'], 80))
        out.append((want['name'], data))
    return out


def run(argv: List[str]) -> int:
    if len(argv) == 1 and argv[0] in ('-h', '--help'):
        print(USAGE)
        return EXIT_OK
    X = _load_module('email_extract_in_gmail_send', REL_EXTRACT)
    fields, paths = read_mail(argv, os.getcwd(), X)

    dry = os.environ.get('GMAIL_SEND_DRY_RUN') == '1'
    T = _load_module('agent_token_in_gmail_send', REL_TOKEN)
    resolved = T.resolve(kind=T.KIND_MAIN, store_dir=STORE, install=INSTALL)
    if not dry and (not resolved.token or resolved.source != T.SOURCE_AGENT or not resolved.agent_id):
        raise Stop(EXIT_REFUSED, 'REFUSED no_own_token: the main agent\'s own token cannot be read (a shared token does not identify the requester). Nothing was sent.')
    if not resolved.agent_id:
        raise Stop(EXIT_REFUSED, 'REFUSED no_agent: the main agent id is unknown. Nothing was sent.')

    built = X.build_envelope(fields, resolved.agent_id)
    if not built.get('ok'):
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: the mail cannot be stated exactly: %s' % _clean(built.get('hint') or built.get('field'), 300))
    env, canon, content_hash = built['envelope'], built['canon'], built['hash']
    h12 = content_hash[:12]
    if not env.get('to') or not str(env.get('body') or '').strip():
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: the recipient or the body is empty; an empty mail cannot be approved.')
    held = fields.get('attachments') or []
    if sum(int(a['size']) for a in held) > MAX_ATTACHMENT_TOTAL:
        raise Stop(EXIT_UNREADABLE, 'UNREADABLE: the attachments are larger than %d MiB together, too large for one send. No approval was used.' % (MAX_ATTACHMENT_TOTAL // (1024 * 1024)))

    if dry:
        print('DRY-OK hash=%s' % h12)
        return EXIT_OK

    try:
        base = base_url()
    except Unavailable as exc:
        raise Stop(EXIT_REFUSED, 'REFUSED dashboard_address: %s. Nothing was sent.' % exc)
    _api_base()   # validated before an approval is spent
    access_token = refresh_access_token()
    approval_id = _claim(content_hash, h12, resolved, canon, base)

    # From here the approval is spent: either the approved mail leaves, or the run says plainly that it did not.
    blobs = _reread_attachments(paths, held)
    message = build_message(env, blobs)
    try:
        answer = send_via_gmail(access_token, message)
    except urllib.error.HTTPError as exc:
        raise Stop(EXIT_FAIL, 'SEND_FAIL: Gmail refused the send (HTTP %d). The approval (id %s, mail %s) is SPENT and the mail did NOT leave; ask for a new approval.' % (exc.code, approval_id, h12))
    except Exception as exc:  # noqa: BLE001
        raise Stop(EXIT_FAIL, 'SEND_UNKNOWN: no answer from Gmail (%s). The approval (id %s, mail %s) is SPENT; check the Sent folder before asking again.' % (type(exc).__name__, approval_id, h12))
    msg_id = _clean(answer.get('id'), 80) if isinstance(answer, dict) else ''
    print('SENT id=%s' % msg_id)
    return EXIT_OK


def main(argv: List[str]) -> int:
    try:
        return run(argv)
    except Stop as stop:
        stream = sys.stdout if stop.code == EXIT_OK else sys.stderr
        stream.write(stop.text + '\n')
        return stop.code
    except BaseException as exc:  # noqa: BLE001 -- a bug is a refusal, never a send
        if isinstance(exc, KeyboardInterrupt):
            raise
        sys.stderr.write('REFUSED internal_error (%s). Nothing was sent unless a SENT line was printed above.\n' % type(exc).__name__)
        return EXIT_FAIL


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
