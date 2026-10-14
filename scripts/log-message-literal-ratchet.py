#!/usr/bin/env python3
"""Ratchet: a value built into the MESSAGE of a warn/error/fatal log call (OTel H6b).

The application log export (OTEL_EXPORT_APP_LOGS, src/otel-app-logs.ts) sends the message TEMPLATE of every warn,
error and fatal line and never reads the bound fields or the format arguments, because that is where a call's data
lives. A message with a value built into the string itself, logger.warn({ id }, `saved with ${warning}`), puts that
value into the message, and the export's scrubbing (credentials, paths, mailboxes, long ids) cannot recognise
everything. So the rule for these calls is: a FIXED message, the data in the bound fields.

This counts, per production TypeScript file, the warn/error/fatal calls of `logger` (and `log` / `*Logger`
variables) whose message argument is not a FIXED string: a template-literal substitution, a concatenation with
anything that is not a plain literal, a VARIABLE or any other expression (`logger.warn({ prober }, text)`: the
content of `text` is unknown here). A ternary of fixed strings is fixed, a lone error or object argument has no
message. A forwarding helper whose callers pass literals (`(obj, msg) => logger.warn(obj, msg)`) is counted too and
lives in the baseline. A count may
not grow past the committed baseline (scripts/log-message-literal-baseline.json); a new file with such a call
fails. Counts may only go down: lock a decrease in with --update.

Usage:
    python3 log-message-literal-ratchet.py            # check (exit 1 on growth)
    python3 log-message-literal-ratchet.py --report   # list every call
    python3 log-message-literal-ratchet.py --update   # rewrite the baseline (lower only)
    python3 log-message-literal-ratchet.py --update --allow-increase

Exit codes: 0 ok, 1 a count grew, 2 usage / IO error.
"""
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SRC_DIR = os.path.join(REPO_ROOT, "src")
BASELINE_PATH = os.path.join(SCRIPT_DIR, "log-message-literal-baseline.json")

CALL_RE = re.compile(r"\b(?:logger|log|\w+Logger)\s*\.\s*(?:warn|error|fatal)\s*\(")


def skip_string(text, i):
    """text[i] opens a quote; return the index after its closing quote (template literals nest ${ ... })."""
    q = text[i]
    i += 1
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if q == "`" and c == "$" and text[i + 1:i + 2] == "{":
            i = skip_balanced(text, i + 1, "{", "}")
            continue
        if c == q:
            return i + 1
        i += 1
    return i


def skip_balanced(text, i, open_c, close_c):
    """text[i] == open_c; return the index after the matching close_c, skipping strings."""
    depth = 0
    while i < len(text):
        c = text[i]
        if c in "'\"`":
            i = skip_string(text, i)
            continue
        if c == "/" and text[i + 1:i + 2] == "/":
            i = text.find("\n", i)
            i = len(text) if i < 0 else i
            continue
        if c == "/" and text[i + 1:i + 2] == "*":
            j = text.find("*/", i + 2)
            i = len(text) if j < 0 else j + 2
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return i


def split_args(text, start):
    """Top-level arguments of the call whose '(' is at text[start]: a list of source strings."""
    end = skip_balanced(text, start, "(", ")")
    inner = text[start + 1:end - 1]
    args, depth, i, cur = [], 0, 0, 0
    while i < len(inner):
        c = inner[i]
        if c in "'\"`":
            i = skip_string(inner, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            args.append(inner[cur:i].strip())
            cur = i + 1
        i += 1
    tail = inner[cur:].strip()
    if tail:
        args.append(tail)
    return args


def split_plus(arg):
    """The operands of a top-level `a + b + c`."""
    parts, depth, i, cur = [], 0, 0, 0
    while i < len(arg):
        c = arg[i]
        if c in "'\"`":
            i = skip_string(arg, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "+" and depth == 0:
            parts.append(arg[cur:i].strip())
            cur = i + 1
        i += 1
    parts.append(arg[cur:].strip())
    return parts


def is_plain_literal(operand):
    """'text', "text" or `text` with nothing substituted, and nothing after the closing quote."""
    if operand[:1] not in "'\"`":
        return False
    if operand[:1] == "`" and "${" in operand:
        return False
    return skip_string(operand, 0) == len(operand)


def split_ternary(arg):
    """(condition, then, else) of a top-level `c ? a : b`, or None."""
    depth, i, q = 0, 0, None
    while i < len(arg):
        c = arg[i]
        if c in "'\"`":
            i = skip_string(arg, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0 and c == "?" and arg[i + 1:i + 2] not in (".", "?") and arg[i - 1:i] != "?":
            q = i
            break
        i += 1
    if q is None:
        return None
    depth, i, nested = 0, q + 1, 0
    while i < len(arg):
        c = arg[i]
        if c in "'\"`":
            i = skip_string(arg, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0 and c == "?" and arg[i + 1:i + 2] not in (".", "?"):
            nested += 1
        elif depth == 0 and c == ":":
            if nested == 0:
                return arg[:q].strip(), arg[q + 1:i].strip(), arg[i + 1:].strip()
            nested -= 1
        i += 1
    return None


def is_fixed_message(arg):
    """A plain string literal, plain literals joined with +, or a ternary whose branches are fixed messages."""
    arg = arg.strip()
    if arg.startswith("(") and arg.endswith(")") and skip_balanced(arg, 0, "(", ")") == len(arg):
        return is_fixed_message(arg[1:-1])
    t = split_ternary(arg)
    if t is not None:
        return is_fixed_message(t[1]) and is_fixed_message(t[2])
    return all(is_plain_literal(p) for p in split_plus(arg))


ERRORISH = re.compile(r"^(?:err|error|e|exc|ex|cause)$")


def builds_message(args):
    """True when the message of the call is not a fixed string: a substitution or concatenation, but also a
    VARIABLE or any other expression (its content is unknown here: `logger.warn({}, text)`, or a `msg` built a
    line above). pino: (obj, msg, ...) or (msg, ...); a lone error object is fine (only its class and code are
    exported)."""
    if not args:
        return False
    first = args[0]
    if first[:1] in "'\"`":
        return not is_fixed_message(first)
    if len(args) >= 2:
        return not is_fixed_message(args[1])
    return first[:1] != "{" and not ERRORISH.match(first)


def strip_comments_keep_length(text):
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))  # keep the newlines: line numbers stay right
    out = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
    return re.sub(r"(?m)^(\s*)//.*$", blank, out)


def scan_text(text):
    """[(line number, first line of the call)] for the calls with a value built into the message."""
    clean = strip_comments_keep_length(text)
    found = []
    for m in CALL_RE.finditer(clean):
        args = split_args(clean, m.end() - 1)
        if builds_message(args):
            line = clean.count("\n", 0, m.start()) + 1
            found.append((line, text.split("\n")[line - 1].strip()[:140]))
    return found


def is_production_ts(rel):
    parts = rel.split(os.sep)
    if not rel.endswith(".ts") or rel.endswith(".d.ts") or "__tests__" in parts or "generated" in parts:
        return False
    return not rel.endswith((".test.ts", ".spec.ts"))


def scan(src_dir=None):
    src_dir = src_dir or SRC_DIR
    per_file = {}
    for dirpath, dirnames, filenames in os.walk(src_dir):
        dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
        for fn in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, fn), src_dir)
            if not is_production_ts(rel):
                continue
            with open(os.path.join(dirpath, fn), encoding="utf-8", errors="ignore") as f:
                hits = scan_text(f.read())
            if hits:
                per_file[rel.replace(os.sep, "/")] = hits
    return per_file


def load_baseline(path=None):
    with open(path or BASELINE_PATH, encoding="utf-8") as f:
        return json.load(f).get("counts", {})


def write_baseline(counts, path=None):
    with open(path or BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump({"counts": counts}, f, indent=2, sort_keys=True)
        f.write("\n")


def main(argv):
    per_file = scan()
    counts = {rel: len(hits) for rel, hits in per_file.items()}
    if "--report" in argv:
        for rel, hits in sorted(per_file.items()):
            for line, src in hits:
                print("%s:%d: %s" % (rel, line, src))
        print("total: %d" % sum(counts.values()))
        return 0
    try:
        baseline = load_baseline()
    except (OSError, ValueError):
        baseline = None
    if "--update" in argv:
        grown = {k: (baseline.get(k, 0), v) for k, v in counts.items() if baseline is not None and v > baseline.get(k, 0)}
        if grown and "--allow-increase" not in argv:
            print("refusing to raise the baseline: " + ", ".join("%s %d -> %d" % (k, a, b) for k, (a, b) in sorted(grown.items())))
            return 1
        write_baseline(counts)
        print("baseline written: %d files, %d calls" % (len(counts), sum(counts.values())))
        return 0
    if baseline is None:
        print("no baseline: run with --update")
        return 2
    grown = {k: (baseline.get(k, 0), v) for k, v in counts.items() if v > baseline.get(k, 0)}
    shrunk = {k: (v, counts.get(k, 0)) for k, v in baseline.items() if counts.get(k, 0) < v}
    for k, (a, b) in sorted(grown.items()):
        print("GREW %s: baseline %d -> now %d" % (k, a, b))
        for line, src in per_file.get(k, []):
            print("   %s:%d: %s" % (k, line, src))
    if grown:
        print("FAIL: a warn/error/fatal log call builds a value into its message. Put the value in the bound fields and keep the "
              "message fixed (the application log export sends the message), or, if it is not data, raise the baseline with --update --allow-increase and say why in the PR.")
        return 1
    for k, (a, b) in sorted(shrunk.items()):
        print("shrunk %s: baseline %d -> now %d (run --update to lock it in)" % (k, a, b))
    print("OK log-message-literal ratchet (%d files, %d calls)" % (len(counts), sum(counts.values())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
