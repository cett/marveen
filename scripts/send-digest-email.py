#!/usr/bin/env python3
"""Send the day's RSS digest email via the Gmail REST API.

The gmail MCP times out too often for this scheduled step (see the
reggeli-napindito SKILL.md), so this sends directly against the Gmail REST
API instead: a workspace_docs `digest/<today>` doc is fetched from the
dashboard, its leading `<!-- UNTRUSTED-RSS ... -->` banner line is stripped,
and the result is emailed to the Gmail account the OAuth token belongs to
(read from that account's own profile at send time -- never hardcoded, so no
personal address lives in this file).

This script is a documented EXCEPTION to the email send gate: it runs unattended from a schedule, so it cannot
wait for an owner's approval, and it is allowed to do so only because it can mail ONE place, the owner's own
mailbox. The guarantee is in code, not only in SECURITY.md: send_via_gmail() is the only function of this module
that calls the Gmail send route, and it refuses (SelfSendOnly, nothing sent) any raw message whose headers are not
exactly one `To:` equal to the token account's own profile address, with no other recipient-bearing header. Importing
this module and calling build_raw_mime()/send_via_gmail() with another recipient therefore does not work; mail to
anyone else goes through scripts/gmail-send.py, which has the gate. A ratchet (scripts/gmail-send-route-ratchet.py)
keeps the send route literal out of every other file.

One more, named entry point exists for ONE other recipient: send_done_notification(), used by the owner-approved,
automatic done-card notifier (a heartbeat task outside this repository). It accepts exactly one fixed outside
address, pinned below as a SHA-256 constant (so no personal address lives in this public file), with the same strict
header check; any other address is refused. It takes no configuration from the environment, argv or a file, and a
new address can only enter through a code change and review. The caller does not write the message: it hands over a
task name, a status (one of a fixed set) and a time, and the text comes from a template in this file (the name is
reduced to letters, digits, spaces and a few separators, so no link or free-form sentence fits through it). It is also
rate-limited (at most 6 notices per rolling hour, state under store/) and fails closed: if that state cannot be read
or written, nothing is sent.

The refresh_token / access_token are never printed; only one of the fixed
outcome strings below goes to stdout.

Usage:
    python3 send-digest-email.py [--dry-run]

Exit codes: 0 for SENT and SKIP_NO_DIGEST, non-zero for a real failure.
"""
import base64
import binascii
import email
import email.policy
import hashlib
import hmac
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import agent_token  # noqa: E402
from datetime import datetime
from email.header import Header
from email.mime.text import MIMEText

try:
    import fcntl  # POSIX only: the done-notice rate limit needs it; without it the notifier fails closed
except ImportError:  # pragma: no cover - not reachable on macOS / Linux
    fcntl = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

GMAIL_CRED_DIR = os.path.expanduser("~/.gmail-mcp")
TOKEN_FILE = os.path.join(GMAIL_CRED_DIR, "token.json")
CREDENTIALS_FILE = os.path.join(GMAIL_CRED_DIR, "credentials.json")

DASHBOARD_BASE = os.environ.get("MARVEEN_DASHBOARD_BASE", "http://localhost:3420")


def _load_dotenv():
    """Parse key=value lines from REPO_ROOT/.env without shell expansion.
    Mirrors scripts/skill-migrate-placeholders.py's _load_dotenv."""
    env_file = os.path.join(REPO_ROOT, ".env")
    result = {}
    if not os.path.exists(env_file):
        return result
    with open(env_file, encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            result[key.strip()] = val
    return result


def build_signature():
    """Bot/owner name come from BOT_NAME/OWNER_NAME (env, then .env, then the
    same generic fallback src/config.ts uses) -- never hardcoded, so the
    public repo source names neither the agent nor its owner."""
    dotenv = _load_dotenv()
    bot_name = os.environ.get("BOT_NAME") or dotenv.get("BOT_NAME") or "Marveen"
    owner_name = os.environ.get("OWNER_NAME") or dotenv.get("OWNER_NAME") or "Owner"
    return f"\n\n--\n{bot_name}, {owner_name} AI asszisztense"


def fetch_digest_content(today):
    """Returns the digest/<today> workspace doc's content, or None if absent."""
    # Scheduled for the coordinator: its own token (no shared fallback).
    auth = agent_token.resolve(store_dir=os.path.join(REPO_ROOT, "store"), kind=agent_token.KIND_MAIN)
    if not auth.token:
        raise OSError(auth.error or "no token for the coordinator")
    query = urllib.parse.urlencode({"doc_key": f"digest/{today}"})
    url = f"{DASHBOARD_BASE}/api/workspace?{query}"
    req = urllib.request.Request(url, headers=auth.headers())
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    items = data.get("items", [])
    if not items:
        return None
    return items[0].get("content", "")


def strip_untrusted_banner(content):
    """Drops the leading `<!-- UNTRUSTED-RSS ... -->` marker line (and one
    blank line right after it, if present) -- see the RSS-digest untrusted-
    data handling note in the reggeli-napindito SKILL.md."""
    lines = content.split("\n")
    if lines and lines[0].strip().startswith("<!-- UNTRUSTED-RSS"):
        lines = lines[1:]
        if lines and lines[0].strip() == "":
            lines = lines[1:]
    return "\n".join(lines)


def refresh_access_token():
    with open(TOKEN_FILE, encoding="utf-8") as f:
        token_data = json.load(f)
    with open(CREDENTIALS_FILE, encoding="utf-8") as f:
        cred_data = json.load(f)
    inst = cred_data.get("installed", cred_data.get("web", cred_data))
    body = urllib.parse.urlencode({
        "client_id": inst["client_id"],
        "client_secret": inst["client_secret"],
        "refresh_token": token_data["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    token_uri = inst.get("token_uri", "https://oauth2.googleapis.com/token")
    req = urllib.request.Request(token_uri, data=body, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)["access_token"]


def fetch_own_email_address(access_token):
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)["emailAddress"]


def build_raw_mime(recipient, subject, body):
    msg = MIMEText(body, "plain", "utf-8")
    msg["To"] = recipient
    msg["Subject"] = str(Header(subject, "utf-8"))
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")


class SelfSendOnly(RuntimeError):
    """The message is not addressed to the token account's own mailbox alone; nothing was sent."""


# The only headers build_raw_mime() writes. Anything else (Cc, Bcc, Resent-*, Reply-To, From, a second To) is refused:
# Gmail sends to every address it finds in the headers, and a stricter list than the parser needs is the safe side.
_ALLOWED_HEADERS = frozenset(("mime-version", "content-type", "content-transfer-encoding", "to", "subject"))


def assert_self_addressed(raw_mime, own_address):
    """Raise SelfSendOnly unless the base64url message has exactly one To header whose whole value is `own_address`
    (case-insensitive, no display name, no list, no comment) and no header outside _ALLOWED_HEADERS."""
    if not isinstance(own_address, str) or not own_address.strip() or any(c in own_address for c in ' <>",;()\r\n\t'):
        raise SelfSendOnly("the account's own address is not usable")
    try:
        raw = base64.urlsafe_b64decode(str(raw_mime).encode("ascii") + b"=" * (-len(str(raw_mime)) % 4))
    except (UnicodeEncodeError, binascii.Error, ValueError):
        raise SelfSendOnly("the message is not base64url")
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    if msg.defects:
        raise SelfSendOnly("the message headers are malformed")
    seen = {}
    for name, value in msg.raw_items():
        key = name.strip().lower()
        if key not in _ALLOWED_HEADERS:
            raise SelfSendOnly("header %r is not allowed" % name[:40])
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            raise SelfSendOnly("header %r is repeated" % name[:40])
        if key == "to" and str(value).strip().casefold() != own_address.strip().casefold():
            raise SelfSendOnly("the recipient is not the account's own address")
    if "to" not in seen:
        raise SelfSendOnly("the message has no recipient")


def _post_to_gmail(access_token, raw_mime):
    """The raw POST to the Gmail send route. PRIVATE: reached only through send_via_gmail() or send_done_notification(),
    each of which has already checked the recipient. Nothing else in this module may call it."""
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=json.dumps({"raw": raw_mime}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def send_via_gmail(access_token, raw_mime):
    """Mail the token account's OWN mailbox. The own address is read from the account's profile HERE (not taken from the
    caller), so a caller cannot pass in the recipient it wants to be treated as own."""
    assert_self_addressed(raw_mime, fetch_own_email_address(access_token))
    return _post_to_gmail(access_token, raw_mime)


# SHA-256 of the lower-cased address of the ONE outside recipient of the automatic done-card notifier (owner decision
# 2026-10-19). A hash, not the address: this file is public. It is a constant on purpose: not read from the environment,
# argv or any file; changing it is a code change that goes through review (SECURITY.md).
_DONE_NOTIFY_RECIPIENT_SHA256 = "bf6d1ab3e7185314bfca9ecaf9a3785f9b26401a95bd6a9d383209ab82754bf3"


# The recipient is fixed, so what is left to bound is how much a (possibly injected) caller can push out through it.
# The caller never supplies the text: the message is this template, filled from three values. The status is one of a
# fixed set (the label is ours), the time is a number we format, and the task name is reduced to the characters below.
# No "." ":" "/" "@" "?" "=" "%" "&" or "<>" survives, so a link, an address or markup cannot be written with it, and
# no newline survives, so it cannot add a header or a line of its own.
_DONE_NOTICE_STATUS_LABELS = {
    "planned": "Tervezett",
    "in_progress": "Folyamatban",
    "waiting": "Várakozik",
    "done": "Kész",
}
_DONE_NOTICE_MAX_NAME_CHARS = 80
_DONE_NOTICE_MAX_SIGNATURE_NAME_CHARS = 40
_DONE_NOTICE_MAX_BODY_BYTES = 1024   # the template with every part at its cap is well under this (UTF-8 bytes)
_DONE_NOTICE_NAME_UNTITLED = "(névtelen feladat)"
_DONE_NOTICE_NAME_DISALLOWED = re.compile(r"[^\w \-(),+]")   # \w: Unicode letters, digits and "_"
_DONE_NOTICE_MIN_EPOCH = 946684800                            # 2000-01-01; anything earlier is not a done time
_DONE_NOTICE_FUTURE_SLACK_SECONDS = 86400

# Send-rate limit: at most this many notices in any rolling window. The state is a module attribute (not an
# environment variable) so a test can point it elsewhere; the lock file sits next to it.
_DONE_NOTICE_MAX_PER_WINDOW = 6
_DONE_NOTICE_WINDOW_SECONDS = 3600
_DONE_NOTICE_LOCK_WAIT_SECONDS = 5
DONE_NOTICE_STATE = os.path.join(REPO_ROOT, "store", "done-notice-state.json")

# One line per attempt that passed every check and is about to be sent: time, first 8 hex characters of the pin hash,
# body length. Never the text. A module attribute (not an environment variable) so a test can point it elsewhere.
DONE_NOTICE_LOG = os.path.join(REPO_ROOT, "store", "done-notice.log")


class DoneNoticeRateLimited(SelfSendOnly):
    """The window already holds the maximum number of notices; nothing was sent. Retry after the oldest ages out."""


class DoneNoticeStateError(SelfSendOnly):
    """The send-rate state could not be read, written or locked (or is not what we wrote); nothing was sent.
    Fail closed: without a trustworthy count there is no limit, so there is no mail."""


def _parsed_to(raw_mime):
    """The one `To` value of the base64url message as the parser sees it (what Gmail will mail), or None if there is not
    exactly one."""
    raw = base64.urlsafe_b64decode(str(raw_mime).encode("ascii") + b"=" * (-len(str(raw_mime)) % 4))
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    values = [str(v).strip() for k, v in msg.raw_items() if k.strip().lower() == "to"]
    return values[0] if len(values) == 1 else None


def _log_done_notice(body_len):
    """Append the one-line trace. Fails closed: if the trace cannot be written the notice is not sent (OSError)."""
    line = "%s %s %d\n" % (datetime.now().astimezone().isoformat(timespec="seconds"),
                           _DONE_NOTIFY_RECIPIENT_SHA256[:8], body_len)
    with open(DONE_NOTICE_LOG, "a", encoding="utf-8") as fh:
        fh.write(line)


def _compose_done_notice(task_name, status, done_at):
    """(subject, body) of a done notice from the fixed template. Raises SelfSendOnly if a value is not usable. The only
    caller-controlled text is the task name, and only after it has been reduced to _DONE_NOTICE_NAME_DISALLOWED's
    complement, collapsed to single spaces and cut to _DONE_NOTICE_MAX_NAME_CHARS characters."""
    if not isinstance(task_name, str):
        raise SelfSendOnly("the task name must be text")
    if not isinstance(status, str) or status not in _DONE_NOTICE_STATUS_LABELS:
        raise SelfSendOnly("the status is not one of the allowed values")
    if (isinstance(done_at, bool) or not isinstance(done_at, (int, float)) or not math.isfinite(done_at)
            or done_at < _DONE_NOTICE_MIN_EPOCH or done_at > time.time() + _DONE_NOTICE_FUTURE_SLACK_SECONDS):
        raise SelfSendOnly("the time must be a plausible epoch timestamp")
    name = _reduce_notice_text(task_name, _DONE_NOTICE_MAX_NAME_CHARS)
    label = _DONE_NOTICE_STATUS_LABELS[status]
    stamp = datetime.fromtimestamp(done_at).strftime("%Y-%m-%d %H:%M")
    body = "Feladat-értesítés\n\nFeladat: %s\nStátusz: %s\nIdőpont: %s%s" % (
        name or _DONE_NOTICE_NAME_UNTITLED, label, stamp, _done_notice_signature())
    # Backstop: every part is already bounded, so this only trips if a bound above is ever loosened by mistake.
    if len(body.encode("utf-8")) > _DONE_NOTICE_MAX_BODY_BYTES:
        raise SelfSendOnly("the notice is over the size limit")
    return "Feladat státusz: %s" % label, body


def _reduce_notice_text(text, max_chars):
    """`text` reduced to the characters a done notice may carry (see _DONE_NOTICE_NAME_DISALLOWED), runs of blanks
    collapsed to one space, cut to `max_chars`."""
    return " ".join(_DONE_NOTICE_NAME_DISALLOWED.sub(" ", text).split())[:max_chars].strip()


def _done_notice_signature():
    """The signature of a done notice. Same source as build_signature() (BOT_NAME / OWNER_NAME from the environment, then
    .env, then the generic fallback), but both names go through the same reduction as the task name and a short cap, so
    neither the environment nor .env can put a link, an address, markup, a line break or a long text into a mail to the
    fixed outside recipient."""
    dotenv = _load_dotenv()
    bot = _reduce_notice_text(os.environ.get("BOT_NAME") or dotenv.get("BOT_NAME") or "Marveen",
                              _DONE_NOTICE_MAX_SIGNATURE_NAME_CHARS) or "Marveen"
    owner = _reduce_notice_text(os.environ.get("OWNER_NAME") or dotenv.get("OWNER_NAME") or "Owner",
                                _DONE_NOTICE_MAX_SIGNATURE_NAME_CHARS) or "Owner"
    return f"\n\n--\n{bot}, {owner} AI asszisztense"


def _read_notice_state(now):
    """(send times, clamped) from DONE_NOTICE_STATE. Times are clamped to `now`: a time in the future counts as just
    sent, so it cannot be a way past the limit; `clamped` says one was, so the caller persists the clamped value and the
    entry ages from now on (otherwise a clock that was set forward and back would block for as long as the stamp lies
    ahead). A missing file is a first use; a file that exists but is unreadable, empty or not the shape we write is
    DoneNoticeStateError."""
    try:
        with open(DONE_NOTICE_STATE, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except FileNotFoundError:
        # First use. Known limit, documented in SECURITY.md: the counter is a file, so whoever can delete it as this user
        # resets it; that user can equally edit this script, so a file cannot be stronger than its permissions. What a
        # reset buys is bounded anyway: 6 fixed-template notices to the one pinned recipient per window.
        return [], False
    except (OSError, UnicodeDecodeError) as exc:
        raise DoneNoticeStateError("the send-rate state cannot be read") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise DoneNoticeStateError("the send-rate state is not valid JSON") from exc
    sent = data.get("sent") if isinstance(data, dict) else None
    if not isinstance(sent, list) or any(
            isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in sent):
        raise DoneNoticeStateError("the send-rate state has an unexpected shape")
    return [min(float(t), now) for t in sent], any(t > now for t in sent)


def _write_notice_state(sent):
    """Replace DONE_NOTICE_STATE atomically (temp file in the same directory, fsync, rename), 0600."""
    # O_EXCL on an unpredictable name: a planted file or symlink at the temp path is refused, never written through.
    tmp = "%s.tmp.%d.%s" % (DONE_NOTICE_STATE, os.getpid(), os.urandom(4).hex())
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, json.dumps({"sent": sent}).encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, DONE_NOTICE_STATE)
    except OSError as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise DoneNoticeStateError("the send-rate state cannot be written") from exc


def _reserve_done_notice_slot():
    """Take one place in the rolling window, or raise. Under an exclusive lock (two runs cannot both take the last
    place): read the state, drop what is older than the window, refuse if the maximum is already in it, else record now
    and persist BEFORE returning. The place is spent by the attempt, not by its success: a POST that timed out may
    still have been delivered, so giving the place back could mean a duplicate. Fails closed on any state problem."""
    if fcntl is None:
        raise DoneNoticeStateError("no file locking on this platform")
    try:
        lock_fd = os.open(DONE_NOTICE_STATE + ".lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError as exc:
        raise DoneNoticeStateError("the send-rate lock cannot be opened") from exc
    try:
        give_up = time.monotonic() + _DONE_NOTICE_LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= give_up:
                    raise DoneNoticeStateError("the send-rate lock is busy") from exc
                time.sleep(0.05)
        now = time.time()
        sent, clamped = _read_notice_state(now)
        recent = [t for t in sent if now - t < _DONE_NOTICE_WINDOW_SECONDS]
        if len(recent) >= _DONE_NOTICE_MAX_PER_WINDOW:
            if clamped:
                _write_notice_state(recent)   # pin the clamped stamps so they age out from now, not from the future
            raise DoneNoticeRateLimited("the done-notice rate limit is reached")
        recent.append(now)
        _write_notice_state(recent)
    finally:
        os.close(lock_fd)   # closing the descriptor releases the lock


def send_done_notification(access_token, recipient, task_name, status, done_at):
    """The named entry point of the done-card notifier: mail `recipient`, which must be the one pinned address, and only
    it. The caller supplies no message text: subject and body come from a fixed template filled with the task name
    (reduced, see _compose_done_notice), the status (one of _DONE_NOTICE_STATUS_LABELS) and the time (epoch seconds).
    Applies the same strict header check as the self-send (exactly one To equal to the recipient, no other
    recipient-bearing header), then checks the pin against the To value that is actually going into the message. Plain
    text only, at most 6 notices per rolling hour (the place is taken only once every check has passed, and the
    attempt spends it), one log line per send. Raises SelfSendOnly (nothing sent) for any other address, an unusable
    value or a non-plain message; DoneNoticeRateLimited at the limit; DoneNoticeStateError (both are SelfSendOnly) when
    the rate state cannot be trusted."""
    subject, body = _compose_done_notice(task_name, status, done_at)
    given = str(recipient).strip().casefold() if isinstance(recipient, str) else ""
    if not given:
        raise SelfSendOnly("the recipient is not the one address the done-card notifier may mail")
    raw_mime = build_raw_mime(given, subject, body)
    assert_self_addressed(raw_mime, given)
    # The pin runs LAST and on the parsed To header of the finished message, not on the raw input.
    actual = _parsed_to(raw_mime)
    if actual is None or not hmac.compare_digest(hashlib.sha256(actual.casefold().encode("utf-8")).hexdigest(),
                                                 _DONE_NOTIFY_RECIPIENT_SHA256):
        raise SelfSendOnly("the recipient is not the one address the done-card notifier may mail")
    raw = base64.urlsafe_b64decode(raw_mime.encode("ascii") + b"=" * (-len(raw_mime) % 4))
    if email.message_from_bytes(raw, policy=email.policy.default).get_content_type() != "text/plain":
        raise SelfSendOnly("the notice is not plain text")
    _reserve_done_notice_slot()
    _log_done_notice(len(body.encode("utf-8")))
    return _post_to_gmail(access_token, raw_mime)


def main(argv):
    dry_run = "--dry-run" in argv or os.environ.get("DRY_RUN") == "1"
    today = datetime.now().strftime("%Y-%m-%d")

    try:
        content = fetch_digest_content(today)
    except Exception:
        print("DIGEST_FETCH_FAIL")
        return 1

    if content is None:
        print("SKIP_NO_DIGEST")
        return 0

    body = strip_untrusted_banner(content).rstrip() + build_signature()
    subject = f"Napi RSS digest -- {today}"

    if not os.path.exists(TOKEN_FILE) or not os.path.exists(CREDENTIALS_FILE):
        print("MISSING_CREDS")
        return 1

    if dry_run:
        build_raw_mime("dry-run@example.invalid", subject, body)
        print("DRY-OK")
        return 0

    try:
        access_token = refresh_access_token()
    except Exception:
        print("TOKEN_REFRESH_FAIL")
        return 1

    try:
        recipient = fetch_own_email_address(access_token)
        raw_mime = build_raw_mime(recipient, subject, body)
        result = send_via_gmail(access_token, raw_mime)
    except SelfSendOnly:
        print("SEND_REFUSED_NOT_SELF")
        return 1
    except Exception:
        print("SEND_FAIL")
        return 1

    print(f"SENT id={result.get('id', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
