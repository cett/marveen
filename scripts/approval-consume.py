#!/usr/bin/env python3
"""approval-consume: use up an approved email request through the dashboard API.

An approved email_send request is bound to one exact mail (its content hash) and can be used
once. This script is the command-line form of the two calls that do it:

    approval-consume.py --hash <sha256>                       claim by hash (POST /api/v1/approvals/claim)
    approval-consume.py --hash <sha256> --id <approval id>    consume that approval (POST /api/v1/approvals/<id>/consume)

--hash is always required: the caller names the mail it is about to send, and the server uses the
request only if that is the mail the owner approved. The id form is for a caller that was told which
approval it waits for; the hash form finds the newest approved, unused request for the hash.
--category (claim only, default email_send), --ref (a label for the audit trail, for example the
message id of the send) and --consumer (a short name of the sender) are free-form labels.

Authentication is the calling agent's own token, resolved by scripts/hooks/agent_token.py (the agent
is the working directory's, else MARVEEN_AGENT_ID, else --agent). The token goes into a request header
only: it is never a command-line argument and never printed. The shared dashboard token is not read:
it names no agent, and the server refuses to use up an approval for a caller without one.

Exit codes:
    0  the server said 200: the approval is used up (or this is the replay of the same use)
    3  the server refused: 403 or 409 (the reason is printed on stderr)
    4  the server does not know the id: 404
    2  anything else: network error, 400, 5xx, no token, bad arguments

On success one JSON line goes to stdout: {"ok", "replayed", "window_s", "approval"}.
Pure standard library. Test seams: DASHBOARD_BASE_URL (base url), MARVEEN_AGENT_TOKEN_FILE (token file).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import agent_token  # noqa: E402
import dashboard_api  # noqa: E402

EXIT_OK = 0
EXIT_OTHER = 2
EXIT_REFUSED = 3
EXIT_UNKNOWN_ID = 4

HASH_RE = re.compile(r"^[0-9a-f]{64}\Z")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")
LABEL_RE = re.compile(r"^[\x20-\x7e]*\Z")
MAX_REF = 200
MAX_CONSUMER = 64
TIMEOUT_S = 10


class Usage(Exception):
    pass


def build_request(args):
    """Return (path, body) for the parsed arguments, or raise Usage."""
    if not HASH_RE.match(args.hash or ""):
        raise Usage("--hash must be 64 lowercase hex characters (the sha256 of the mail)")
    body = {"content_hash": args.hash}
    for field, value, limit in (("ref", args.ref, MAX_REF), ("consumer", args.consumer, MAX_CONSUMER)):
        if value is None:
            continue
        if len(value) > limit or not LABEL_RE.match(value):
            raise Usage("--%s must be printable ASCII, at most %d characters" % (field, limit))
        if value != "":
            body[field] = value
    if args.id is not None:
        if not ID_RE.match(args.id):
            raise Usage("--id must be 1-64 characters of letters, digits, '_' or '-'")
        if args.category is not None:
            raise Usage("--category belongs to the claim form; drop it when --id is given")
        return "/api/v1/approvals/%s/consume" % args.id, body
    category = (args.category if args.category is not None else "email_send").strip()
    if not category or len(category) > 64 or not LABEL_RE.match(category):
        raise Usage("--category must be a short printable ASCII name")
    body["category"] = category
    return "/api/v1/approvals/claim", body


def call(path, body, agent=None):
    """POST the body. Returns (status, parsed JSON or None). Raises OSError on network trouble
    and Usage when there is no token to send."""
    auth = agent_token.resolve(agent_id=agent)
    if not auth.token:
        raise Usage("no agent token found for this caller (agents/<id>/.agent-token); run it as the agent that asked for the approval")
    req = urllib.request.Request(
        dashboard_api.base_url() + path,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers=auth.headers({"Content-Type": "application/json"}),
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read()
        except Exception:
            raw = b""
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else None
    except Exception:
        parsed = None
    return status, parsed


def describe_refusal(status, payload):
    """One stderr line: the status and the server's reason, nothing else from the response."""
    reason = ""
    if isinstance(payload, dict):
        reason = payload.get("reason") or payload.get("error") or ""
        if not isinstance(reason, str) or not LABEL_RE.match(reason) or len(reason) > 80:
            reason = ""
        pending = payload.get("approval_id")
        if reason == "pending" and isinstance(pending, str) and ID_RE.match(pending):
            reason += " (open request %s)" % pending
    return "approval-consume: refused, HTTP %d%s" % (status, (", " + reason) if reason else "")


def exit_for(status, payload):
    """Map an HTTP answer to (exit code, stdout line or None, stderr line or None)."""
    if status == 200 and isinstance(payload, dict) and payload.get("ok") is True:
        out = {k: payload.get(k) for k in ("ok", "replayed", "window_s", "approval")}
        return EXIT_OK, json.dumps(out, separators=(",", ":")), None
    if status in (403, 409):
        return EXIT_REFUSED, None, describe_refusal(status, payload)
    if status == 404:
        return EXIT_UNKNOWN_ID, None, "approval-consume: unknown approval, HTTP 404"
    return EXIT_OTHER, None, "approval-consume: unexpected answer, HTTP %d" % status


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="approval-consume.py",
        description="Use up an approved email request (by hash, or by id and hash).",
    )
    p.add_argument("--hash", required=True, help="sha256 (64 lowercase hex) of the mail about to be sent")
    p.add_argument("--id", default=None, help="approval id: consume that approval instead of claiming by hash")
    p.add_argument("--category", default=None, help="claim only; default email_send")
    p.add_argument("--ref", default=None, help="audit label, for example the id of the send")
    p.add_argument("--consumer", default=None, help="short name of the sender")
    p.add_argument("--agent", default=None, help="agent id when it cannot be told from the working directory or MARVEEN_AGENT_ID")
    return p.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as e:
        # argparse exits 2 on a usage error and 0 on --help; both already fit the contract.
        return e.code if isinstance(e.code, int) else EXIT_OTHER
    try:
        path, body = build_request(args)
        status, payload = call(path, body, agent=args.agent)
    except Usage as e:
        sys.stderr.write("approval-consume: %s\n" % e)
        return EXIT_OTHER
    except (OSError, ValueError) as e:
        # The class only: an exception text must never be able to carry a header value.
        sys.stderr.write("approval-consume: the dashboard could not be reached (%s)\n" % type(e).__name__)
        return EXIT_OTHER
    code, out, err = exit_for(status, payload)
    if out:
        sys.stdout.write(out + "\n")
    if err:
        sys.stderr.write(err + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
