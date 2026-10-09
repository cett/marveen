#!/usr/bin/env python3
"""Send the day's RSS digest email via the Gmail REST API.

The gmail MCP times out too often for this scheduled step (see the
reggeli-napindito SKILL.md), so this sends directly against the Gmail REST
API instead: a workspace_docs `digest/<today>` doc is fetched from the
dashboard, its leading `<!-- UNTRUSTED-RSS ... -->` banner line is stripped,
and the result is emailed to the Gmail account the OAuth token belongs to
(read from that account's own profile at send time -- never hardcoded, so no
personal address lives in this file).

The refresh_token / access_token are never printed; only one of the fixed
outcome strings below goes to stdout.

Usage:
    python3 send-digest-email.py [--dry-run]

Exit codes: 0 for SENT and SKIP_NO_DIGEST, non-zero for a real failure.
"""
import base64
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
DASHBOARD_TOKEN_FILE = os.path.join(REPO_ROOT, "store", ".dashboard-token")


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
    # Scheduled for the coordinator: its own token, the shared one only if that file is missing.
    auth = agent_token.resolve(store_dir=os.path.dirname(DASHBOARD_TOKEN_FILE), kind=agent_token.KIND_MAIN, shared_file=DASHBOARD_TOKEN_FILE)
    if not auth.token:
        raise OSError("no dashboard token for the coordinator (own token or %s)" % DASHBOARD_TOKEN_FILE)
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


def send_via_gmail(access_token, raw_mime):
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
    except Exception:
        print("SEND_FAIL")
        return 1

    print(f"SENT id={result.get('id', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
