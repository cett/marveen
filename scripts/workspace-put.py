#!/usr/bin/env python3
"""workspace-put: upload a work document (plan, brief, report, notes, draft) into the
workspace_docs table and, only after a verified read-back, optionally delete the staging file.

A work document lives ONLY in the database, never in a loose file. The usual flow:
write the body with the editor tool into the session scratchpad, then

    python3 scripts/workspace-put.py --file <scratchpad file> --doc-key plan/<card> \
        --type plan --delete-source

Behaviour:
  1. POST /api/v1/workspace through scripts/agent-api.sh (upsert by agent + doc_key). The
     token never touches a command line: the wrapper owns authentication.
  2. GET /api/v1/workspace/<id> and compare the stored content with what was sent
     (character count, byte count and exact text). Any mismatch is a failure.
  3. Only after step 2 succeeded, and only with --delete-source, remove the source file with
     os.remove (the agents' shell rm is blocked by a gate). The deletion is deliberately narrow:
     the source must be a regular, non-symlink file whose real path is inside the session
     scratchpad directory and NOT inside any git work tree. The eligibility is checked BEFORE the
     upload, so a refused deletion never leaves a half-done state. One log line says what went.

The scratchpad is recognised by the path convention <tmp>/claude-<uid>/<project>/<session>/scratchpad
(tmp is /tmp, /private/tmp or the per-user /private/var/folders/../T); there is no environment
variable that names it. Anywhere else, pass --scratchpad-root <dir> (its last path component must be
"scratchpad"); without either, --delete-source is refused.

doc_key prefixes: plan, brief, report, notes, draft (each implies a type; draft is notes) or
series-<slug> (lowercase slug; implies no type, --type chooses one, default notes), then 1-3 more
segments, 2-4 segments in all.

Exit codes: 0 success, 1 runtime failure (API, read-back mismatch, source changed), 2 usage or
validation error. Pure standard library, Python 3.9 compatible.

Test seam: WORKSPACE_PUT_API_CMD names an executable used in place of "bash agent-api.sh".
"""
import argparse
import json
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WRAPPER = os.path.join(SCRIPT_DIR, "agent-api.sh")

TYPES = ("plan", "brief", "report", "notes")
CONTENT_TYPES = ("text", "code")
SIZE_LIMITS = {"text": 2 * 1024 * 1024, "code": 4 * 1024 * 1024}  # mirrors WORKSPACE_DOC_SIZE_LIMITS
# doc_key prefix -> the workspace_docs type it implies (draft/ is a flavour of notes)
PREFIX_TYPE = {"plan": "plan", "brief": "brief", "report": "report", "notes": "notes", "draft": "notes"}
# A series document lives under series-<slug>/...; the slug names the series (for example a multi-part
# article). The prefix implies no fixed type, so --type picks one and defaults to SERIES_DEFAULT_TYPE.
# The slug is stricter than a plain segment: lowercase letters, digits, '_' and '-', no dot.
SERIES_PREFIX = "series-"
# \Z, not $: "$" also matches before a trailing newline, which would let a control character through.
SERIES_HEAD_RE = re.compile(r"^series-[a-z0-9][a-z0-9_-]*\Z")
SERIES_DEFAULT_TYPE = "notes"
SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\Z")
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SCRATCH_RE = re.compile(
    r"^(?:/private)?/(?:tmp|var/folders/[^/]+/[^/]+/T)/claude-\d+/[^/]+/[^/]+/scratchpad(?:/|$)"
)
MAX_KEY_LEN = 200
MAX_TITLE_LEN = 200


class Fail(Exception):
    def __init__(self, message, code=1):
        Exception.__init__(self, message)
        self.code = code


def validate_doc_key(key):
    """Return the validated doc_key or raise Fail(2)."""
    if not key or len(key) > MAX_KEY_LEN:
        raise Fail("doc_key must be 1-%d characters" % MAX_KEY_LEN, 2)
    parts = key.split("/")
    if parts[0].startswith(SERIES_PREFIX):
        if not SERIES_HEAD_RE.match(parts[0]):
            raise Fail(
                "doc_key series prefix %r: use %s<slug> with a lowercase slug (letters, digits, '_', '-')"
                % (parts[0], SERIES_PREFIX),
                2,
            )
    elif parts[0] not in PREFIX_TYPE:
        raise Fail(
            "doc_key must start with one of: %s or %s<slug> (got %r)"
            % (", ".join(sorted(PREFIX_TYPE)), SERIES_PREFIX, parts[0]),
            2,
        )
    if len(parts) < 2 or len(parts) > 4:
        raise Fail("doc_key needs 2-4 segments, e.g. plan/<card> or notes/<agent>/<date>-<topic>", 2)
    for seg in parts:
        if not SEGMENT_RE.match(seg) or seg in (".", ".."):
            raise Fail("doc_key segment %r: use letters, digits, '.', '_', '-' only" % seg, 2)
    return key


def resolve_agent(explicit, env):
    """--agent, else MARVEEN_AGENT_ID, else BOT_NAME, else the agent named by the launch config dir."""
    candidates = [explicit, env.get("MARVEEN_AGENT_ID"), env.get("BOT_NAME")]
    for cand in candidates:
        if cand and cand.strip():
            agent = cand.strip().lower()
            if not AGENT_RE.match(agent):
                raise Fail("agent id %r is not valid (lowercase letters, digits, '_', '-')" % agent, 2)
            return agent
    cfg = env.get("CLAUDE_CONFIG_DIR") or ""
    m = re.search(r"/agents/([^/]+)/\.claude-config(?:/|$)", cfg)
    if m and AGENT_RE.match(m.group(1)):
        return m.group(1)
    if re.search(r"/\.channels-config(?:/|$)", cfg) and env.get("MAIN_AGENT_ID", "").strip():
        main = env["MAIN_AGENT_ID"].strip().lower()
        if AGENT_RE.match(main):
            return main
    raise Fail("cannot tell which agent this is; pass --agent <id>", 2)


def derive_title(text, doc_key):
    for line in text.splitlines()[:30]:
        m = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if m:
            return m.group(1).strip()[:MAX_TITLE_LEN]
    return doc_key[:MAX_TITLE_LEN]


def inside_git_worktree(real_path):
    """True when any ancestor directory of real_path has a .git entry (dir or worktree file)."""
    cur = os.path.dirname(real_path)
    while True:
        if os.path.exists(os.path.join(cur, ".git")):
            return True
        parent = os.path.dirname(cur)
        if parent == cur:
            return False
        cur = parent


def check_deletable(source, scratchpad_root):
    """Return the real path of source when deleting it is allowed, else raise Fail(2)."""
    if os.path.islink(source):
        raise Fail("--delete-source refused: %s is a symlink" % source, 2)
    real = os.path.realpath(source)
    if not os.path.isfile(real):
        raise Fail("--delete-source refused: %s is not a regular file" % source, 2)
    if inside_git_worktree(real):
        raise Fail("--delete-source refused: %s is inside a git work tree" % real, 2)
    in_scratch = bool(SCRATCH_RE.match(real))
    if not in_scratch and scratchpad_root:
        root = os.path.realpath(scratchpad_root)
        if os.path.basename(root) != "scratchpad":
            raise Fail("--scratchpad-root must be a directory named 'scratchpad' (got %s)" % root, 2)
        if inside_git_worktree(os.path.join(root, "x")):
            raise Fail("--scratchpad-root %s is inside a git work tree" % root, 2)
        in_scratch = real == root or real.startswith(root + os.sep)
    if not in_scratch:
        raise Fail(
            "--delete-source refused: %s is not inside the session scratchpad "
            "(use --scratchpad-root <dir> if the scratchpad lives elsewhere)" % real,
            2,
        )
    return real


def api_call(env, agent, method, path, body_bytes=None):
    """Call the dashboard through the wrapper. Returns the parsed JSON body."""
    override = env.get("WORKSPACE_PUT_API_CMD")
    cmd = [override] if override else ["bash", DEFAULT_WRAPPER]
    cmd += ["--agent", agent, "--max-time", "60", method, path]
    if body_bytes is not None:
        cmd.append("-")
    try:
        proc = subprocess.run(
            cmd,
            input=body_bytes if body_bytes is not None else b"",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=90,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Fail("API wrapper could not run: %s" % exc)
    out = proc.stdout.decode("utf-8", "replace").strip()
    err = proc.stderr.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        raise Fail("%s %s failed (exit %d): %s" % (method, path, proc.returncode, (err + " " + out).strip()[:500]))
    try:
        data = json.loads(out)
    except ValueError:
        raise Fail("%s %s returned a non-JSON body: %s" % (method, path, out[:200]))
    if not isinstance(data, dict):
        raise Fail("%s %s returned an unexpected body" % (method, path))
    return data


def build_parser():
    p = argparse.ArgumentParser(
        prog="workspace-put",
        description="Upload a work document to workspace_docs, verify it, optionally delete the staging file.",
    )
    p.add_argument("--file", required=True, help="source file path, or - for stdin")
    p.add_argument("--doc-key", required=True, help="plan/<card> | brief/<card> | report/<card> | "
                   "notes/<agent>/<date>-<topic> | draft/<series>/<part>-vN | series-<slug>/<part>")
    p.add_argument("--type", choices=TYPES, help="document type (default: implied by the doc_key prefix; "
                   "a series-<slug> prefix implies none, so it defaults to %s and any type may be given)"
                   % SERIES_DEFAULT_TYPE)
    p.add_argument("--task-ref", help="kanban card reference stored with the document")
    p.add_argument("--title", help="document title (default: first markdown heading, else the doc_key)")
    p.add_argument("--agent", help="author agent id (default: MARVEEN_AGENT_ID, BOT_NAME, launch config)")
    p.add_argument("--content-type", choices=CONTENT_TYPES, default="text",
                   help="text (2 MB limit) or code (4 MB limit); binary files are not workspace-put material")
    p.add_argument("--delete-source", action="store_true",
                   help="after a verified upload delete the source (scratchpad files only, never in a git work tree)")
    p.add_argument("--scratchpad-root", help="scratchpad directory, when it does not follow the claude-<uid> convention")
    return p


def run(args, env):
    key = validate_doc_key(args.doc_key)
    prefix = key.split("/")[0]
    implied = PREFIX_TYPE.get(prefix)  # None for series-<slug>: no fixed type
    doc_type = args.type or implied or SERIES_DEFAULT_TYPE
    if implied is not None and doc_type != implied:
        raise Fail("--type %s does not match the doc_key prefix %r (expects %s)" % (doc_type, prefix, implied), 2)
    if args.file == "-" and args.delete_source:
        raise Fail("--delete-source needs a real file, not stdin", 2)
    agent = resolve_agent(args.agent, env)

    real_source = None
    if args.delete_source:
        real_source = check_deletable(args.file, args.scratchpad_root)

    if args.file == "-":
        raw = sys.stdin.buffer.read()
    else:
        try:
            with open(args.file, "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            raise Fail("cannot read %s: %s" % (args.file, exc), 2)
    if not raw.strip():
        raise Fail("the document is empty", 2)
    if b"\x00" in raw:
        raise Fail("the file contains NUL bytes: binary files are exempt from the rule, keep them as files", 2)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Fail("the file is not valid UTF-8: binary files are exempt from the rule, keep them as files", 2)
    if len(raw) > SIZE_LIMITS[args.content_type]:
        raise Fail("the document is %d bytes, the %s limit is %d" % (len(raw), args.content_type, SIZE_LIMITS[args.content_type]), 2)

    title = (args.title or derive_title(text, key)).strip()[:MAX_TITLE_LEN] or key
    payload = {
        "agent_id": agent,
        "doc_key": key,
        "title": title,
        "content": text,
        "content_type": args.content_type,
        "type": doc_type,
    }
    if args.task_ref:
        payload["task_ref"] = args.task_ref
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    saved = api_call(env, agent, "POST", "/api/v1/workspace", body)
    doc_id = saved.get("id")
    if not isinstance(doc_id, str) or not ID_RE.match(doc_id):
        raise Fail("the upload response carried no usable document id")

    stored = api_call(env, agent, "GET", "/api/v1/workspace/" + doc_id)
    stored_text = stored.get("content")
    if not isinstance(stored_text, str):
        raise Fail("read-back of %s returned no text content; source kept" % doc_id)
    if stored.get("doc_key") != key or stored.get("agent_id") != agent:
        raise Fail("read-back of %s names a different doc_key or agent; source kept" % doc_id)
    sent_bytes = len(raw)
    if len(stored_text) != len(text) or stored_text != text or stored.get("size_bytes") != sent_bytes:
        raise Fail(
            "read-back mismatch for %s: sent %d chars / %d bytes, stored %d chars / %s bytes; source kept"
            % (key, len(text), sent_bytes, len(stored_text), stored.get("size_bytes"))
        )
    print("workspace-put: ok doc_key=%s id=%s chars=%d bytes=%d" % (key, doc_id, len(text), sent_bytes))

    if real_source:
        # The file must still be exactly what was uploaded; anything else was edited meanwhile.
        try:
            with open(real_source, "rb") as fh:
                again = fh.read()
        except OSError as exc:
            raise Fail("uploaded, but cannot re-read the source for deletion: %s" % exc)
        if again != raw:
            raise Fail("uploaded, but the source changed during the upload; not deleted: %s" % real_source)
        try:
            os.remove(real_source)
        except OSError as exc:
            raise Fail("uploaded, but deleting the source failed: %s" % exc)
        print("workspace-put: deleted source %s" % real_source)
    return 0


def main(argv=None, env=None):
    env = dict(os.environ if env is None else env)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    try:
        return run(args, env)
    except Fail as exc:
        sys.stderr.write("workspace-put: %s\n" % exc)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
