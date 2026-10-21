#!/usr/bin/env python3
"""Raw-SQL-outside-the-db-layer ratchet for the PostgreSQL migration preparation (1017 Phase 1).

Every database call has to go through a function in src/db/ so the Phase 1 async facade (and, on
PostgreSQL, the per-request tenant context) can wrap it in ONE place. A `.prepare(`, a `getDb()` or a
`.transaction(` anywhere else is a call the facade would miss. This ratchet keeps that surface from
growing while it is being drained:

  * it counts `.prepare(`, `getDb(` and `.transaction(` in production TypeScript under src/ and
    scripts/, EXCEPT the db layer itself (src/db/ and the src/db.ts barrel), tests, generated code and
    src/migrations/; comments are stripped;
  * a FILE x TOKEN count may not grow past scripts/db-outside-sql-baseline.json, and a file that is not
    in the baseline may not appear with any count (a new raw-SQL file fails);
  * counts may only go down: lock a decrease in with --update. A file that is clean drops out of the
    baseline (and its note) on --update.

What is left in the baseline has a note saying why it is not a plain move into src/db/ (a separate
connection, a separate process, the migration runner, an operator CLI). It does not judge a use, only
that the total does not grow. The dialect ratchet (sqlite-dialect-ratchet.py) looks at what the SQL says;
this one looks at where the call sits.

Usage:
    python3 db-outside-sql-ratchet.py            # check (exit 1 on growth / a new file)
    python3 db-outside-sql-ratchet.py --report   # per-file table with the notes
    python3 db-outside-sql-ratchet.py --update   # rewrite baseline (lower only)
    python3 db-outside-sql-ratchet.py --update --allow-increase
    python3 db-outside-sql-ratchet.py --update --note path="why it stays" [--note ...]

Exit codes: 0 ok, 1 a count grew / a new file, 2 usage / IO error.
"""
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
BASELINE_PATH = os.path.join(SCRIPT_DIR, "db-outside-sql-baseline.json")

# Directories (relative to the repo root) that are scanned, and the paths that are the db layer.
SCAN_DIRS = ("src", "scripts")
DB_LAYER_DIRS = ("src/db/",)
DB_LAYER_FILES = ("src/db.ts",)

TOKENS = {
    "prepare": re.compile(r"\.prepare\s*\("),
    "getDb": re.compile(r"\bgetDb\s*\("),
    "transaction": re.compile(r"\.transaction\s*\("),
}

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)


def strip_comments(text):
    """Drop block comments and whole-line // comments (trailing // is kept: it may sit inside a string)."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def is_scanned(rel):
    """rel is a repo-relative path with forward slashes."""
    if not rel.endswith(".ts") or rel.endswith(".d.ts"):
        return False
    if rel.endswith((".test.ts", ".spec.ts")):
        return False
    parts = rel.split("/")
    if any(p in ("__tests__", "migrations", "generated", "node_modules") for p in parts):
        return False
    if rel in DB_LAYER_FILES or any(rel.startswith(d) for d in DB_LAYER_DIRS):
        return False
    return True


def count_text(text):
    clean = strip_comments(text)
    return {name: len(rx.findall(clean)) for name, rx in TOKENS.items()}


def scan(root=None):
    """Return {rel_path: {token: count}} for every scanned file with at least one hit."""
    root = root or REPO_ROOT
    found = {}
    for top in SCAN_DIRS:
        base = os.path.join(root, top)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
            for fn in sorted(filenames):
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                if not is_scanned(rel):
                    continue
                with open(os.path.join(dirpath, fn), encoding="utf-8", errors="ignore") as f:
                    counts = count_text(f.read())
                nonzero = {k: v for k, v in counts.items() if v}
                if nonzero:
                    found[rel] = nonzero
    return found


def compare(current, baseline):
    """Return (grown, new_files, shrunk).

    grown:     [(file, token, baseline, now)] a count in a baselined file went up
    new_files: [(file, counts)] a file with hits that is not in the baseline
    shrunk:    [(file, token, baseline, now)] a count went down or a file is clean (lock it in with --update)
    """
    grown, new_files, shrunk = [], [], []
    for rel, counts in sorted(current.items()):
        if rel not in baseline:
            new_files.append((rel, counts))
            continue
        for tok in TOKENS:
            cur, base = counts.get(tok, 0), baseline[rel].get(tok, 0)
            if cur > base:
                grown.append((rel, tok, base, cur))
            elif cur < base:
                shrunk.append((rel, tok, base, cur))
    for rel, counts in sorted(baseline.items()):
        if rel not in current:
            for tok, base in sorted(counts.items()):
                shrunk.append((rel, tok, base, 0))
    return grown, new_files, shrunk


def load_baseline(path=None):
    with open(path or BASELINE_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("files", {}), data.get("notes", {})


def write_baseline(files, notes, path=None):
    kept = {rel: n for rel, n in notes.items() if rel in files}
    with open(path or BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump({"files": files, "notes": kept}, f, indent=2, sort_keys=True)
        f.write("\n")


def _totals(files):
    return {tok: sum(c.get(tok, 0) for c in files.values()) for tok in TOKENS}


def _arg_values(argv, flag):
    out = []
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            out.append(argv[i + 1])
    return out


def main(argv, root=None, baseline_path=None):
    current = scan(root)
    try:
        baseline, notes = load_baseline(baseline_path)
    except (OSError, ValueError):
        baseline, notes = None, {}

    if "--report" in argv:
        totals = _totals(current)
        print("raw SQL outside src/db/: %s" % ", ".join("%s=%d" % (t, totals[t]) for t in TOKENS))
        for rel, counts in sorted(current.items(), key=lambda kv: -sum(kv[1].values())):
            print("  %-48s %-34s %s" % (rel, ", ".join("%s=%d" % kv for kv in sorted(counts.items())), (notes or {}).get(rel, "")))
        return 0

    if "--update" in argv:
        grown, new_files = [], []
        if baseline is not None:
            grown, new_files, _ = compare(current, baseline)
        if (grown or new_files) and "--allow-increase" not in argv:
            for rel, tok, b, c in grown:
                print("REFUSED to raise %s %s: %d -> %d (use --allow-increase if intended)" % (rel, tok, b, c))
            for rel, counts in new_files:
                print("REFUSED to add %s %s (use --allow-increase if intended)" % (rel, counts))
            return 1
        for spec in _arg_values(argv, "--note"):
            if "=" not in spec:
                print("--note needs path=text")
                return 2
            path, text = spec.split("=", 1)
            notes[path] = text
        write_baseline(current, notes, baseline_path)
        print("baseline written: %s" % (baseline_path or BASELINE_PATH))
        return 0

    if baseline is None:
        print("FAIL cannot read baseline %s" % (baseline_path or BASELINE_PATH))
        return 2
    grown, new_files, shrunk = compare(current, baseline)
    for rel, tok, b, c in grown:
        print("GREW %s %s: baseline %d -> now %d" % (rel, tok, b, c))
    for rel, counts in new_files:
        print("NEW FILE with raw SQL outside src/db/: %s %s" % (rel, ", ".join("%s=%d" % kv for kv in sorted(counts.items()))))
    for rel, tok, b, c in shrunk:
        print("shrunk %s %s: baseline %d -> now %d (run --update to lock it in)" % (rel, tok, b, c))
    if grown or new_files:
        print("FAIL: raw SQL (.prepare / getDb() / .transaction) outside src/db/ grew. Put the statement in a "
              "function in src/db/ and call that; if it truly cannot move, raise the baseline with "
              "--update --allow-increase --note path=\"why\" and say why in the PR.")
        return 1
    totals = _totals(current)
    print("OK db-outside-sql ratchet (%d files, prepare=%d getDb=%d transaction=%d, none grew)"
          % (len(current), totals["prepare"], totals["getDb"], totals["transaction"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
