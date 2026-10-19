#!/usr/bin/env python3
"""The envelope of an outgoing email, read from a tool call, and its hash.

The send gate (a PreToolUse hook) must compute, from the call an agent is about to make, the same
canonical envelope and the same sha256 as the dashboard server does (src/web/email-envelope.ts,
parseEmailEnvelope). An approval is bound to that hash, so a byte of difference is a mail the server
refuses, and a field the gate does not read is a recipient nobody approved.

Two layers, kept apart on purpose:

  build_envelope(raw, agent)           the canonical form and hash of an envelope whose fields are
                                       already plain (bare addresses, text). A line-for-line mirror of
                                       the server's parseEmailEnvelope, checked against the shared golden
                                       vectors (scripts/__tests__/email-envelope-vectors.json).
  collect_email_envelope(tool, input)  the fields of ONE outgoing mail, read out of the shape the call has:
                                       an MCP tool input, a mail command line (send.py, graph-mail, a
                                       sendmail-style program with a raw message on stdin, a mail command),
                                       a curl call to the Gmail REST send route (a base64url raw message)
                                       or to the Resend API. envelope_of_call() chains the two.

FAIL CLOSED. Anything the reader cannot state exactly is reported as unreadable, with the reason, never
guessed: a shell expansion in a word it needs, a pipe as the body, a second mail in the same call, a
duplicated single-valued header, an '@' no parsed address accounts for, a line break in the subject
(header injection), an option it does not know, a file it cannot read. The hash then is not computed, and
the gate says how to make the call readable. The reader never executes anything and never follows a
network address; the only I/O is reading the local files the call names (capped).

Decisions that are easy to get wrong (each has a test):
  * Recipients: all To/Cc/Bcc occurrences are united (a superset is safe: the person approves at least
    everyone who may receive it); a single-valued header given twice (Subject, From, Reply-To,
    In-Reply-To) is ambiguous and therefore unreadable.
  * Every '@' in a recipient value must belong to a parsed address, so a display name or a comment that
    smuggles an address ("a@x.test,b@y.test" <c@z.test>) is unreadable, not silently dropped.
  * MIME text parts: transfer encoding and charset are decoded, CRLF/CR are folded to LF (a MIME line
    break is transport, not content). html_sha256 is the sha256 of the decoded part bytes as they are.
  * A mail with two inline plain or two inline html parts has a body part a mail reader would show and
    the envelope would not: unreadable.
  * send.py / graph-mail send with --html send the body as HTML only: the envelope carries the HTML source
    as body (the only text a person can read) and its sha256 as html_sha256.
  * The shell reading is a single linear pass (no backtracking patterns on attacker text), bounded by
    MAX_CMD_CHARS; any command substitution, backtick or process substitution anywhere in the call
    makes the whole call unreadable.

Standard library only. Python 3.12+ (email.utils.getaddresses(strict=True)).
"""
from __future__ import annotations

import base64
import binascii
import email.policy
import email.utils
import hashlib
import json
import os
import re
import sys
from email import message_from_bytes
from email.header import decode_header, make_header
from typing import Any, Dict, List, Optional, Tuple

ENVELOPE_VERSION = 1
MAX_PAYLOAD_BYTES = 256 * 1024
MAX_ADDRESSES = 100
MAX_ATTACHMENTS = 20
MAX_SUBJECT_CHARS = 998
MAX_ADDRESS_CHARS = 254
MAX_NAME_CHARS = 255
MAX_IN_REPLY_TO_CHARS = 998

# Bounds on what the reader will look at (fail closed beyond them).
MAX_CMD_CHARS = 131072
MAX_WORDS = 4096
MAX_BODY_FILE_BYTES = 512 * 1024
MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
MAX_INPUT_CHARS = 96 * 1024 * 1024
MAX_MIME_BYTES = 96 * 1024 * 1024
MAX_SHELL_DEPTH = 3

ALLOWED_KEYS = frozenset(('v', 'agent', 'to', 'cc', 'bcc', 'subject', 'body', 'html_sha256', 'attachments', 'from', 'reply_to', 'in_reply_to'))
ATTACHMENT_KEYS = frozenset(('name', 'size', 'sha256'))
_SHA256_RE = re.compile(r'[0-9a-f]{64}')
_LOCAL_RE = re.compile(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*")
_DOMAIN_RE = re.compile(r'[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*')
_NAME_CONTROL_RE = re.compile('[\u0000-\u001f\u007f]')
_MAX_SAFE_INT = 2 ** 53 - 1


class Unreadable(Exception):
    """The call cannot be turned into an exact envelope; the message says why and how to fix it.

    dynamic_exec: what the call runs is decided at run time (a command name or a shell -c code that is a
    variable), so it cannot be ruled out that it is a mail program."""

    dynamic_exec = False


class UnreadableDynamicExec(Unreadable):
    dynamic_exec = True


# ======================================================================================================
# Layer 1: the canonical form and the hash (mirror of src/web/email-envelope.ts parseEmailEnvelope)
# ======================================================================================================

def _well_formed(s: str) -> bool:
    """True when the string has no surrogate code point (it can be written as UTF-8 without loss)."""
    for ch in s:
        if '\ud800' <= ch <= '\udfff':
            return False
    return True


def _normalize_address(raw: Any) -> Optional[str]:
    """A bare ASCII address with its domain lower-cased, or None when it is anything else."""
    if not isinstance(raw, str) or raw == '' or len(raw) > MAX_ADDRESS_CHARS:
        return None
    at = raw.find('@')
    if at <= 0 or at != raw.rfind('@'):
        return None
    local, domain = raw[:at], raw[at + 1:]
    if len(local) > 64 or domain == '' or len(domain) > 253:
        return None
    # fullmatch, never match + '$': Python's '$' also matches before a trailing newline.
    if not _LOCAL_RE.fullmatch(local) or not _DOMAIN_RE.fullmatch(domain):
        return None
    return local + '@' + domain.lower()


def _fail(field: str, hint: str) -> Dict[str, Any]:
    return {'ok': False, 'field': field, 'hint': hint}


def _address_list(raw: Any, present: bool, field: str, required: bool) -> Tuple[Optional[List[str]], Optional[Dict[str, Any]]]:
    if not present and not required:
        return [], None
    if not isinstance(raw, list):
        return None, _fail(field, f'{field} must be an array of addresses')
    if len(raw) > MAX_ADDRESSES:
        return None, _fail(field, f'{field} takes at most {MAX_ADDRESSES} addresses')
    seen = set()
    for item in raw:
        a = _normalize_address(item)
        if a is None:
            return None, _fail(field, f'{field} holds an entry that is not a bare local@domain address (ASCII, one @, no display name or group)')
        seen.add(a)
    if required and not seen:
        return None, _fail(field, f'{field} must not be empty')
    return sorted(seen), None


def _plain_string(raw: Any, field: str, max_chars: int) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    if not isinstance(raw, str):
        return None, _fail(field, f'{field} must be a string')
    if len(raw) > max_chars:
        return None, _fail(field, f'{field} is longer than {max_chars} characters')
    if not _well_formed(raw):
        return None, _fail(field, f'{field} is not valid Unicode text')
    return raw, None


def _is_safe_nonneg_int(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return 0 <= v <= _MAX_SAFE_INT
    if isinstance(v, float):
        return v.is_integer() and 0 <= v <= _MAX_SAFE_INT
    return False


def canonical_json(e: Dict[str, Any]) -> str:
    """Compact JSON, keys sorted, non-ASCII left as it is: the shape the hash is taken over."""
    return json.dumps(e, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def hash_canon(canon: str) -> str:
    return hashlib.sha256(canon.encode('utf-8')).hexdigest()


def build_envelope(raw: Any, agent: str) -> Dict[str, Any]:
    """Check a plain envelope and build its canonical form and hash.

    Returns {'ok': True, 'envelope', 'canon', 'hash'} or {'ok': False, 'field', 'hint'}. Never raises.
    The agent is the caller's own knowledge of who sends (a client-named agent is ignored), the version is
    always the current one (another is refused). Same checks, same order, same fields as the server.
    """
    try:
        return _build_envelope(raw, agent)
    except Exception as exc:  # noqa: BLE001 -- a bug here must be a refusal, never a pass
        return _fail('action_payload', f'internal error while reading the envelope ({type(exc).__name__})')


def _build_envelope(raw: Any, agent: str) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return _fail('action_payload', 'action_payload must be a JSON object')
    for key in raw:
        if key not in ALLOWED_KEYS:
            return _fail(str(key), f'Unknown field "{str(key)[:40]}" in the email envelope')
    if 'v' in raw:
        v = raw['v']
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != ENVELOPE_VERSION:
            return _fail('v', f'Envelope version must be {ENVELOPE_VERSION}')
    if 'agent' in raw and not isinstance(raw['agent'], str):
        return _fail('agent', 'agent must be a string')
    if not isinstance(agent, str) or not _well_formed(agent):
        return _fail('agent', 'agent is not valid Unicode text')

    to, err = _address_list(raw.get('to'), 'to' in raw, 'to', True)
    if err:
        return err
    cc, err = _address_list(raw.get('cc'), 'cc' in raw, 'cc', False)
    if err:
        return err
    bcc, err = _address_list(raw.get('bcc'), 'bcc' in raw, 'bcc', False)
    if err:
        return err

    subject, err = _plain_string(raw.get('subject') if 'subject' in raw else None, 'subject', MAX_SUBJECT_CHARS)
    if err:
        return err
    body = raw.get('body') if 'body' in raw else None
    if not isinstance(body, str):
        return _fail('body', 'body must be a string')
    if not _well_formed(body):
        return _fail('body', 'body is not valid Unicode text')

    env: Dict[str, Any] = {'v': ENVELOPE_VERSION, 'agent': agent, 'to': to, 'cc': cc, 'bcc': bcc, 'subject': subject, 'body': body}

    if 'html_sha256' in raw:
        h = raw['html_sha256']
        if not isinstance(h, str) or not _SHA256_RE.fullmatch(h):
            return _fail('html_sha256', 'html_sha256 must be 64 lowercase hex characters')
        env['html_sha256'] = h
    if env['body'] == '' and 'html_sha256' not in env:
        return _fail('body', 'body must not be empty unless an html part is given')

    if 'attachments' in raw:
        atts = raw['attachments']
        if not isinstance(atts, list):
            return _fail('attachments', 'attachments must be an array')
        if len(atts) > MAX_ATTACHMENTS:
            return _fail('attachments', f'attachments takes at most {MAX_ATTACHMENTS} entries')
        out = []
        for item in atts:
            if not isinstance(item, dict):
                return _fail('attachments', 'each attachment must be an object {name, size, sha256}')
            for key in item:
                if key not in ATTACHMENT_KEYS:
                    return _fail('attachments', f'Unknown field "{str(key)[:40]}" in an attachment')
            name, err = _plain_string(item.get('name') if 'name' in item else None, 'attachments', MAX_NAME_CHARS)
            if err:
                return err
            if name == '' or _NAME_CONTROL_RE.search(name):
                return _fail('attachments', 'an attachment name must be 1-255 characters without control characters')
            size = item.get('size') if 'size' in item else None
            if not _is_safe_nonneg_int(size):
                return _fail('attachments', 'an attachment size must be a non-negative integer')
            sha = item.get('sha256') if 'sha256' in item else None
            if not isinstance(sha, str) or not _SHA256_RE.fullmatch(sha):
                return _fail('attachments', 'an attachment sha256 must be 64 lowercase hex characters')
            out.append({'name': name, 'size': int(size), 'sha256': sha})
        if out:
            out.sort(key=lambda a: (a['name'], a['sha256'], a['size']))
            env['attachments'] = out

    for field in ('from', 'reply_to'):
        if field not in raw:
            continue
        a = _normalize_address(raw[field])
        if a is None:
            return _fail(field, f'{field} must be one bare local@domain address')
        env[field] = a
    if 'in_reply_to' in raw:
        v2, err = _plain_string(raw['in_reply_to'], 'in_reply_to', MAX_IN_REPLY_TO_CHARS)
        if err:
            return err
        if v2 == '':
            return _fail('in_reply_to', 'in_reply_to must not be empty when given')
        env['in_reply_to'] = v2

    canon = canonical_json(env)
    if len(canon.encode('utf-8')) > MAX_PAYLOAD_BYTES:
        return _fail('action_payload', f'the mail is larger than {MAX_PAYLOAD_BYTES} bytes once written as an envelope')
    return {'ok': True, 'envelope': env, 'canon': canon, 'hash': hash_canon(canon)}


# ======================================================================================================
# Layer 2: reading the fields of one outgoing mail out of a call
# ======================================================================================================

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _utf8(text: str, what: str) -> bytes:
    try:
        return text.encode('utf-8')
    except UnicodeEncodeError:
        raise Unreadable(f'{what} is not valid Unicode text') from None


def _strip_quoted_and_comments(v: str) -> str:
    """The value without quoted strings and (comments): what is left is structure."""
    out = []
    i, n = 0, len(v)
    depth = 0
    while i < n:
        c = v[i]
        if c == '\\' and i + 1 < n:
            i += 2
            continue
        if depth == 0 and c == '"':
            i += 1
            while i < n and v[i] != '"':
                i += 2 if v[i] == '\\' else 1
            i += 1
            continue
        if c == '(':
            depth += 1
        elif c == ')' and depth > 0:
            depth -= 1
        elif depth == 0:
            out.append(c)
        i += 1
    return ''.join(out)


def parse_addresses(values: List[str], field: str) -> List[str]:
    """Bare addresses out of header-style address values (list in, list out, input order, not deduplicated).

    Strict parser; group syntax, an empty entry, an address that is not the exact shape the server takes
    and any '@' that no parsed address accounts for are all unreadable.
    """
    if not values:
        return []
    if sum(len(v) for v in values if isinstance(v, str)) > 32768:
        raise Unreadable(f'{field} is longer than 32768 characters')
    for v in values:
        if not isinstance(v, str):
            raise Unreadable(f'{field} holds something that is not text')
        if '\r' in v or '\n' in v or '\x00' in v:
            raise Unreadable(f'{field} contains a line break or NUL (header injection)')
        rest = _strip_quoted_and_comments(v)
        if ':' in rest or ';' in rest:
            raise Unreadable(f'{field} uses the group syntax; list the addresses plainly')
    try:
        pairs = email.utils.getaddresses(values, strict=True)
    except TypeError:
        raise Unreadable('this Python cannot parse addresses strictly (3.12 or newer is needed)') from None
    except Exception:  # noqa: BLE001
        raise Unreadable(f'{field} could not be read as an address list') from None
    addrs = [a for _, a in pairs]
    if any(a == '' for a in addrs):
        raise Unreadable(f'{field} holds an entry with no address')
    if sum(v.count('@') for v in values) != len(addrs):
        raise Unreadable(f'{field} has an "@" that is not part of one of its addresses (display name or comment); write plain addresses')
    for a in addrs:
        if _normalize_address(a) is None:
            raise Unreadable(f'{field} holds "{a[:60]}", which is not a plain local@domain address (ASCII, no quoting)')
    return addrs


def _one_address(value: str, field: str) -> str:
    addrs = parse_addresses([value], field)
    if len(addrs) != 1:
        raise Unreadable(f'{field} must be exactly one address')
    return addrs[0]


def _no_line_break(value: str, field: str) -> str:
    if '\r' in value or '\n' in value:
        raise Unreadable(f'{field} contains a line break (header injection)')
    return value


def _read_file(path: str, cap: int, what: str) -> bytes:
    try:
        with open(path, 'rb') as fh:
            data = fh.read(cap + 1)
    except OSError as exc:
        raise Unreadable(f'{what} cannot be read ({path}: {exc.strerror or type(exc).__name__})') from None
    if len(data) > cap:
        raise Unreadable(f'{what} is larger than {cap} bytes ({path})')
    return data


def _hash_file(path: str, what: str) -> Tuple[int, str]:
    h = hashlib.sha256()
    size = 0
    try:
        with open(path, 'rb') as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise Unreadable(f'{what} is larger than {MAX_ATTACHMENT_BYTES} bytes ({path})')
                h.update(chunk)
    except OSError as exc:
        raise Unreadable(f'{what} cannot be read ({path}: {exc.strerror or type(exc).__name__})') from None
    return size, h.hexdigest()


def _decode_text(data: bytes, what: str) -> str:
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        raise Unreadable(f'{what} is not valid UTF-8') from None


def _fold_newlines(text: str) -> str:
    return text.replace('\r\n', '\n').replace('\r', '\n')


_B64_RE = re.compile(r'[A-Za-z0-9+/]*={0,2}')
_B64URL_RE = re.compile(r'[A-Za-z0-9_-]*={0,2}')


def _strict_b64(text: str, what: str, url: bool = False) -> bytes:
    t = ''.join(text.split())  # transport may wrap lines; whitespace carries no data
    if not (_B64URL_RE if url else _B64_RE).fullmatch(t):
        raise Unreadable(f'{what} is not valid base64{"url" if url else ""}')
    pad = t.rstrip('=')
    pad_len = len(t) - len(pad)
    if len(pad) % 4 == 1 or (pad_len and (len(pad) + pad_len) % 4 != 0):
        raise Unreadable(f'{what} is not valid base64{"url" if url else ""}')
    t = pad + '=' * (-len(pad) % 4)
    try:
        return base64.urlsafe_b64decode(t) if url else base64.b64decode(t, validate=True)
    except (binascii.Error, ValueError):
        raise Unreadable(f'{what} is not valid base64{"url" if url else ""}') from None


# ---- the fields, in one place ------------------------------------------------------------------------

def _empty_fields() -> Dict[str, Any]:
    return {'to': [], 'cc': [], 'bcc': [], 'subject': None, 'body': None}


def _finish_fields(f: Dict[str, Any]) -> Dict[str, Any]:
    """Drop the optional keys that are absent; a subject with a line break is header injection."""
    if f.get('subject') is not None:
        _no_line_break(f['subject'], 'subject')
    out = {'to': list(f['to']), 'cc': list(f['cc']), 'bcc': list(f['bcc'])}
    out['subject'] = '' if f.get('subject') is None else f['subject']
    out['body'] = '' if f.get('body') is None else f['body']
    for k in ('html_sha256', 'attachments', 'from', 'reply_to', 'in_reply_to'):
        if f.get(k) not in (None, []):
            out[k] = f[k]
    if 'from' in out:
        _no_line_break(out['from'], 'from')
    if 'in_reply_to' in out:
        _no_line_break(out['in_reply_to'], 'in_reply_to')
    return out


# ---- MCP / tool input ----------------------------------------------------------------------------------

_IGNORED_KEYS = frozenset((
    'userid', 'user_id', 'threadid', 'thread_id', 'messageid', 'message_id', 'draftid', 'draft_id', 'draft', 'labelids',
    'label_ids', 'operation', 'action', 'mimetype', 'contenttype', 'content_type', 'id', 'maxresults', 'query', 'q',
    'markasread', 'reply_all', 'replyall', 'dry_run', 'dryrun', 'account', 'timeout',
))
_PLAIN_ALIASES = ('body', 'text', 'message', 'content', 'plain', 'textbody', 'text_body')
_HTML_ALIASES = ('html', 'htmlbody', 'html_body')
_RECIPIENT_WORD = re.compile(r'(?:^|[^a-z])(to|cc|bcc|recipient|recipients|torecipients|ccrecipients|bccrecipients|address|addresses|email|emails|sendto|forward|forwardto)(?:$|[^a-z])')


def _as_str_list(v: Any, field: str) -> List[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v] if v != '' else []
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        return list(v)
    raise Unreadable(f'{field} must be a text or a list of texts')


def _tool_attachment(item: Any) -> Dict[str, Any]:
    if isinstance(item, str):
        item = {'path': item}
    if not isinstance(item, dict):
        raise Unreadable('an attachment is neither a path nor an object')
    allowed = {'filename', 'name', 'content', 'path', 'contenttype', 'content_type', 'mimetype', 'type', 'encoding', 'cid', 'disposition'}
    for k in item:
        if str(k).lower() not in allowed:
            raise Unreadable(f'an attachment carries a field the reader does not know ("{str(k)[:30]}")')
    low = {str(k).lower(): v for k, v in item.items()}
    name = low.get('filename', low.get('name'))
    if 'filename' in low and 'name' in low and low['filename'] != low['name']:
        raise Unreadable('an attachment names its file twice, differently')
    content, path = low.get('content'), low.get('path')
    if content is not None and path is not None:
        raise Unreadable('an attachment gives both content and a path')
    src = content if content is not None else path
    if not isinstance(src, str) or src == '':
        raise Unreadable('an attachment has no content or path the reader can use')
    is_path = src.startswith('/') or re.match(r'^[A-Za-z]:[\\/]', src) is not None
    if content is not None and is_path:
        # The MCP tool takes "base64 OR an absolute path" in one field. A string that is both an existing
        # file and valid base64 would be read by the tool one way and by us the other.
        looks_b64 = True
        try:
            _strict_b64(src, 'content')
        except Unreadable:
            looks_b64 = False
        if os.path.isfile(src) and looks_b64:
            raise Unreadable('attachment content is both an existing file path and valid base64; give the path in "path"')
        if not os.path.isfile(src) and looks_b64:
            is_path = False
    if path is not None or (content is not None and is_path):
        if not os.path.isabs(src):
            raise Unreadable('an attachment path must be absolute')
        size, sha = _hash_file(src, 'an attachment')
        if not name:
            name = os.path.basename(src)
    else:
        data = _strict_b64(src, 'attachment content')
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise Unreadable('an attachment is too large')
        size, sha = len(data), _sha256_bytes(data)
        if not name:
            raise Unreadable('attachment content needs a filename')
    if not isinstance(name, str):
        raise Unreadable('an attachment filename is not text')
    return {'name': name, 'size': size, 'sha256': sha}


def _from_tool_input(ti: Dict[str, Any]) -> Dict[str, Any]:
    total = 0
    for v in ti.values():
        if isinstance(v, str):
            total += len(v)
        elif isinstance(v, list):
            total += sum(len(x) for x in v if isinstance(x, str))
    if total > MAX_INPUT_CHARS:
        raise Unreadable('the tool input is too large to read')
    low: Dict[str, Any] = {}
    for k, v in ti.items():
        lk = str(k).lower()
        if lk in low:
            raise Unreadable(f'the tool input names "{str(k)[:30]}" twice (case differs)')
        low[lk] = v
    handled = {'to', 'cc', 'bcc', 'subject', 'attachments', 'from', 'sender', 'replyto', 'reply_to', 'reply-to', 'inreplyto', 'in_reply_to', 'in-reply-to', 'headers'}
    handled |= set(_PLAIN_ALIASES) | set(_HTML_ALIASES)
    for k, v in low.items():
        if k in handled or k in _IGNORED_KEYS:
            continue
        if _RECIPIENT_WORD.search(k):
            raise Unreadable(f'the tool input has a field that may name recipients ("{k[:30]}"); the reader only knows to, cc and bcc')
        if isinstance(v, (bool, int, float)) or v is None:
            continue
        raise Unreadable(f'the tool input has a field the reader does not know ("{k[:30]}") and cannot rule out that it changes the mail')

    f = _empty_fields()
    for fld in ('to', 'cc', 'bcc'):
        f[fld] = parse_addresses(_as_str_list(low.get(fld), fld), fld)

    sub = low.get('subject')
    if sub is not None and not isinstance(sub, str):
        raise Unreadable('subject is not text')
    f['subject'] = sub

    plains = [(k, low[k]) for k in _PLAIN_ALIASES if low.get(k) not in (None, '')]
    for k, v in plains:
        if not isinstance(v, str):
            raise Unreadable(f'{k} is not text')
    if len({v for _, v in plains}) > 1:
        raise Unreadable('the tool input gives the body twice, differently (' + ', '.join(k for k, _ in plains) + ')')
    f['body'] = plains[0][1] if plains else ''
    htmls = [(k, low[k]) for k in _HTML_ALIASES if low.get(k) not in (None, '')]
    for k, v in htmls:
        if not isinstance(v, str):
            raise Unreadable(f'{k} is not text')
    if len({v for _, v in htmls}) > 1:
        raise Unreadable('the tool input gives the html twice, differently')
    if htmls:
        f['html_sha256'] = _sha256_bytes(_utf8(htmls[0][1], 'html'))

    if 'attachments' in low and low['attachments'] not in (None, []):
        atts = low['attachments']
        if not isinstance(atts, list):
            raise Unreadable('attachments must be a list')
        if len(atts) > MAX_ATTACHMENTS:
            raise Unreadable(f'more than {MAX_ATTACHMENTS} attachments')
        f['attachments'] = [_tool_attachment(a) for a in atts]

    senders = [(k, low[k]) for k in ('from', 'sender') if low.get(k) not in (None, '')]
    if len({v for _, v in senders}) > 1:
        raise Unreadable('the tool input names the sender twice, differently')
    if senders:
        if not isinstance(senders[0][1], str):
            raise Unreadable('from is not text')
        f['from'] = _one_address(senders[0][1], 'from')
    rts = [(k, low[k]) for k in ('replyto', 'reply_to', 'reply-to') if low.get(k) not in (None, '')]
    if len({json.dumps(v) for _, v in rts}) > 1:
        raise Unreadable('the tool input names the reply-to twice, differently')
    if rts:
        vals = _as_str_list(rts[0][1], 'reply_to')
        if len(vals) != 1:
            raise Unreadable('reply_to must be exactly one address')
        f['reply_to'] = _one_address(vals[0], 'reply_to')
    irts = [(k, low[k]) for k in ('inreplyto', 'in_reply_to', 'in-reply-to') if low.get(k) not in (None, '')]
    if len({v for _, v in irts if isinstance(v, str)}) > 1 or any(not isinstance(v, str) for _, v in irts):
        raise Unreadable('in-reply-to is not one text')
    if irts:
        f['in_reply_to'] = irts[0][1]

    hdrs = low.get('headers')
    if hdrs not in (None, {}, []):
        if not isinstance(hdrs, dict):
            raise Unreadable('headers is not an object')
        for hk, hv in hdrs.items():
            hl = str(hk).lower()
            if hl == 'in-reply-to' and isinstance(hv, str) and 'in_reply_to' not in f:
                f['in_reply_to'] = hv
            elif hl.startswith('x-') or hl in ('references', 'list-unsubscribe', 'list-id', 'precedence', 'auto-submitted'):
                continue
            else:
                raise Unreadable(f'a custom header ("{str(hk)[:30]}") may change who gets the mail; the reader only allows in-reply-to, references and x-* headers')
    return _finish_fields(f)


# ---- MIME (raw RFC 822 message) ------------------------------------------------------------------------

_SINGLE_HEADERS = ('subject', 'from', 'reply-to', 'in-reply-to', 'sender')
_RECIPIENT_HEADERS = ('to', 'cc', 'bcc')


def _unfold(value: str) -> str:
    v = re.sub(r'\r?\n(?=[ \t])', '', value)
    if '\r' in v or '\n' in v:
        raise Unreadable('a header has a line break that is not a folding (header injection)')
    return v


def _header_ascii(value: str, name: str) -> str:
    v = _unfold(value)
    try:
        v.encode('ascii')
    except UnicodeEncodeError:
        raise Unreadable(f'the {name} header holds non-ASCII text; only the subject may') from None
    return v


def _decode_subject(raw: str) -> str:
    v = _unfold(raw)
    try:
        v = v.encode('ascii', 'surrogateescape').decode('utf-8') if any('\udc80' <= c <= '\udcff' for c in v) else v
        return str(make_header(decode_header(v)))
    except Exception:  # noqa: BLE001
        raise Unreadable('the subject could not be decoded') from None


def _leaf_bytes(part: Any) -> bytes:
    payload = part.get_payload(decode=True)
    if payload is None:
        return b''
    return payload


def _part_text(part: Any) -> str:
    data = _leaf_bytes(part)
    charset = part.get_content_charset() or 'utf-8'
    try:
        return _fold_newlines(data.decode(charset, 'strict'))
    except (UnicodeDecodeError, LookupError):
        raise Unreadable('a text part of the message is not valid in its declared charset') from None


def from_mime(raw: bytes, extra_recipients: Optional[List[str]] = None, use_header_recipients: bool = True) -> Dict[str, Any]:
    """The fields of a raw RFC 822 / MIME message.

    extra_recipients are addresses the sending program gets on its command line (sendmail a@x.test): they
    go to the envelope as bcc unless the headers already list them in to or cc.
    """
    if len(raw) > MAX_MIME_BYTES:
        raise Unreadable('the message is too large to read')
    try:
        msg = message_from_bytes(raw, policy=email.policy.compat32)
    except Exception:  # noqa: BLE001
        raise Unreadable('the message could not be parsed') from None
    if raw.lstrip()[:1] in (b'', b'<', b'{'):
        raise Unreadable('the message does not start with headers')

    headers: Dict[str, List[str]] = {}
    for k, v in msg.raw_items():
        headers.setdefault(k.lower(), []).append(v if isinstance(v, str) else str(v))
    if not headers:
        raise Unreadable('the message has no headers')
    for n in headers:
        if n.startswith('resent-'):
            raise Unreadable('the message has Resent-* headers, which change the recipients of some mailers')
    for n in _SINGLE_HEADERS:
        if len(headers.get(n, [])) > 1:
            raise Unreadable(f'the message has more than one "{n}" header; mailers disagree on which one counts')
    if 'mime-version' in headers and len(headers['mime-version']) > 1:
        raise Unreadable('the message has more than one MIME-Version header')

    f = _empty_fields()
    if use_header_recipients:
        for fld in _RECIPIENT_HEADERS:
            f[fld] = parse_addresses([_header_ascii(v, fld) for v in headers.get(fld, [])], fld)
    if extra_recipients:
        listed = set(f['to']) | set(f['cc']) | set(f['bcc'])
        listed_norm = {_normalize_address(a) for a in listed}
        for a in extra_recipients:
            if _normalize_address(a) not in listed_norm:
                f['bcc'].append(a)
    if 'subject' in headers:
        f['subject'] = _decode_subject(headers['subject'][0])
    if 'from' in headers:
        f['from'] = _one_address(_header_ascii(headers['from'][0], 'from'), 'from')
    if 'reply-to' in headers:
        f['reply_to'] = _one_address(_header_ascii(headers['reply-to'][0], 'reply-to'), 'reply_to')
    if 'in-reply-to' in headers:
        f['in_reply_to'] = _header_ascii(headers['in-reply-to'][0], 'in-reply-to').strip()

    plains: List[str] = []
    htmls: List[bytes] = []
    atts: List[Dict[str, Any]] = []
    stack = [msg]
    count = 0
    while stack:
        part = stack.pop()
        count += 1
        if count > 200:
            raise Unreadable('the message has too many parts')
        if part.defects:  # the root is one of the parts: a malformed message is refused here
            raise Unreadable('a part of the message is malformed (' + type(part.defects[0]).__name__ + ')')
        if part.get_content_type().startswith('message/'):
            raise Unreadable('the message carries another message; attach it as a file instead')
        if part.is_multipart():
            kids = part.get_payload()
            if not isinstance(kids, list):
                raise Unreadable('a multipart part has no parts')
            stack.extend(reversed(kids))
            continue
        ctype = part.get_content_type()
        disp = (part.get_content_disposition() or '').lower()
        filename = part.get_filename()
        if disp == 'attachment' or filename:
            data = _leaf_bytes(part)
            if not filename:
                raise Unreadable('an attachment part has no file name')
            if len(data) > MAX_ATTACHMENT_BYTES:
                raise Unreadable('an attachment is too large')
            atts.append({'name': _decode_subject(filename) if '=?' in filename else filename, 'size': len(data), 'sha256': _sha256_bytes(data)})
        elif ctype == 'text/plain':
            plains.append(_part_text(part))
        elif ctype == 'text/html':
            htmls.append(_leaf_bytes(part))
        else:
            raise Unreadable(f'the message has an inline {ctype[:40]} part with no file name; the reader cannot say what it shows')
    if len(plains) > 1:
        raise Unreadable('the message has more than one inline text/plain part; a reader would show them all')
    if len(htmls) > 1:
        raise Unreadable('the message has more than one inline text/html part; a reader would show them all')
    f['body'] = plains[0] if plains else ''
    if htmls:
        f['html_sha256'] = _sha256_bytes(htmls[0])
    if atts:
        if len(atts) > MAX_ATTACHMENTS:
            raise Unreadable(f'more than {MAX_ATTACHMENTS} attachments')
        f['attachments'] = atts
    return _finish_fields(f)


# ---- Gmail REST / Resend JSON --------------------------------------------------------------------------

def _json_no_dups(text: str, what: str) -> Any:
    def pairs(items: List[Tuple[str, Any]]) -> Dict[str, Any]:
        d: Dict[str, Any] = {}
        for k, v in items:
            if k in d:
                raise Unreadable(f'{what} names "{k[:30]}" twice')
            d[k] = v
        return d

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=lambda c: (_ for _ in ()).throw(Unreadable(f'{what} is not valid JSON')))
    except Unreadable:
        raise
    except (ValueError, RecursionError):
        raise Unreadable(f'{what} is not valid JSON') from None


def _from_gmail_json(text: str) -> Dict[str, Any]:
    obj = _json_no_dups(text, 'the request body')
    if not isinstance(obj, dict):
        raise Unreadable('the request body is not a JSON object')
    if 'raw' not in obj:
        raise Unreadable('the request body has no "raw" message (a draft or a stored message is not readable here)')
    for k in obj:
        if k not in ('raw', 'threadId'):
            raise Unreadable(f'the request body has a field the reader does not know ("{str(k)[:30]}")')
    if not isinstance(obj['raw'], str):
        raise Unreadable('"raw" is not text')
    return from_mime(_strict_b64(obj['raw'], '"raw"', url=True))


def _from_resend_json(text: str) -> Dict[str, Any]:
    obj = _json_no_dups(text, 'the request body')
    if not isinstance(obj, dict):
        raise Unreadable('the request body is not a JSON object (a batch is not readable here)')
    ti: Dict[str, Any] = {}
    atts: List[Dict[str, Any]] = []
    for k, v in obj.items():
        if k in ('tags', 'scheduled_at'):
            continue  # neither changes who gets the mail or what it says
        if k == 'attachments':
            if v is None:
                continue
            if not isinstance(v, list):
                raise Unreadable('attachments must be a list')
            if len(v) > MAX_ATTACHMENTS:
                raise Unreadable(f'more than {MAX_ATTACHMENTS} attachments')
            for a in v:
                if not isinstance(a, dict):
                    raise Unreadable('an attachment is not an object')
                if a.get('path') is not None or a.get('filepath') is not None:
                    raise Unreadable('an attachment is fetched from a URL by the provider; the reader cannot see it')
                for kk in a:
                    if kk not in ('filename', 'content', 'content_type', 'contentType', 'content_id', 'inline_content_id'):
                        raise Unreadable('an attachment carries a field the reader does not know')
                content, name = a.get('content'), a.get('filename')
                if not isinstance(content, str) or not isinstance(name, str) or name == '':
                    raise Unreadable('an attachment needs a filename and base64 content (a number list is not readable)')
                data = _strict_b64(content, 'attachment content')
                atts.append({'name': name, 'size': len(data), 'sha256': _sha256_bytes(data)})
            continue
        if k == 'reply_to' and isinstance(v, list):
            if len(v) != 1:
                raise Unreadable('reply_to must be exactly one address')
            v = v[0]
        ti[k] = v
    out = _from_tool_input(ti)
    if atts:
        out['attachments'] = atts
    return out


# ======================================================================================================
# The shell reading (one linear pass; see the module docstring)
# ======================================================================================================

class _Word:
    __slots__ = ('text', 'dynamic', 'quoted')

    def __init__(self, text: str, dynamic: bool, quoted: bool) -> None:
        self.text = text
        self.dynamic = dynamic
        self.quoted = quoted


class _Cmd:
    __slots__ = ('words', 'stdin', 'piped', 'redirect_dynamic')

    def __init__(self) -> None:
        self.words: List[_Word] = []
        self.stdin: Optional[Tuple[str, Any]] = None  # ('file', _Word) | ('text', str) | ('pipe', None)
        self.piped = False
        self.redirect_dynamic = False


_WS = ' \t'
_VAR_START = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_{(\'"?$!#@*-')


class _Lexer:
    def __init__(self, text: str) -> None:
        if len(text) > MAX_CMD_CHARS:
            raise Unreadable(f'the command is longer than {MAX_CMD_CHARS} characters')
        self.s = text
        self.n = len(text)
        self.i = 0
        self.cmds: List[_Cmd] = []
        self.cur = _Cmd()
        self.pending_heredocs: List[Tuple[_Cmd, str, bool, bool]] = []
        self.redirect: Optional[Tuple[str, str]] = None  # (op, fd) waiting for its target word
        self.nwords = 0
        self.subst = False

    # -- words ------------------------------------------------------------------------------------------
    def _end_cmd(self, piped_next: bool = False) -> None:
        if self.redirect is not None:
            raise Unreadable('a redirection has no target')
        if self.cur.words or self.cur.stdin is not None:
            self.cmds.append(self.cur)
        self.cur = _Cmd()
        self.cur.piped = piped_next

    def _add_word(self, w: _Word) -> None:
        self.nwords += 1
        if self.nwords > MAX_WORDS:
            raise Unreadable('the command has too many words')
        if self.redirect is not None:
            op, _fd = self.redirect
            self.redirect = None
            if w.dynamic:
                self.cur.redirect_dynamic = True
            if op == '<':
                self.cur.stdin = ('file', w)
            elif op == '<<<':
                if w.dynamic:
                    self.cur.redirect_dynamic = True
                self.cur.stdin = ('text', w.text + '\n')
            return  # other targets (>, >>, >&) carry no input
        self.cur.words.append(w)

    def _read_word(self) -> _Word:
        """Read one word starting at self.i (self.s[self.i] is a word character). Returns it."""
        s, n = self.s, self.n
        buf: List[str] = []
        dyn = False
        quoted = False
        i = self.i
        started_tilde = s[i] == '~'
        brace_open = False
        brace_sep = False
        while i < n:
            c = s[i]
            if c in _WS or c in '\n;&|()<>':
                if c == '(' and buf and buf[-1] == '$':
                    pass  # handled below as substitution; not reached (the '$' branch consumes it)
                break
            if c == "'":
                j = s.find("'", i + 1)
                if j == -1:
                    raise Unreadable('an unterminated single quote')
                buf.append(s[i + 1:j])
                quoted = True
                i = j + 1
                continue
            if c == '"':
                quoted = True
                i += 1
                while True:
                    if i >= n:
                        raise Unreadable('an unterminated double quote')
                    d = s[i]
                    if d == '"':
                        i += 1
                        break
                    if d == '\\':
                        if i + 1 >= n:
                            raise Unreadable('an unterminated double quote')
                        e = s[i + 1]
                        if e in '$`"\\':
                            buf.append(e)
                        elif e == '\n':
                            pass
                        else:
                            buf.append('\\' + e)
                        i += 2
                        continue
                    if d == '`' or (d == '$' and i + 1 < n and s[i + 1] in '({'):
                        self.subst = True
                        dyn = True
                    elif d == '$' and i + 1 < n and s[i + 1] in _VAR_START:
                        dyn = True
                    buf.append(d)
                    i += 1
                continue
            if c == '\\':
                if i + 1 >= n:
                    buf.append('\\')
                    i += 1
                    continue
                if s[i + 1] == '\n':
                    i += 2
                    continue
                buf.append(s[i + 1])
                quoted = True
                i += 2
                continue
            if c == '`':
                self.subst = True
                dyn = True
                buf.append(c)
                i += 1
                continue
            if c == '$':
                nxt = s[i + 1] if i + 1 < n else ''
                if nxt == "'":
                    # ANSI-C quoting: escapes the reader does not decode
                    j = i + 2
                    while j < n and s[j] != "'":
                        j += 2 if s[j] == '\\' else 1
                    if j >= n:
                        raise Unreadable('an unterminated $\'...\' quote')
                    dyn = True
                    quoted = True
                    buf.append(s[i:j + 1])
                    i = j + 1
                    continue
                if nxt == '"':
                    i += 1  # locale-translated double quote: read as an ordinary one
                    continue
                if nxt in ('(', '{'):
                    self.subst = True
                    dyn = True
                    buf.append('$')
                    i += 1
                    if nxt == '(':
                        break  # the substitution's content is read as commands by the main loop
                    continue
                if nxt and nxt in _VAR_START:
                    dyn = True
                buf.append('$')
                i += 1
                continue
            if c in '*?[':
                dyn = True  # a glob: the shell would replace it with file names
            elif c == '{':
                brace_open = True
            elif c == ',' and brace_open:
                brace_sep = True
            elif c == '}' and brace_open:
                if brace_sep:
                    dyn = True  # brace expansion {a,b}
                brace_open, brace_sep = False, False
            elif c == '.' and brace_open and i + 1 < n and s[i + 1] == '.':
                brace_sep = True
            buf.append(c)
            i += 1
        self.i = i
        text = ''.join(buf)
        if started_tilde and not quoted and (text == '~' or text.startswith('~/')):
            text = os.path.expanduser(text)
        elif started_tilde and not quoted and text.startswith('~'):
            dyn = True  # ~user
        return _Word(text, dyn, quoted)

    def _read_heredocs(self) -> None:
        """Called just after a newline: read the bodies of the heredocs opened on the line before."""
        s, n = self.s, self.n
        for cmd, delim, quoted, strip in self.pending_heredocs:
            lines: List[str] = []
            closed = False
            while self.i < n:
                j = s.find('\n', self.i)
                line = s[self.i:] if j == -1 else s[self.i:j]
                self.i = n if j == -1 else j + 1
                cmp = line.lstrip('\t') if strip else line
                if cmp == delim:
                    closed = True
                    break
                lines.append(line.lstrip('\t') if strip else line)
            if not closed:
                raise Unreadable(f'the heredoc "{delim[:30]}" is never closed')
            body = '\n'.join(lines) + '\n' if lines else ''
            if not quoted:
                body = _expand_unquoted_heredoc(body)
            cmd.stdin = ('text', body)
        self.pending_heredocs = []

    # -- main loop --------------------------------------------------------------------------------------
    def run(self) -> List[_Cmd]:
        s, n = self.s, self.n
        while self.i < n:
            c = s[self.i]
            if c in _WS:
                self.i += 1
            elif c == '\n':
                self.i += 1
                self._end_cmd()
                if self.pending_heredocs:
                    self._read_heredocs()
            elif c == '#' and (self.i == 0 or s[self.i - 1] in _WS + '\n;&|()'):
                j = s.find('\n', self.i)
                self.i = n if j == -1 else j
            elif c == ';':
                self.i += 1
                self._end_cmd()
            elif c == '&':
                self.i += 1
                if self.i < n and s[self.i] == '&':
                    self.i += 1
                self._end_cmd()
            elif c == '|':
                self.i += 1
                if self.i < n and s[self.i] == '|':
                    self.i += 1
                    self._end_cmd()
                else:
                    if self.i < n and s[self.i] == '&':
                        self.i += 1
                    self._end_cmd(piped_next=True)
            elif c in '()':
                self.i += 1
                self._end_cmd()
            elif c in '<>':
                self._redirect_operator()
            else:
                # An all-digit word directly before < or > is a file descriptor, not an argument.
                j = self.i
                while j < n and s[j].isdigit() and s[j].isascii():
                    j += 1
                if j > self.i and j < n and s[j] in '<>':
                    self.i = j
                    continue
                w = self._read_word()
                if w.text == '' and not w.quoted and not w.dynamic:
                    continue  # only a line continuation: the shell makes no word of it
                self._add_word(w)
        if self.redirect is not None:
            raise Unreadable('a redirection has no target')
        if self.pending_heredocs:
            raise Unreadable('a heredoc is opened but its body is missing')
        self._end_cmd()
        return self.cmds

    def _redirect_operator(self) -> None:
        s, n = self.s, self.n
        c = s[self.i]
        if self.redirect is not None:
            raise Unreadable('two redirections in a row')
        if s.startswith('<(', self.i) or s.startswith('>(', self.i):
            self.subst = True
            self.i += 2
            return
        if c == '<':
            if s.startswith('<<<', self.i):
                self.i += 3
                self.redirect = ('<<<', '0')
                return
            if s.startswith('<<', self.i):
                self.i += 2
                strip = False
                if self.i < n and s[self.i] == '-':
                    strip = True
                    self.i += 1
                while self.i < n and s[self.i] in _WS:
                    self.i += 1
                if self.i >= n or s[self.i] in '\n;&|()<>':
                    raise Unreadable('a heredoc has no delimiter')
                w = self._read_word()
                if w.dynamic:
                    raise Unreadable('a heredoc delimiter that the shell would expand')
                self.pending_heredocs.append((self.cur, w.text, w.quoted, strip))
                self.nwords += 1
                return
            if s.startswith('<&', self.i) or s.startswith('<>', self.i):
                raise Unreadable('an input duplication or read-write redirection is not read here')
            self.i += 1
            self.redirect = ('<', '0')
            return
        # '>' forms: output only
        self.i += 1
        if self.i < n and s[self.i] in '>|&':
            self.i += 1
        self.redirect = ('>', '1')


def _expand_unquoted_heredoc(body: str) -> str:
    """The text of a heredoc whose delimiter was not quoted: backslash rules applied, expansions refused."""
    out: List[str] = []
    i, n = 0, len(body)
    while i < n:
        c = body[i]
        if c == '\\' and i + 1 < n:
            e = body[i + 1]
            if e in '$`\\':
                out.append(e)
                i += 2
                continue
            if e == '\n':
                i += 2
                continue
            out.append(c)
            i += 1
            continue
        if c == '`' or (c == '$' and i + 1 < n and body[i + 1] in _VAR_START):
            raise Unreadable('the heredoc body holds a $ or backtick expansion (the delimiter is not quoted); quote the delimiter: <<\'EOF\'')
        out.append(c)
        i += 1
    return ''.join(out)


# ---- recognising the sending command ----------------------------------------------------------------

_ASSIGN_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*=')
_RESERVED = frozenset(('if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', '!', '{', '}', 'time'))
_INTERPRETERS = re.compile(r'(?:python[0-9.]*|pypy3?|node|nodejs|tsx|ts-node|bun|npx|bunx)')
_SAFE_INTERP_FLAGS = frozenset(('-u', '-B', '-E', '-s', '-S', '-I', '-O', '-OO', '-q', '-b', '-bb', '-y', '--yes', '--no-install', '--quiet', '--no-warnings', '--'))
_SHELLS = frozenset(('sh', 'bash', 'zsh', 'dash', 'ksh'))
_PASS_THROUGH = frozenset(('env', 'command', 'exec', 'nohup', 'builtin'))


def _basename(p: str) -> str:
    return p.rsplit('/', 1)[-1]


class _Send:
    def __init__(self, kind: str, args: List[_Word], cmd: _Cmd, cd_seen: bool, script: str = '', tainted: bool = False,
                 interp: str = '', between: Optional[List[str]] = None) -> None:
        self.kind = kind
        self.args = args
        self.cmd = cmd
        self.cd_seen = cd_seen
        self.script = script   # the literal word that names the program (path as typed); '' when not known
        # How the script was started: `interp` is the interpreter word as typed ('' when the script is run directly,
        # its own shebang deciding), `between` the words the reader skipped between that interpreter and the script
        # (options, or further interpreter-like words such as `python3 python3 x.py`).
        self.interp = interp
        self.between = list(between or [])
        # True when the call, before this command, assigned a variable, went through `env`, or ran a command that sets
        # the shell's environment (export, source, eval ...): the environment the program starts with is then not the
        # one it was judged in (PYTHONPATH, PATH ...). Only the official-sender intent looks at it.
        self.tainted = tainted


# Commands whose whole job is to change the environment or run other text in this shell.
_ENV_SETTERS = frozenset(('export', 'declare', 'typeset', 'unset', 'readonly', 'source', '.', 'eval', 'env'))


def _find_sends(text: str, depth: int, cd_seen_in: bool = False, tainted_in: bool = False) -> List[_Send]:
    # cd_seen_in / tainted_in: what the call did BEFORE this text ran (a nested `bash -c` starts where the outer call
    # stands: after a `cd` its relative paths are not the hook's cwd, and an exported variable is still set).
    if depth > MAX_SHELL_DEPTH:
        raise Unreadable('shell invocations are nested too deeply')
    lx = _Lexer(text)
    cmds = lx.run()
    if lx.subst:
        raise Unreadable('the command holds a command substitution ($(...), backticks or <(...)); write the mail command on its own with literal values')
    sends: List[_Send] = []
    cd_seen = cd_seen_in
    tainted = tainted_in
    for cmd in cmds:
        ws = cmd.words
        k = 0
        # assignments, reserved words, simple pass-through wrappers
        while k < len(ws):
            w = ws[k]
            if not w.quoted and _ASSIGN_RE.match(w.text) and not w.text.startswith('='):
                tainted = True
                k += 1
            elif w.text in _RESERVED and not w.quoted:
                k += 1
            elif _basename(w.text) in _PASS_THROUGH and not w.dynamic:
                if _basename(w.text) == 'env':
                    tainted = True
                k += 1
                while k < len(ws) and (ws[k].text.startswith('-') or _ASSIGN_RE.match(ws[k].text)):
                    if ws[k].dynamic:
                        raise Unreadable('a wrapper option is not literal')
                    if ws[k].text in ('-u', '-C', '-S'):
                        k += 1  # takes a value
                    k += 1
            else:
                break
        if k >= len(ws):
            continue
        head = ws[k]
        if head.dynamic:
            raise UnreadableDynamicExec('the name of a command is not literal')
        name = _basename(head.text)
        if name in ('cd', 'pushd', 'popd'):
            cd_seen = True
            continue
        if name in _ENV_SETTERS:
            tainted = True
        if _INTERPRETERS.fullmatch(name):
            j = k + 1
            while j < len(ws):
                a = ws[j]
                if a.dynamic:
                    raise Unreadable('an interpreter argument is not literal')
                if _INTERPRETERS.fullmatch(_basename(a.text)):
                    j += 1
                    continue
                if a.text.startswith('-'):
                    if a.text not in _SAFE_INTERP_FLAGS:
                        if a.text in ('-c', '-e', '-p', '--eval', '--command', '--print') and any(w.dynamic for w in ws[j + 1:]):
                            raise UnreadableDynamicExec('an interpreter runs code that is a variable')
                        raise Unreadable(f'the interpreter option "{a.text[:20]}" is not one the reader understands')
                    j += 1
                    continue
                break
            if j >= len(ws):
                continue
            script = ws[j]
            if script.dynamic:
                raise Unreadable('the script name is not literal')
            kind = _kind_of(_basename(script.text))
            if kind:
                sends.append(_Send(kind, ws[j + 1:], cmd, cd_seen, script.text, tainted, head.text, [w.text for w in ws[k + 1:j]]))
            continue
        if name in _SHELLS:
            j = k + 1
            code = None
            while j < len(ws):
                a = ws[j]
                if re.fullmatch(r'-[A-Za-z]*c[A-Za-z]*', a.text) and j + 1 < len(ws):   # -c, -lc, -ec, -xc ...
                    if ws[j + 1].dynamic:
                        raise UnreadableDynamicExec('the code of a shell -c is not literal')
                    code = ws[j + 1].text
                    break
                if a.text.startswith('-') and not a.dynamic:
                    j += 1
                    continue
                break
            if code is not None:
                sends.extend(_find_sends(code, depth + 1, cd_seen, tainted))
            continue
        kind = _kind_of(name)
        if kind:
            sends.append(_Send(kind, ws[k + 1:], cmd, cd_seen, ws[k].text, tainted))
    return sends


def _kind_of(name: str) -> Optional[str]:
    if name == 'send.py':
        return 'sendpy'
    if name == 'gmail-send.py':
        return 'gmailsend'
    if name in ('graph-mail', 'graph-mail.ts', 'graph-mail.js', 'graph-mail.mjs'):
        return 'graph'
    if name in ('sendmail', 'msmtp'):
        return name
    if name in ('mail', 'mailx', 's-nail'):
        return 'mail'
    if name == 'curl':
        return 'curl'
    if name in ('swaks', 'wget', 'http', 'https', 'ssmtp', 'mutt', 'neomutt'):
        return 'unsupported:' + name
    return None


# ---- the options of each sending command -----------------------------------------------------------------

def _literal(words: List[_Word], what: str) -> List[str]:
    for w in words:
        if w.dynamic:
            raise Unreadable(f'{what} has an argument the shell would expand ({w.text[:40]}); write the value literally')
    return [w.text for w in words]


_NEGATIVE_NUMBER = re.compile(r'-\d+$|-\d*\.\d+$')


def _argparse_options(args: List[str], spec: Dict[str, str], prog: str) -> Dict[str, List[str]]:
    """Read args like argparse does: long options, unique-prefix abbreviations, --name=value, last wins.

    spec maps an option name (without dashes) to 'value', 'flag' or 'repeat'. Returns name -> values.
    A positional, an unknown or ambiguous option, a missing value, or a value that argparse would take for
    an option makes the call unreadable.
    """
    got: Dict[str, List[str]] = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            raise Unreadable(f'{prog}: "--" is not read')
        if not a.startswith('-') or a == '-':
            raise Unreadable(f'{prog}: an unexpected positional argument ("{a[:30]}")')
        if not a.startswith('--'):
            raise Unreadable(f'{prog}: the short option "{a[:20]}" is not read')
        name, eq, val = a[2:].partition('=')
        if name in spec:
            full = name
        else:
            cands = [o for o in spec if o.startswith(name)]
            if len(cands) != 1 or name == '':
                raise Unreadable(f'{prog}: the option "--{name[:30]}" is unknown or ambiguous')
            full = cands[0]
        kind = spec[full]
        if kind == 'flag':
            if eq:
                raise Unreadable(f'{prog}: "--{full}" takes no value')
            got.setdefault(full, []).append('')
            i += 1
            continue
        if eq:
            value = val
            i += 1
        else:
            if i + 1 >= len(args):
                raise Unreadable(f'{prog}: "--{full}" has no value')
            value = args[i + 1]
            if value.startswith('-') and ' ' not in value and value != '-' and not _NEGATIVE_NUMBER.match(value):
                raise Unreadable(f'{prog}: the value of "--{full}" starts with "-" and would be read as an option')
            i += 2
        if kind == 'repeat':
            got.setdefault(full, []).append(value)
        else:
            got[full] = [value]
    return got


def _resolve_path(p: str, send: _Send, cwd: str, what: str) -> str:
    if os.path.isabs(p):
        return p
    if send.cd_seen:
        raise Unreadable(f'{what} is a relative path after a cd in the same call; use an absolute path')
    return os.path.join(cwd, p)


def _stdin_text(send: _Send, cwd: str, what: str) -> Optional[str]:
    cmd = send.cmd
    if cmd.redirect_dynamic:
        raise Unreadable(f'{what}: a redirection target is not literal')
    if cmd.stdin is None:
        return '' if not cmd.piped else _raise_pipe(what)
    kind, val = cmd.stdin
    if kind == 'text':
        return val
    if kind == 'file':
        path = _resolve_path(val.text, send, cwd, 'the stdin file')
        return _decode_text(_read_file(path, MAX_BODY_FILE_BYTES, 'the stdin file'), 'the stdin file')
    return _raise_pipe(what)


def _raise_pipe(what: str) -> str:
    raise Unreadable(f'{what}: the content comes from a pipe the reader cannot see; use a heredoc (<<\'EOF\') or a file (< file)')


def _stdin_bytes(send: _Send, cwd: str, what: str) -> bytes:
    cmd = send.cmd
    if cmd.redirect_dynamic:
        raise Unreadable(f'{what}: a redirection target is not literal')
    if cmd.stdin is None:
        if cmd.piped:
            _raise_pipe(what)
        return b''
    kind, val = cmd.stdin
    if kind == 'text':
        return _utf8(val, what)
    if kind == 'file':
        return _read_file(_resolve_path(val.text, send, cwd, 'the stdin file'), MAX_MIME_BYTES, 'the stdin file')
    _raise_pipe(what)
    return b''


def _csv(value: Optional[str], field: str) -> List[str]:
    if value is None or value == '':
        return []
    return parse_addresses([value], field)


def _from_sendpy(send: _Send, cwd: str) -> Dict[str, Any]:
    args = _literal(send.args, 'send.py')
    o = _argparse_options(args, {'to': 'value', 'subject': 'value', 'body': 'value', 'cc': 'value', 'html': 'flag', 'help': 'flag'}, 'send.py')
    if 'help' in o:
        raise Unreadable('send.py --help is not a send')
    if 'to' not in o or 'subject' not in o:
        raise Unreadable('send.py needs --to and --subject')
    f = _empty_fields()
    f['to'] = _csv(o['to'][0], 'to')
    f['cc'] = _csv(o.get('cc', [None])[0], 'cc')
    f['subject'] = o['subject'][0]
    body = o['body'][0] if 'body' in o else _stdin_text(send, cwd, 'send.py body')
    f['body'] = body
    if 'html' in o:
        f['html_sha256'] = _sha256_bytes(_utf8(body or '', 'the body'))
    return _finish_fields(f)


def _from_graph(send: _Send, cwd: str) -> Dict[str, Any]:
    args = _literal(send.args, 'graph-mail')
    if not args or args[0] != 'send':
        raise Unreadable('graph-mail: the subcommand is not "send"')

    def flag(name: str) -> Optional[str]:
        try:
            i = args.index('--' + name)
        except ValueError:
            return None
        return args[i + 1] if i + 1 < len(args) else None

    to, subject, body = flag('to'), flag('subject'), flag('body')
    if not to or not subject or body is None:
        raise Unreadable('graph-mail send needs --to, --subject and --body')
    f = _empty_fields()
    # graph-mail splits on "," only and does not trim: an entry with a space is not a plain address.
    f['to'] = _split_plain(to, 'to')
    cc = flag('cc')
    f['cc'] = _split_plain(cc, 'cc') if cc else []
    f['subject'] = subject
    f['body'] = body
    if '--html' in args:
        f['html_sha256'] = _sha256_bytes(_utf8(body, 'the body'))
    return _finish_fields(f)


def _split_plain(value: str, field: str) -> List[str]:
    out = []
    for part in value.split(','):
        if _normalize_address(part) is None:
            raise Unreadable(f'{field} holds "{part[:60]}", which is not a plain local@domain address')
        out.append(part)
    return out


def _from_gmailsend(send: _Send, cwd: str) -> Dict[str, Any]:
    args = _literal(send.args, 'gmail-send.py')
    o = _argparse_options(args, {
        'to': 'repeat', 'cc': 'repeat', 'bcc': 'repeat', 'subject': 'value', 'body': 'value', 'body-file': 'value',
        'html': 'value', 'attach': 'repeat', 'from': 'value', 'reply-to': 'value', 'in-reply-to': 'value', 'help': 'flag',
    }, 'gmail-send.py')
    if 'help' in o:
        raise Unreadable('gmail-send.py --help is not a send')
    f = _empty_fields()
    for fld in ('to', 'cc', 'bcc'):
        f[fld] = parse_addresses(o.get(fld, []), fld)
    if 'subject' not in o:
        raise Unreadable('gmail-send.py needs --subject')
    f['subject'] = o['subject'][0]
    if 'body' in o and 'body-file' in o:
        raise Unreadable('gmail-send.py: --body and --body-file together')
    if 'body' in o:
        f['body'] = o['body'][0]
    elif 'body-file' in o:
        path = _resolve_path(o['body-file'][0], send, cwd, 'the body file')
        f['body'] = _decode_text(_read_file(path, MAX_BODY_FILE_BYTES, 'the body file'), 'the body file')
    else:
        f['body'] = _stdin_text(send, cwd, 'gmail-send.py body')
    if 'html' in o:
        path = _resolve_path(o['html'][0], send, cwd, 'the html file')
        f['html_sha256'] = _sha256_bytes(_read_file(path, MAX_ATTACHMENT_BYTES, 'the html file'))
    if o.get('attach'):
        if len(o['attach']) > MAX_ATTACHMENTS:
            raise Unreadable(f'more than {MAX_ATTACHMENTS} attachments')
        atts = []
        for p in o['attach']:
            path = _resolve_path(p, send, cwd, 'an attachment')
            size, sha = _hash_file(path, 'an attachment')
            atts.append({'name': os.path.basename(path), 'size': size, 'sha256': sha})
        f['attachments'] = atts
    if 'from' in o:
        f['from'] = _one_address(o['from'][0], 'from')
    if 'reply-to' in o:
        f['reply_to'] = _one_address(o['reply-to'][0], 'reply_to')
    if 'in-reply-to' in o:
        f['in_reply_to'] = o['in-reply-to'][0]
    return _finish_fields(f)


def gmail_send_fields(args: List[str], cwd: str, stdin_text: Optional[str] = None) -> Dict[str, Any]:
    """The fields scripts/gmail-send.py sends for its command-line arguments: the SAME reading the send gate
    makes of that command line, so the hash the sender claims an approval for is the hash the gate computes.
    stdin_text is the body when neither --body nor --body-file is given. Raises Unreadable."""
    cmd = _Cmd()
    if stdin_text is not None:
        cmd.stdin = ('text', stdin_text)
    return _from_gmailsend(_Send('gmailsend', [_Word(a, False, True) for a in args], cmd, False), cwd)


def _short_options(args: List[str], flags: str, valued: str, longs: Dict[str, str], prog: str, glued: str = '') -> Tuple[List[Tuple[str, str]], List[str]]:
    """getopt-like: clustered short flags, glued or separate values, a few long options, then positionals."""
    opts: List[Tuple[str, str]] = []
    pos: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            pos.extend(args[i + 1:])
            break
        if a.startswith('--'):
            name, eq, val = a[2:].partition('=')
            if name not in longs:
                raise Unreadable(f'{prog}: the option "--{name[:30]}" is not one the reader understands')
            kind = longs[name]
            if kind == 'flag':
                opts.append((name, ''))
            elif eq:
                opts.append((name, val))
            else:
                if i + 1 >= len(args):
                    raise Unreadable(f'{prog}: "--{name}" has no value')
                opts.append((name, args[i + 1]))
                i += 1
            i += 1
            continue
        if a.startswith('-') and len(a) > 1:
            j = 1
            while j < len(a):
                c = a[j]
                if c in glued:
                    if j + 1 >= len(a):
                        raise Unreadable(f'{prog}: "-{c}" needs its value glued to it (-{c}x)')
                    opts.append((c, a[j + 1:]))
                    break
                if c in valued:
                    if j + 1 < len(a):
                        opts.append((c, a[j + 1:]))
                    else:
                        if i + 1 >= len(args):
                            raise Unreadable(f'{prog}: "-{c}" has no value')
                        opts.append((c, args[i + 1]))
                        i += 1
                    break
                if c in flags:
                    opts.append((c, ''))
                    j += 1
                    continue
                raise Unreadable(f'{prog}: the option "-{c}" is not one the reader understands')
            i += 1
            continue
        pos.append(a)
        i += 1
    return opts, pos


def _from_sendmail(send: _Send, cwd: str) -> Dict[str, Any]:
    args = _literal(send.args, send.kind)
    if send.kind == 'sendmail':
        opts, pos = _short_options(args, 'tiv', 'fF', {}, 'sendmail', glued='o')
        read_headers = any(k == 't' for k, _ in opts)
    else:
        opts, pos = _short_options(args, 'tdv', 'fCa', {
            'read-recipients': 'flag', 'debug': 'flag', 'from': 'value', 'file': 'value', 'account': 'value', 'read-envelope-from': 'flag',
        }, 'msmtp')
        read_headers = any(k in ('t', 'read-recipients') for k, _ in opts)
    raw = _stdin_bytes(send, cwd, send.kind + ' message')
    if raw == b'':
        raise Unreadable(f'{send.kind}: there is no message on stdin (heredoc or < file)')
    wire = parse_addresses(pos, 'recipients') if pos else []
    if not read_headers and not wire:
        raise Unreadable(f'{send.kind}: no recipients on the command line and no -t')
    # Without -t the program delivers to the command-line addresses only; the headers are display.
    # Listing both is the safe superset: header recipients stay in to/cc, the others join bcc.
    return from_mime(raw, extra_recipients=wire, use_header_recipients=True)


def _from_mail(send: _Send, cwd: str) -> Dict[str, Any]:
    args = _literal(send.args, 'mail')
    opts, pos = _short_options(args, 'vn', 'sbcr', {}, 'mail')
    f = _empty_fields()
    f['to'] = parse_addresses(pos, 'recipients')
    for k, v in opts:
        if k == 's':
            f['subject'] = v
        elif k == 'c':
            f['cc'] = f['cc'] + parse_addresses([v], 'cc')
        elif k == 'b':
            f['bcc'] = f['bcc'] + parse_addresses([v], 'bcc')
        elif k == 'r':
            f['from'] = _one_address(v, 'from')
    f['body'] = _stdin_text(send, cwd, 'mail body')
    return _finish_fields(f)


# ---- curl (Gmail REST send route, Resend) ----------------------------------------------------------------

_CURL_FLAGS_NOVAL = set('sSfkvLig#')
_CURL_FLAGS_VAL = set('HXdoAeTmuwx')
_CURL_LONG_NOVAL = {'silent', 'show-error', 'fail', 'insecure', 'verbose', 'location', 'include', 'compressed', 'http1.1', 'http2', 'globoff', 'no-progress-meter', 'fail-with-body'}
_CURL_LONG_VAL = {'header', 'request', 'data', 'data-raw', 'data-binary', 'data-ascii', 'output', 'user-agent', 'url', 'json', 'upload-file', 'max-time', 'connect-timeout', 'write-out', 'retry'}
_CURL_DATA = {'data', 'data-raw', 'data-binary', 'data-ascii', 'json'}


def _from_curl(send: _Send, cwd: str) -> Dict[str, Any]:
    words = send.args
    args = [w.text for w in words]
    # A word the shell would expand is fine where it cannot change the mail (a header value such as a
    # token, an output file); it is refused where it decides the request or its content.
    dyn = [w.dynamic for w in words]
    urls: List[str] = []
    url_at: List[int] = []   # index of the word each URL came from
    data: List[Tuple[str, str]] = []  # (option, value)
    upload: Optional[str] = None
    upload_at = -1
    globoff = False
    content_opts = _CURL_DATA | {'url', 'upload-file'}

    def need_literal(idx: int, what: str) -> None:
        if dyn[idx]:
            raise Unreadable(f'curl: {what} has a value the shell would expand; write it literally')

    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('--'):
            name, eq, val = a[2:].partition('=')
            if name in _CURL_LONG_NOVAL:
                globoff = globoff or name == 'globoff'
                i += 1
                continue
            if name not in _CURL_LONG_VAL:
                raise Unreadable(f'curl: the option "--{name[:30]}" is not one the reader understands')
            vi = i
            if not eq:
                if i + 1 >= len(args):
                    raise Unreadable(f'curl: "--{name}" has no value')
                val = args[i + 1]
                vi = i + 1
                i += 1
            if name in content_opts:
                need_literal(vi, '--' + name)
            if name == 'url':
                urls.append(val)
                url_at.append(vi)
            elif name in _CURL_DATA:
                data.append((name, val))
            elif name == 'upload-file':
                upload = val
                upload_at = vi
            i += 1
            continue
        if a.startswith('-') and len(a) > 1:
            j = 1
            while j < len(a):
                c = a[j]
                if c in _CURL_FLAGS_NOVAL:
                    globoff = globoff or c == 'g'
                    j += 1
                    continue
                if c in _CURL_FLAGS_VAL:
                    vi = i
                    if j + 1 < len(a):
                        val = a[j + 1:]
                    else:
                        if i + 1 >= len(args):
                            raise Unreadable(f'curl: "-{c}" has no value')
                        val = args[i + 1]
                        vi = i + 1
                        i += 1
                    if c in 'dT':
                        need_literal(vi, '-' + c)
                    if c == 'd':
                        data.append(('data', val))
                    elif c == 'T':
                        upload = val
                        upload_at = vi
                    break
                raise Unreadable(f'curl: the option "-{c}" is not one the reader understands')
            i += 1
            continue
        need_literal(i, 'the URL')
        urls.append(a)
        url_at.append(i)
        i += 1
    if len(urls) != 1:
        raise Unreadable('curl: exactly one URL is expected')
    if len(data) + (1 if upload else 0) != 1:
        raise Unreadable('curl: exactly one request body is expected (several -d options are joined by curl; the reader does not guess)')
    url = urls[0]
    # -T takes a glob as well: -T "{a,b}" uploads (sends) every file it names
    globbed = [(u, i) for u, i in [(url, url_at[0])] + ([(upload, upload_at)] if upload is not None else [])
               if re.search(r'[{}\[\]]', u) and not (globoff and words[i].quoted)]
    if globbed:
        # curl expands {a,b} and [1-3] in a URL into several requests (one command, several identical POSTs:
        # one approval, several mails); an unquoted word is expanded by the shell first, whatever curl does.
        # Only --globoff / -g together with a quoted URL makes the brackets plain characters.
        raise Unreadable('curl: the URL has {}, [] or a glob that curl or the shell would expand into several requests; remove them, or quote the URL and add --globoff')
    m = re.fullmatch(r'(?:https://)?([A-Za-z0-9.-]+)(/[^?#]*)?(?:\?([^#]*))?', url)
    if not m:
        raise Unreadable('curl: the URL is not a plain https URL')
    host, path, query = m.group(1).lower(), m.group(2) or '', m.group(3) or ''

    def body_text(opt: str, val: str, as_bytes: bool = False) -> Any:
        if opt == 'data-raw' or not val.startswith('@'):
            return _utf8(val, 'the request body') if as_bytes else val
        src = val[1:]
        if src == '-':
            raw = _stdin_bytes(send, cwd, 'curl body')
        else:
            raw = _read_file(_resolve_path(src, send, cwd, 'the request body file'), MAX_MIME_BYTES, 'the request body file')
        if opt in ('data', 'data-ascii'):
            raw = raw.replace(b'\r', b'').replace(b'\n', b'')  # curl strips line breaks for -d @file
        return raw if as_bytes else _decode_text(raw, 'the request body')

    if host in ('gmail.googleapis.com', 'www.googleapis.com'):
        if re.fullmatch(r'(?:/upload)?(?:/gmail/v1)?/users/[^/]+/messages/send', path) is None:
            raise Unreadable('curl: this Gmail route is not the message send route the reader knows (a draft send or an import is not readable)')
        if 'upload' in path or 'uploadType' in query:
            if upload is not None:
                raw = _read_file(_resolve_path(upload, send, cwd, 'the upload file'), MAX_MIME_BYTES, 'the upload file')
            else:
                raw = body_text(data[0][0], data[0][1], as_bytes=True)
            return from_mime(raw)
        if upload is not None:
            return _from_gmail_json(_decode_text(_read_file(_resolve_path(upload, send, cwd, 'the upload file'), MAX_MIME_BYTES, 'the upload file'), 'the upload file'))
        return _from_gmail_json(body_text(data[0][0], data[0][1]))
    if host == 'api.resend.com':
        if path.rstrip('/') != '/emails':
            raise Unreadable('curl: this Resend route is not POST /emails (a batch is not readable)')
        if upload is not None:
            return _from_resend_json(_decode_text(_read_file(_resolve_path(upload, send, cwd, 'the upload file'), MAX_MIME_BYTES, 'the upload file'), 'the upload file'))
        return _from_resend_json(body_text(data[0][0], data[0][1]))
    raise Unreadable(f'curl: "{host[:60]}" is not a mail API the reader knows')


_READERS = {
    'sendpy': _from_sendpy, 'graph': _from_graph, 'gmailsend': _from_gmailsend, 'sendmail': _from_sendmail,
    'msmtp': _from_sendmail, 'mail': _from_mail, 'curl': _from_curl,
}


def _from_bash(command: str, cwd: str) -> Dict[str, Any]:
    if not isinstance(command, str):
        raise Unreadable('the Bash command is not text')
    sends = _find_sends(command, 0)
    if not sends:
        raise Unreadable('no mail command the reader knows (send.py, graph-mail send, gmail-send.py, sendmail/msmtp, mail, curl to the Gmail or Resend send route) in the call')
    if len(sends) > 1:
        raise Unreadable('more than one mail command in one call; send one mail per call so each gets its own approval')
    s = sends[0]
    if s.kind.startswith('unsupported:'):
        raise Unreadable(f'{s.kind.split(":", 1)[1]} is not a form the reader supports; use send.py or the Gmail tool')
    return _READERS[s.kind](s, cwd)


# ======================================================================================================
# Entry points
# ======================================================================================================

_MAIL_NAMES = r'send\.py|gmail-send\.py|graph-mail(?:\.(?:ts|js|mjs))?|sendmail|msmtp|swaks|ssmtp|s-nail|neomutt|mutt'
# A name glued to an option (git grep -Osend.py) counts, so these have no left boundary; the short, common words
# (mail, mailx) need one so that gmail and email do not.
_MAIL_NAME = re.compile(r'(?:' + _MAIL_NAMES + r'|(?<![\w.-])mailx?)(?![\w.-])')
# The hosts curl reaches a mail API on (the reader's _from_curl knows the same three), and curl as a word of its own.
_MAIL_API_HOST = re.compile(r'(?:gmail\.googleapis\.com|www\.googleapis\.com|api\.resend\.com)', re.I)
_CURL_WORD = re.compile(r'(?<![\w.-])curl(?![\w.-])')
# Commands that only look at, copy or list a file and cannot be made to run another program by an
# argument: a mail program's NAME among their arguments is not a send.
_PURE_HEADS = frozenset((
    'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'ls', 'wc', 'diff', 'cmp', 'file', 'stat', 'echo', 'printf', 'test', '[',
    'cp', 'mv', 'rm', 'ln', 'chmod', 'chown', 'touch', 'mkdir', 'rmdir', 'basename', 'dirname', 'realpath', 'readlink',
    'which', 'type', 'sha256sum', 'shasum', 'md5', 'md5sum', 'uniq', 'cut', 'tr', 'pwd', 'true', 'false', 'sleep', 'date',
))


# Commands that run another program named in their arguments; with a word the shell decides at run time among
# those arguments, what runs cannot be ruled out to be a mail program.
_EXEC_WRAPPERS = frozenset(('eval', 'source', '.', 'xargs', 'timeout', 'nice', 'sudo', 'doas', 'find', 'watch', 'stdbuf', 'ssh', 'nohup', 'exec'))


def _runs_dynamic_code(ws: List[_Word], k: int) -> bool:
    """A wrapper whose arguments hold a word the shell decides at run time. (An interpreter with -c / -e and a
    variable never gets here: the shell reading above refuses it as dynamic code.)"""
    return _basename(ws[k].text) in _EXEC_WRAPPERS and any(w.dynamic for w in ws[k + 1:])


def _inert_cmd(ws: List[_Word], k: int) -> bool:
    """Only a program that cannot be made to run another one by an argument. Not git (-c, an alias, a
    subcommand that runs a program, a pager option) and not rg/ag (--pre): a mail program name among their
    arguments is judged a send, a false alarm the owner can live with; a parser of their options is a list
    that keeps growing."""
    return _basename(ws[k].text) in _PURE_HEADS


# The one gmail-send.py of THIS installation (this module lives in scripts/lib, the sender in scripts/).
OFFICIAL_SENDER_PATH = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'gmail-send.py'))


def _script_realpath(script: str, cd_seen: bool, cwd: Optional[str]) -> Optional[str]:
    """The real path the typed script word runs, or None when it cannot be known (relative with no usable cwd)."""
    if not script or script.startswith('-'):
        return None
    path = os.path.expanduser(script) if script.startswith('~') else script
    if not os.path.isabs(path):
        # Relative to the call's working directory; after a `cd` in the same call that directory is not the hook's cwd.
        if cd_seen or not isinstance(cwd, str) or not os.path.isabs(cwd):
            return None
        path = os.path.join(cwd, path)
    return os.path.realpath(path)


# What may stand between the interpreter and the script of the official sender. Everything else the reader skips
# (an option it merely understands, a second interpreter word) changes what runs, so it is not the official sender.
_OFFICIAL_INTERP_FLAGS = frozenset(('-I', '-u'))
_OFFICIAL_INTERP_BARE = frozenset(('python3', 'python'))
# Absolute paths a python interpreter may be named by (resolved, so a symlink to one of them counts).
_OFFICIAL_INTERP_PATHS = ('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3')


def _trusted_interpreters() -> frozenset:
    paths = {os.path.realpath(p) for p in _OFFICIAL_INTERP_PATHS if os.path.exists(p)}
    if sys.executable:
        paths.add(os.path.realpath(sys.executable))
    return frozenset(paths)


def _interpreter_is_trusted(interp: str) -> bool:
    """'' (the script runs itself), a bare `python3` / `python` (looked up on PATH, which an assignment would have
    tainted), or an ABSOLUTE path whose real path is the running interpreter or one of the standard python3 locations.
    A relative path (./python3, ../bin/python3) or any other absolute path is the agent's own interpreter."""
    if interp == '':
        return True
    if interp in _OFFICIAL_INTERP_BARE:
        return True
    if not os.path.isabs(interp):
        return False
    return os.path.realpath(interp) in _trusted_interpreters()


def command_is_official_sender(command: Any, cwd: Optional[str] = None, official_path: Optional[str] = None) -> bool:
    """True only when a Bash command runs exactly ONE mail command and it is THE installation's gmail-send.py.

    The gate marks the approval it reserves for such a call, so that the sender (and only the sender) may take the
    reservation over. Everything else -- curl, send.py, a second mail command, a command the reader cannot parse, and
    a copy of gmail-send.py at another path (same file name, other code) -- is NOT the official sender: the
    reservation stays the gate's and nothing adopts it. The script is judged by its real path (symlinks resolved)
    against `official_path` (default: the sibling of this module); a relative script needs the call's `cwd` and no
    `cd` in the same call. Fail closed: any doubt is False.
    """
    if not isinstance(command, str):
        return False
    try:
        sends = _find_sends(command, 0)
        if len(sends) != 1 or sends[0].kind != 'gmailsend' or sends[0].tainted:
            return False
        if not _interpreter_is_trusted(sends[0].interp) or any(w not in _OFFICIAL_INTERP_FLAGS for w in sends[0].between):
            return False
        got = _script_realpath(sends[0].script, sends[0].cd_seen, cwd)
        return got is not None and got == os.path.realpath(official_path or OFFICIAL_SENDER_PATH)
    except Exception:  # noqa: BLE001 -- a reader bug must read as "not the sender", never as a pass
        return False


def command_sends_mail(command: Any) -> bool:
    """True when a Bash command may run a mail program, or a curl call that may reach a mail API.

    A curl call is judged by text, fail closed: when the command runs curl and any of its words names a mail
    API host (the Gmail and Resend hosts, also inside a quoted or dynamic URL, --url X, an assignment such as
    U=https://... or a shell -c code) it is a send; whether it really is one, and what mail it is, is the
    reader's question afterwards (a URL it cannot read is refused there). A curl to a host that is not a mail
    API is not a send.

    Two further nets. The reader finds a mail program the way the shell would run it (also behind env, nohup,
    an interpreter, sh -c). A mail program it does not find that way, but that the command NAMES in a
    word of a command that is not just looking at files (timeout, nice, sudo, xargs, stdbuf, eval,
    find -exec, watch, ssh, bash -lc ...), is judged a send as well: the call is then refused as
    unreadable, which is the safe side. A command the shell reading cannot parse is judged by whether
    it names a mail program anywhere."""
    if not isinstance(command, str):
        return False
    try:
        if any(not s.kind == 'curl' for s in _find_sends(command, 0)):
            return True
        curl_seen = host_seen = False
        for cmd in _Lexer(command).run():
            ws = cmd.words
            k = 0
            wrapped = False
            while k < len(ws) and not ws[k].quoted:
                w = ws[k]
                if _ASSIGN_RE.match(w.text) or w.text in _RESERVED:
                    k += 1
                elif _basename(w.text) in _PASS_THROUGH:   # env, command, exec, nohup: the command is what follows
                    wrapped = True
                    k += 1
                elif wrapped and w.text.startswith('-'):
                    k += 1
                else:
                    break
            # a name in an assignment before the command (GIT_PAGER=send.py git log) runs under the command
            if any(_MAIL_NAME.search(w.text.split('=', 1)[-1]) for w in ws[:k]):
                return True
            if k < len(ws) and _runs_dynamic_code(ws, k):
                return True
            host_seen = host_seen or any(_MAIL_API_HOST.search(w.text) for w in ws)
            # behind a pass-through wrapper the head can be handed any program (env -u cat timeout 5 send.py): the
            # "only looks at files" shortcut is not applied there, every word is searched
            if k >= len(ws) or (not wrapped and _inert_cmd(ws, k)):
                continue
            if any(_MAIL_NAME.search(w.text) for w in ws[k:]):
                return True
            curl_seen = curl_seen or any(_CURL_WORD.search(w.text) for w in ws[k:])
        return curl_seen and host_seen
    except Exception as exc:  # noqa: BLE001 -- unreadable, or a reader bug: never a pass
        # A command whose name, or whose shell -c code, is not literal runs something nobody can name: refused
        # as a possible send. (A script name or an option that is not literal is not: python3 "$X/job.py" is
        # everyday, and the name search below still catches a mail program named in the text.)
        if isinstance(exc, Unreadable) and exc.dynamic_exec:
            return True
        # Judge the text itself, with the quoting and escaping that could hide a name taken out. A name built at
        # run time out of pieces ($(echo send).py) is the documented limit of a reader that never runs anything.
        plain = re.sub(r'[\\\'"]', '', command)
        return _MAIL_NAME.search(plain) is not None or (_CURL_WORD.search(plain) is not None and _MAIL_API_HOST.search(plain) is not None)


def collect_email_envelope(tool: str, tool_input: Any, cwd: Optional[str] = None) -> Dict[str, Any]:
    """The fields of the ONE mail this call sends, as the plain envelope build_envelope() takes.

    Returns the fields plus 'unreadable_reason' (None when the call was read exactly). When it is not
    None the fields are empty and must not be trusted: the call cannot be bound to an approval.
    """
    try:
        if not isinstance(tool_input, dict):
            raise Unreadable('the tool input is not an object')
        if str(tool).lower() == 'bash':
            fields = _from_bash(tool_input.get('command'), cwd if cwd is not None else os.getcwd())
        else:
            fields = _from_tool_input(tool_input)
        fields['unreadable_reason'] = None
        return fields
    except Unreadable as exc:
        return {'unreadable_reason': str(exc)}
    except Exception as exc:  # noqa: BLE001 -- a bug here must be "unreadable", never a pass
        return {'unreadable_reason': f'internal error while reading the call ({type(exc).__name__})'}


def envelope_of_call(tool: str, tool_input: Any, agent: str, cwd: Optional[str] = None) -> Dict[str, Any]:
    """collect_email_envelope() then build_envelope(): the hash a call is bound to, or why there is none.

    {'ok': True, 'envelope', 'canon', 'hash'} or {'ok': False, 'unreadable': bool, 'field', 'hint'}.
    """
    got = collect_email_envelope(tool, tool_input, cwd)
    reason = got.pop('unreadable_reason', 'unknown')
    if reason is not None:
        return {'ok': False, 'unreadable': True, 'field': 'call', 'hint': reason}
    built = build_envelope(got, agent)
    if not built['ok']:
        built['unreadable'] = False
    return built
