#!/usr/bin/env python3
"""SQLite-dialect ratchet for the PostgreSQL migration preparation.

Counts SQLite-specific SQL constructs in production TypeScript (src/, tests and
src/migrations/ excluded; comments stripped) and fails when any count is HIGHER
than the committed baseline (scripts/sqlite-dialect-baseline.json). Counts may
only go down: lower the baseline with --update after a rewrite lands.

The point is to stop the PG port from getting bigger while the preparation work
(portable rewrites, moving raw SQL into src/db/) is in flight. It does not
judge whether a use is wrong, only that the total does not grow.

Usage:
    python3 sqlite-dialect-ratchet.py            # check (exit 1 on growth)
    python3 sqlite-dialect-ratchet.py --report   # per-token, per-file counts
    python3 sqlite-dialect-ratchet.py --update   # rewrite baseline (lower only)
    python3 sqlite-dialect-ratchet.py --update --allow-increase

Exit codes: 0 ok, 1 a count grew, 2 usage / IO error.
"""
import collections
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SRC_DIR = os.path.join(REPO_ROOT, "src")
BASELINE_PATH = os.path.join(SCRIPT_DIR, "sqlite-dialect-baseline.json")

# name -> (regex, flags). Only constructs that are unambiguous in TS source.
TOKENS = {
    "unixepoch()": (r"\bunixepoch\s*\(", re.I),
    "strftime()": (r"\bstrftime\s*\(", re.I),
    "datetime()": (r"\bdatetime\s*\(\s*['\"?]", re.I),
    "INSERT OR IGNORE": (r"\bINSERT\s+OR\s+IGNORE\b", re.I),
    "INSERT OR REPLACE": (r"\bINSERT\s+OR\s+REPLACE\b|\bREPLACE\s+INTO\b", re.I),
    "AUTOINCREMENT": (r"\bAUTOINCREMENT\b", re.I),
    "rowid": (r"\browid\b", 0),
    "lastInsertRowid": (r"\blastInsertRowid\b", 0),
    "PRAGMA": (r"\bPRAGMA\b|\.pragma\s*\(", re.I),
    "GLOB": (r"\bGLOB\s+['\"?]", 0),
    "instr()": (r"\binstr\s*\(", re.I),
    "GROUP_CONCAT": (r"\bGROUP_CONCAT\s*\(", re.I),
    "COLLATE NOCASE": (r"\bCOLLATE\s+NOCASE\b", re.I),
    "randomblob()/hex()": (r"\brandomblob\s*\(|\bhex\s*\(", re.I),
    "IFNULL()": (r"\bIFNULL\s*\(", re.I),
    "json_extract/json_each": (r"\bjson_(?:extract|each|set|object|group_array)\s*\(", re.I),
    "FTS5 MATCH": (r"\bMATCH\s+[?@:]", re.I),
    "vec0/sqlite-vec": (r"\bvec0\b|\bvec_distance|sqlite-vec|sqliteVec|sqlite_vec", re.I),
}

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)


def strip_comments(text):
    """Drop block comments and whole-line // comments (trailing // is kept:
    it may sit inside a string such as a URL)."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def is_production_ts(rel):
    if not rel.endswith(".ts") or rel.endswith(".d.ts"):
        return False
    parts = rel.split(os.sep)
    if "__tests__" in parts or "migrations" in parts or "generated" in parts:
        return False
    return not rel.endswith((".test.ts", ".spec.ts"))


def count_text(text):
    clean = strip_comments(text)
    return {name: len(re.findall(rx, clean, flags)) for name, (rx, flags) in TOKENS.items()}


def scan(src_dir=None):
    """Return (totals, per_file) over production TypeScript."""
    src_dir = src_dir or SRC_DIR
    totals = collections.Counter()
    per_file = {}
    for dirpath, dirnames, filenames in os.walk(src_dir):
        dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
        for fn in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, fn), src_dir)
            if not is_production_ts(rel):
                continue
            with open(os.path.join(dirpath, fn), encoding="utf-8", errors="ignore") as f:
                counts = count_text(f.read())
            nonzero = {k: v for k, v in counts.items() if v}
            if nonzero:
                per_file[rel] = nonzero
                totals.update(nonzero)
    return {name: totals.get(name, 0) for name in TOKENS}, per_file


def compare(current, baseline):
    """Return (grown, shrunk): token -> (baseline, current)."""
    grown, shrunk = {}, {}
    for name in sorted(set(current) | set(baseline)):
        cur, base = current.get(name, 0), baseline.get(name)
        if base is None:
            if cur:
                grown[name] = (0, cur)
        elif cur > base:
            grown[name] = (base, cur)
        elif cur < base:
            shrunk[name] = (base, cur)
    return grown, shrunk


def load_baseline(path=None):
    with open(path or BASELINE_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("counts", {})


def write_baseline(counts, path=None):
    with open(path or BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump({"counts": counts}, f, indent=2, sort_keys=True)
        f.write("\n")


def main(argv):
    current, per_file = scan()
    if "--report" in argv:
        for name in TOKENS:
            print("%-24s %d" % (name, current[name]))
        for rel, counts in sorted(per_file.items(), key=lambda kv: -sum(kv[1].values())):
            print("  %-48s %s" % (rel, ", ".join("%s=%d" % kv for kv in sorted(counts.items()))))
        return 0

    if "--update" in argv:
        try:
            baseline = load_baseline()
        except (OSError, ValueError):
            baseline = {}
        grown, _ = compare(current, baseline) if baseline else ({}, {})
        if grown and "--allow-increase" not in argv:
            for name, (b, c) in grown.items():
                print("REFUSED to raise %s: %d -> %d (use --allow-increase if intended)" % (name, b, c))
            return 1
        write_baseline(current)
        print("baseline written: %s" % BASELINE_PATH)
        return 0

    try:
        baseline = load_baseline()
    except (OSError, ValueError) as exc:
        print("FAIL cannot read baseline %s: %s" % (BASELINE_PATH, exc))
        return 2
    grown, shrunk = compare(current, baseline)
    for name, (b, c) in grown.items():
        print("GREW %s: baseline %d -> now %d" % (name, b, c))
    for name, (b, c) in shrunk.items():
        print("shrunk %s: baseline %d -> now %d (run --update to lock it in)" % (name, b, c))
    if grown:
        print("FAIL: a SQLite-specific construct count grew. Use a portable form, or if it is "
              "truly needed, raise the baseline with --update --allow-increase and say why in the PR.")
        return 1
    print("OK sqlite-dialect ratchet (%d token kinds, none grew)" % len(current))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
