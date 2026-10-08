#!/usr/bin/env python3
"""Test double for the dashboard's /api/conversation-ledger endpoints.

Serves the same three routes as src/web/routes/conversation-ledger.ts over a
SQLite file, so the shell tests can keep asserting on the rows themselves.
One server handles many databases: the request path is prefixed with
/db/<percent-encoded database path>, and the hooks reach it through
LEDGER_BASE_URL. The Bearer token must be "test-token" (the test writes it to
<store dir>/.dashboard-token), which proves the hooks send their credentials.

Usage: ledger-stub-server.py <port-file>
The chosen port is written to <port-file> once the server is listening.
"""
import json
import re
import sqlite3
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text TEXT,
  ts TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, chat_id, direction, message_id)
)
"""

PREFIX = re.compile(r"^/db/([^/]+)(/.*)$")


def connect(path):
    con = sqlite3.connect(path, timeout=10)
    con.execute(SCHEMA)
    return con


def insert(con, e):
    created_at = e.get("created_at") or int(time.time())
    ts = e.get("ts")
    if ts is None and e["direction"] == "out":
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created_at))
    cur = con.execute(
        "INSERT OR IGNORE INTO conversation_log"
        " (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (e["agent_id"], e["chat_id"], e["direction"], e.get("message_id"), e.get("text"), ts, created_at),
    )
    return cur.rowcount > 0


def recent(con, agent_id, limit):
    rows = con.execute(
        "SELECT direction, chat_id, text, ts FROM conversation_log WHERE agent_id=?"
        " ORDER BY created_at DESC, id DESC LIMIT ?",
        (agent_id, limit),
    ).fetchall()
    return [dict(zip(("direction", "chat_id", "text", "ts"), r)) for r in reversed(rows)]


def open_question(con, agent_id):
    row = con.execute(
        "SELECT chat_id, message_id, text, ts, created_at, id FROM conversation_log"
        " WHERE agent_id=? AND direction='in' ORDER BY created_at DESC, id DESC LIMIT 1",
        (agent_id,),
    ).fetchone()
    if not row:
        return None
    later = con.execute(
        "SELECT 1 FROM conversation_log WHERE agent_id=? AND direction='out'"
        " AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1",
        (agent_id, row[4], row[4], row[5]),
    ).fetchone()
    if later:
        return None
    return dict(zip(("chat_id", "message_id", "text", "ts", "created_at"), row[:5]))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        if self.headers.get("Authorization") != "Bearer test-token":
            self._send(401, {"error": "unauthorized"})
            return None
        parsed = urllib.parse.urlsplit(self.path)
        m = PREFIX.match(parsed.path)
        if not m:
            self._send(404, {"error": "not_found"})
            return None
        return urllib.parse.unquote(m.group(1)), m.group(2), urllib.parse.parse_qs(parsed.query)

    def do_POST(self):
        routed = self._route()
        if routed is None:
            return
        db, path, _ = routed
        if path != "/api/conversation-ledger":
            return self._send(404, {"error": "not_found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or "null")
        entries = body["entries"] if isinstance(body, dict) and "entries" in body else [body]
        con = connect(db)
        try:
            inserted = sum(1 for e in entries if insert(con, e))
            con.commit()
        finally:
            con.close()
        self._send(200, {"ok": True, "received": len(entries), "inserted": inserted})

    def do_GET(self):
        routed = self._route()
        if routed is None:
            return
        db, path, query = routed
        m = re.match(r"^/api/conversation-ledger/([^/]+)/(recent|open-question)$", path)
        if not m:
            return self._send(404, {"error": "not_found"})
        agent_id = urllib.parse.unquote(m.group(1))
        con = connect(db)
        try:
            if m.group(2) == "recent":
                limit = int(query.get("limit", ["20"])[0])
                self._send(200, {"turns": recent(con, agent_id, limit)})
            else:
                self._send(200, {"open_question": open_question(con, agent_id)})
        finally:
            con.close()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    with open(sys.argv[1], "w") as f:
        f.write(str(server.server_address[1]))
    server.serve_forever()
