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
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import agent_token  # noqa: E402
from datetime import datetime
from email.header import Header
from email.mime.text import MIMEText

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


def send_via_gmail(access_token, raw_mime):
    """The ONLY place of this module that calls the Gmail send route. The own address is read from the account's
    profile HERE (not taken from the caller), so a caller cannot pass in the recipient it wants to be treated as own."""
    assert_self_addressed(raw_mime, fetch_own_email_address(access_token))
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
