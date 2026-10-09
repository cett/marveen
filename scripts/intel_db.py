#!/usr/bin/env python3
"""
intel_db.py -- Proactive Intelligence registry: Python API + CLI.

A small store that lets an hourly "collector" scheduled task persist findings
and a daily "brief" scheduled task read them back, so the brief is built from
accumulated structured facts instead of whatever happens to be in the session
context. Ships with two seed task templates:
seed-scheduled-tasks/intel-collector and seed-scheduled-tasks/intel-daily-brief.

This script is a thin client of the dashboard's /api/intel/* routes: the
dashboard owns the data (four tables, see src/intel-store.ts) and this file
only turns CLI arguments into requests. The dashboard must therefore be
running; it is created on first use, so there is no schema step to run.

Tables (kept by the dashboard):
  known_facts_registry  facts with domain, source tier, status and priority
  watchlist             directions worth tracking that are not yet facts
  decision_log          recommendations with reasoning and falsifiability
  active_focus          currently prioritized topics with expiry

Connection: MARVEEN_DASHBOARD_BASE, else http://localhost:<WEB_PORT> (WEB_PORT
from the environment, then from the install's .env, default 3420); the bearer
token is read from <store>/.dashboard-token (MARVEEN_STORE_DIR overrides the
store directory). Where the registry is kept is the dashboard's business
(see src/intel-store.ts).

CLI (see --help of each subcommand):
  intel_db.py init                          make sure the registry exists (idempotent)
  intel_db.py add-fact --title .. --domain .. --source .. --tier 1 --content ..
  intel_db.py add-watch --title .. --domain .. --direction ..
  intel_db.py add-focus --topic .. [--mode deep|transient] [--days N]
  intel_db.py log-decision --recommendation .. --reasoning .. ...
  intel_db.py dump [--days N]               JSON of everything the brief reads
  intel_db.py                               health counters (row counts)

Usage from Python:
  import sys; sys.path.insert(0, "scripts")
  from intel_db import get_active_registry, get_watchlist, get_active_focus

Exit codes: 0 on success (including a duplicate fact, which is a repeat
sighting, not an error); 1 when the dashboard cannot be reached or refuses the
request; 2 for bad CLI arguments (argparse).

See docs/intel-registry.md for how the collector and the brief fit together.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import agent_token  # noqa: E402
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
STORE_DIR = Path(os.environ.get("MARVEEN_STORE_DIR") or REPO_ROOT / "store")
TOKEN_FILE = STORE_DIR / ".dashboard-token"
REQUEST_TIMEOUT = 20


class IntelError(Exception):
    """The dashboard could not be reached, or refused the request."""


class DuplicateFactError(Exception):
    """The same content is already stored under another id (a repeat sighting)."""

    def __init__(self, fact_id: str):
        super().__init__(fact_id)
        self.fact_id = fact_id


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(REPO_ROOT / ".env", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        except OSError:
            pass
    return port or "3420"


def _base_url() -> str:
    return (os.environ.get("MARVEEN_DASHBOARD_BASE") or f"http://localhost:{_web_port()}").rstrip("/")


def _request(method: str, path: str, payload: dict | None = None) -> dict:
    # /api/intel is admin:all: the main agent's own token, any other caller the shared one (until T4).
    auth = agent_token.resolve(store_dir=str(STORE_DIR), kind=agent_token.KIND_ADMIN, shared_file=str(TOKEN_FILE))
    if not auth.token:
        raise IntelError(f"cannot read the dashboard token ({TOKEN_FILE}): no token")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        _base_url() + path,
        data=data,
        method=method,
        headers=auth.headers({"Content-Type": "application/json"}),
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            hint = detail.get("hint") or detail.get("error") or ""
        except (ValueError, OSError):
            hint = ""
        raise IntelError(f"dashboard answered {exc.code} for {method} {path}: {hint}".rstrip(": ")) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise IntelError(f"dashboard unreachable ({_base_url()}): {exc}") from exc


def init_db() -> str:
    """Make sure the registry exists (idempotent). Returns where the dashboard keeps it."""
    return _request("POST", "/api/intel/init").get("db_path", "")


def dump_active(days: int = 14) -> dict:
    """Everything the daily brief reads, as one JSON-serializable dict."""
    data = _request("GET", f"/api/intel/dump?days={int(days)}")
    data.pop("db_path", None)
    return data


def get_active_registry(days: int = 14) -> list[dict]:
    """Return known_facts_registry rows updated within `days` days, excluding closed."""
    return dump_active(days)["registry"]


def get_watchlist() -> list[dict]:
    """Return all watchlist entries ordered by creation date desc."""
    return dump_active()["watchlist"]


def get_active_focus() -> list[dict]:
    """Return active_focus rows with status='active' and not yet expired."""
    return dump_active()["active_focus"]


def upsert_registry_fact(
    id: str | None,
    title: str,
    domain: str,
    source: str,
    source_tier: int,
    content: str,
    status: str = "new",
    priority_score: float = 0.5,
) -> str:
    """Insert or update a fact in known_facts_registry. Returns the id.

    Pass None as the id and the dashboard derives <domain>-<YYYYMMDD>-<hash8> from the
    content, so a repeated sighting on the same day updates the same row.
    Raises DuplicateFactError when the same content already lives under
    another id.
    """
    payload: dict = {
        "title": title, "domain": domain, "source": source, "source_tier": source_tier,
        "content": content, "status": status, "priority_score": priority_score,
    }
    if id:
        payload["id"] = id
    result = _request("POST", "/api/intel/facts", payload)
    if result.get("duplicate"):
        raise DuplicateFactError(result.get("id", id or ""))
    return result["id"]


def add_watchlist(title: str, domain: str, direction: str, notes: str = "") -> str:
    """Add a new entry to the watchlist. Returns the generated id."""
    return _request(
        "POST", "/api/intel/watchlist",
        {"title": title, "domain": domain, "direction": direction, "notes": notes},
    )["id"]


def add_focus(topic: str, mode: str = "transient", days: int | None = None, notes: str = "") -> str:
    """Add an active_focus topic; expires after `days` days if given. Returns the id."""
    payload: dict = {"topic": topic, "mode": mode, "notes": notes}
    if days:
        payload["days"] = days
    return _request("POST", "/api/intel/focus", payload)["id"]


def log_decision(
    recommendation: str,
    reasoning: str,
    assumption: str = "",
    evidence: str = "",
    what_would_falsify: str = "",
    owner_reaction: str = "",
    outcome: str = "",
) -> str:
    """Append a record to decision_log. Returns the generated id."""
    return _request(
        "POST", "/api/intel/decisions",
        {
            "recommendation": recommendation, "reasoning": reasoning, "assumption": assumption,
            "evidence": evidence, "what_would_falsify": what_would_falsify,
            "owner_reaction": owner_reaction, "outcome": outcome,
        },
    )["id"]


def _cli() -> int:
    """argparse CLI so agent prompts can write the registry without inline Python."""
    import argparse

    # The daily-brief task calls `intel_db.py --dump`; accept the flag form as
    # an alias for the subcommand so that contract keeps working.
    argv = sys.argv[1:]
    if argv and argv[0] == "--dump":
        argv = ["dump"] + argv[1:]

    parser = argparse.ArgumentParser(description="Proactive Intelligence registry CLI")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("init", help="Make sure the registry exists (idempotent)")

    p_fact = sub.add_parser("add-fact", help="Upsert a fact into known_facts_registry")
    p_fact.add_argument("--id", help="Fact id; omitted -> deterministic <domain>-<YYYYMMDD>-<hash8>")
    p_fact.add_argument("--title", required=True)
    p_fact.add_argument("--domain", required=True, help="free-form topic slug, e.g. market / finance / legal")
    p_fact.add_argument("--source", required=True, help="URL or source name")
    p_fact.add_argument("--tier", required=True, type=int, choices=(1, 2, 3), help="source tier (1=primary)")
    p_fact.add_argument("--content", required=True)
    p_fact.add_argument("--status", default="new", choices=("new", "evolving", "stable", "closed"))
    p_fact.add_argument("--priority", default=0.5, type=float, help="priority_score 0..1")

    p_watch = sub.add_parser("add-watch", help="Add a watchlist entry")
    p_watch.add_argument("--title", required=True)
    p_watch.add_argument("--domain", required=True)
    p_watch.add_argument("--direction", required=True, help="what movement/direction is being tracked")
    p_watch.add_argument("--notes", default="")

    p_focus = sub.add_parser("add-focus", help="Add an active_focus topic")
    p_focus.add_argument("--topic", required=True)
    p_focus.add_argument("--mode", default="transient", choices=("deep", "transient"))
    p_focus.add_argument("--days", type=int, help="expire after N days (omit = no expiry)")
    p_focus.add_argument("--notes", default="")

    p_dec = sub.add_parser("log-decision", help="Append a decision_log record")
    p_dec.add_argument("--recommendation", required=True)
    p_dec.add_argument("--reasoning", required=True)
    p_dec.add_argument("--assumption", default="")
    p_dec.add_argument("--evidence", default="")
    p_dec.add_argument("--what-would-falsify", default="")
    p_dec.add_argument("--owner-reaction", default="")
    p_dec.add_argument("--outcome", default="")

    p_dump = sub.add_parser("dump", help="Print registry + watchlist + active_focus as JSON")
    p_dump.add_argument("--days", default=14, type=int)

    args = parser.parse_args(argv)

    try:
        if args.cmd == "init":
            print(f"OK: registry ready at {init_db()}")
            return 0

        if args.cmd == "add-fact":
            try:
                fact_id = upsert_registry_fact(
                    id=args.id, title=args.title, domain=args.domain, source=args.source,
                    source_tier=args.tier, content=args.content, status=args.status,
                    priority_score=max(0.0, min(1.0, args.priority)),
                )
            except DuplicateFactError as dup:
                # Same content under a DIFFERENT id means the fact is already
                # known -- a repeat sighting, not an error.
                print(f"DUPLICATE content already in registry (id={dup.fact_id} skipped)")
                return 0
            print(fact_id)
            return 0

        if args.cmd == "add-watch":
            print(add_watchlist(args.title, args.domain, args.direction, args.notes))
            return 0

        if args.cmd == "add-focus":
            print(add_focus(args.topic, args.mode, args.days, args.notes))
            return 0

        if args.cmd == "log-decision":
            print(log_decision(
                args.recommendation, args.reasoning, args.assumption, args.evidence,
                args.what_would_falsify, args.owner_reaction, args.outcome,
            ))
            return 0

        if args.cmd == "dump":
            print(json.dumps(dump_active(args.days), ensure_ascii=False, indent=2))
            return 0

        # No subcommand: health counters (also creates the registry on first run).
        data = _request("GET", "/api/intel/dump?days=14")
        print(f"DB: {data.get('db_path', '')}")
        print(f"Active registry (14d): {len(data['registry'])} rows")
        print(f"Watchlist: {len(data['watchlist'])} rows")
        print(f"Active focus: {len(data['active_focus'])} rows")
        print("OK")
        return 0
    except IntelError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
