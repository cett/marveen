#!/usr/bin/env python3
"""Direct-database-access ratchet for NON-TypeScript code (PostgreSQL migration prep).

The TypeScript ratchet (sqlite-dialect-ratchet.py) only sees src/. Python hooks and
libraries, shell scripts, installers, scheduled-task / skill instructions and
templates also reach the database directly (the sqlite3 module, the sqlite3 CLI,
the claudeclaw.db / intel.db paths, better-sqlite3). Every one of those has to be
ported, redirected to the dashboard API, or retired before the PostgreSQL cutover.

This ratchet keeps that surface from growing while it is being drained:

  * a FILE x TOKEN count may not grow past the committed baseline
    (scripts/non-ts-db-access-baseline.json); a new file with direct access fails;
  * every file with direct access must carry a DISPOSITION in the baseline:
        A  stays on the database (fail-closed hooks, tenant context, watchdog)
        B  moves to the dashboard API
        C  operational tooling / retired with SQLite (backup, restore, installers)
        X  not our database (out of scope)
    so the report shows how much is left in B and C;
  * SQLite dialect constructs (unixepoch(), INSERT OR ..., PRAGMA, ...) are counted
    only in files that touch the database, using the same token list as the
    TypeScript ratchet, and may not grow either.

Counts may only go down: lock a decrease in with --update. A file whose direct
access is gone drops out of the baseline (and its disposition) on --update.

Usage:
    python3 non-ts-db-access-ratchet.py                 # check (exit 1 on growth)
    python3 non-ts-db-access-ratchet.py --report        # per-file table + progress by disposition
    python3 non-ts-db-access-ratchet.py --update        # rewrite baseline (lower only)
    python3 non-ts-db-access-ratchet.py --update --classify path=B [--classify ...]
    python3 non-ts-db-access-ratchet.py --update --allow-increase

Exit codes: 0 ok, 1 a count grew / unclassified file, 2 usage / IO error.
"""
import collections
import importlib.util
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
BASELINE_PATH = os.path.join(SCRIPT_DIR, "non-ts-db-access-baseline.json")

DISPOSITIONS = {
    "A": "stays on the database",
    "B": "moves to the dashboard API",
    "C": "operational tooling / retired with SQLite",
    "X": "not our database",
}

# Directories scanned (relative to the repo root) plus the loose files in the root.
SCAN_DIRS = ("scripts", "seed-skills", "seed-scheduled-tasks", "scheduled-tasks", "skills", "templates")
SCAN_EXTENSIONS = (".py", ".sh", ".mjs", ".cjs", ".js", ".ts", ".md", ".template", ".service")
SKIP_DIR_NAMES = {"node_modules", "__tests__", "eval", ".git", "dist", "generated"}
# The ratchets name the very constructs they look for.
SKIP_FILES = {"scripts/non-ts-db-access-ratchet.py", "scripts/sqlite-dialect-ratchet.py"}


def _load_ts_tokens():
    """Reuse the dialect token list of the TypeScript ratchet (one list, no drift)."""
    path = os.path.join(SCRIPT_DIR, "sqlite-dialect-ratchet.py")
    spec = importlib.util.spec_from_file_location("sqlite_dialect_ratchet_tokens", path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return dict(mod.TOKENS)


_DIALECT = _load_ts_tokens()
# time.strftime / datetime.strftime in Python are not SQL: only a bare strftime( counts.
_DIALECT["strftime()"] = (r"(?<![.\w])strftime\s*\(", re.I)

# name -> (regex, flags): direct database access.
DIRECT = {
    "python sqlite3": (r"^[ \t]*(?:import\s+sqlite3\b|from\s+sqlite3\b)", re.M),
    "sqlite3.connect": (r"\bsqlite3\.connect\s*\(", 0),
    # the CLI, followed by a path / quote / variable / template placeholder (not prose like "sqlite3 CLI")
    "sqlite3 CLI": (r"(?<![\w./-])sqlite3[ \t]+(?:-[A-Za-z]+[ \t]+)*(?:[\"'$]|\{\{|[./~]|store/|\w+\.db\b)", 0),
    "claudeclaw.db": (r"\bclaudeclaw\.db\b", 0),
    "intel.db": (r"\bintel\.db\b", 0),
    "better-sqlite3": (r"better-sqlite3", 0),
}

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_SLASH_LINE = re.compile(r"^\s*//.*$", re.M)
_HASH_LINE = re.compile(r"^\s*#(?!!).*$", re.M)


def strip_comments(text, rel):
    """Drop whole-line comments for code files; prose (md, templates) is kept whole."""
    ext = os.path.splitext(rel)[1]
    if ext in (".py", ".sh"):
        return _HASH_LINE.sub("", text)
    if ext in (".ts", ".mjs", ".cjs", ".js"):
        return _SLASH_LINE.sub("", _BLOCK_COMMENT.sub("", text))
    return text


def is_scanned(rel):
    """rel is a repo-root-relative path with forward slashes."""
    if rel in SKIP_FILES:
        return False
    parts = rel.split("/")
    if any(p in SKIP_DIR_NAMES for p in parts[:-1]):
        return False
    name = parts[-1]
    if not name.endswith(SCAN_EXTENSIONS):
        return False
    if name.endswith((".test.ts", ".spec.ts", ".d.ts", ".test.py", ".test.sh")):
        return False
    if len(parts) == 1:
        # loose files in the root: installers and update scripts only
        return name.endswith(".sh")
    return parts[0] in SCAN_DIRS


def count_text(text, rel):
    """Return (direct, dialect) count dicts (zero entries omitted). Dialect counts are
    only produced for files that have at least one direct-access hit."""
    clean = strip_comments(text, rel)
    direct = {n: len(re.findall(rx, clean, fl)) for n, (rx, fl) in DIRECT.items()}
    direct = {k: v for k, v in direct.items() if v}
    dialect = {}
    if direct:
        dialect = {n: len(re.findall(rx, clean, fl)) for n, (rx, fl) in _DIALECT.items()}
        dialect = {k: v for k, v in dialect.items() if v}
    return direct, dialect


def scan(root=None):
    """Return {rel: {"direct": {...}, "dialect": {...}}} for files with direct access."""
    root = root or REPO_ROOT
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIR_NAMES)
        for fn in sorted(filenames):
            rel = fn if rel_dir == "." else "%s/%s" % (rel_dir.replace(os.sep, "/"), fn)
            if not is_scanned(rel):
                continue
            try:
                with open(os.path.join(dirpath, fn), encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except OSError:
                continue
            direct, dialect = count_text(text, rel)
            if direct:
                out[rel] = {"direct": direct, "dialect": dialect}
    return out


def compare(current, baseline_files):
    """Return (grown, shrunk, new_files, gone_files).

    grown / shrunk: list of (rel, kind, token, baseline, current)."""
    grown, shrunk = [], []
    new_files = sorted(r for r in current if r not in baseline_files)
    gone_files = sorted(r for r in baseline_files if r not in current)
    for rel in sorted(current):
        base = baseline_files.get(rel, {})
        for kind in ("direct", "dialect"):
            cur_k, base_k = current[rel].get(kind, {}), base.get(kind, {})
            for tok in sorted(set(cur_k) | set(base_k)):
                c, b = cur_k.get(tok, 0), base_k.get(tok, 0)
                if rel in new_files:
                    continue  # reported as a new file, not per token
                if c > b:
                    grown.append((rel, kind, tok, b, c))
                elif c < b:
                    shrunk.append((rel, kind, tok, b, c))
    # tokens that vanished together with their file
    for rel in gone_files:
        for kind in ("direct", "dialect"):
            for tok, b in baseline_files[rel].get(kind, {}).items():
                shrunk.append((rel, kind, tok, b, 0))
    return grown, shrunk, new_files, gone_files


def load_baseline(path=None):
    with open(path or BASELINE_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("files", {}), data.get("dispositions", {})


def write_baseline(files, dispositions, path=None):
    keep = {rel: d for rel, d in dispositions.items() if rel in files}
    with open(path or BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump({"dispositions": keep, "files": files}, f, indent=2, sort_keys=True)
        f.write("\n")


def unclassified(current, dispositions):
    return sorted(rel for rel in current if dispositions.get(rel) not in DISPOSITIONS)


def progress(current, dispositions):
    """{disposition: (files, direct token total)}."""
    acc = collections.defaultdict(lambda: [0, 0])
    for rel, c in current.items():
        d = dispositions.get(rel, "?")
        acc[d][0] += 1
        acc[d][1] += sum(c["direct"].values())
    return {d: tuple(v) for d, v in acc.items()}


def _parse_classify(argv):
    out, i = {}, 0
    while i < len(argv):
        if argv[i] == "--classify" and i + 1 < len(argv):
            rel, _, disp = argv[i + 1].partition("=")
            if disp not in DISPOSITIONS or not rel:
                raise ValueError("bad --classify %r (use path=A|B|C|X)" % argv[i + 1])
            out[rel] = disp
            i += 2
        else:
            i += 1
    return out


def main(argv):
    try:
        classify = _parse_classify(argv)
    except ValueError as exc:
        print("FAIL %s" % exc)
        return 2
    current = scan()

    if "--report" in argv:
        try:
            _, dispositions = load_baseline()
        except (OSError, ValueError):
            dispositions = {}
        dispositions = {**dispositions, **classify}
        for rel, c in sorted(current.items(), key=lambda kv: (dispositions.get(kv[0], "?"), kv[0])):
            print("%s %-58s direct: %s%s" % (
                dispositions.get(rel, "?"), rel,
                ", ".join("%s=%d" % kv for kv in sorted(c["direct"].items())),
                ("  | dialect: " + ", ".join("%s=%d" % kv for kv in sorted(c["dialect"].items()))) if c["dialect"] else "",
            ))
        print("")
        for d, (nfiles, ntok) in sorted(progress(current, dispositions).items()):
            print("disposition %s (%s): %d files, %d direct-access hits" % (d, DISPOSITIONS.get(d, "UNCLASSIFIED"), nfiles, ntok))
        return 0

    if "--update" in argv:
        try:
            base_files, dispositions = load_baseline()
        except (OSError, ValueError):
            base_files, dispositions = {}, {}
        dispositions = {**dispositions, **classify}
        grown, _, new_files, _ = compare(current, base_files) if base_files else ([], [], [], [])
        if (grown or new_files) and "--allow-increase" not in argv:
            for rel, kind, tok, b, c in grown:
                print("REFUSED to raise %s [%s] %s: %d -> %d (use --allow-increase if intended)" % (rel, kind, tok, b, c))
            for rel in new_files:
                print("REFUSED to add new direct-access file %s (use --allow-increase if intended)" % rel)
            return 1
        missing = unclassified(current, dispositions)
        if missing:
            for rel in missing:
                print("REFUSED: %s has no disposition (pass --classify %s=A|B|C|X)" % (rel, rel))
            return 1
        write_baseline(current, dispositions)
        print("baseline written: %s (%d files)" % (BASELINE_PATH, len(current)))
        return 0

    try:
        base_files, dispositions = load_baseline()
    except (OSError, ValueError) as exc:
        print("FAIL cannot read baseline %s: %s" % (BASELINE_PATH, exc))
        return 2
    grown, shrunk, new_files, gone_files = compare(current, base_files)
    for rel in new_files:
        print("NEW direct DB access file: %s" % rel)
    for rel, kind, tok, b, c in grown:
        print("GREW %s [%s] %s: baseline %d -> now %d" % (rel, kind, tok, b, c))
    for rel, kind, tok, b, c in shrunk:
        print("shrunk %s [%s] %s: baseline %d -> now %d (run --update to lock it in)" % (rel, kind, tok, b, c))
    missing = unclassified(current, dispositions)
    for rel in missing:
        print("UNCLASSIFIED %s (add a disposition A|B|C|X to the baseline)" % rel)
    if new_files or grown or missing:
        print("FAIL: direct database access outside src/ grew or is unclassified. Go through the "
              "dashboard API instead (see the PostgreSQL migration plan), or if the access truly must "
              "stay, add it with --update --allow-increase --classify <path>=<A|B|C|X> and say why in the PR.")
        return 1
    prog = progress(current, dispositions)
    print("OK non-ts db-access ratchet (%d files: %s)" % (
        len(current), ", ".join("%s=%d" % (d, prog[d][0]) for d in sorted(prog))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
