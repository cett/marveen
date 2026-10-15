#!/usr/bin/env python3
"""Merge key=value pairs into the claude-update state file, atomically.

Usage: claude-update-state.py <state-file> key=value [key=value ...]

The dashboard (src/web/claude-update.ts) only reads this file. Keys already in
it that this run does not set are kept (updatedAt, previous). Values: "true"/"false" become booleans,
a key ending in "At" becomes an integer (epoch seconds), "null" becomes null,
everything else stays a string.
"""
import json
import os
import sys
import tempfile


def coerce(key, value):
    if value == "true":
        return True
    if value == "false":
        return False
    if value == "null":
        return None
    if key.endswith("At"):
        return int(value)
    return value


def main(argv):
    if len(argv) < 3:
        print("usage: claude-update-state.py <state-file> key=value ...", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}
    for pair in argv[2:]:
        key, sep, value = pair.partition("=")
        if not sep or not key:
            print("bad pair: %r" % pair, file=sys.stderr)
            return 2
        state[key] = coerce(key, value)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".claude-update-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
