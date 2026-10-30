#!/usr/bin/env bash
# Tests of scripts/run-python-tests.sh: a failing file fails the run, a passing set passes, every file gets its
# "== file ==" block, the output order is the file name order whatever finishes first, a bad -j is refused.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/../run-python-tests.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/run-python-tests-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fails=0
check() { # name, condition result (0 = ok)
  if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}

mkdir "$TMP/pass" "$TMP/mixed"
printf 'import time\ntime.sleep(1)\nprint("slow-one")\n' > "$TMP/pass/a-slow.test.py"
printf 'print("fast-one")\n' > "$TMP/pass/b-fast.test.py"
cp "$TMP/pass/a-slow.test.py" "$TMP/mixed/a-slow.test.py"
printf 'import sys\nprint("boom")\nsys.exit(3)\n' > "$TMP/mixed/b-bad.test.py"

out="$(bash "$RUNNER" -j 2 -d "$TMP/pass" 2>&1)"; rc=$?
check "a passing set exits 0" "$rc"
echo "$out" | grep -q "all passed"; check "a passing set says so" "$?"
echo "$out" | grep -q "== $TMP/pass/a-slow.test.py =="; check "each file has its block" "$?"
first="$(echo "$out" | grep -n "slow-one" | head -1 | cut -d: -f1)"
second="$(echo "$out" | grep -n "fast-one" | head -1 | cut -d: -f1)"
[ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ]; check "blocks come in name order, not finish order" "$?"

out="$(bash "$RUNNER" -j 2 -d "$TMP/mixed" 2>&1)"; rc=$?
[ "$rc" = 1 ]; check "a failing file exits 1" "$?"
echo "$out" | grep -q "FAILED: $TMP/mixed/b-bad.test.py"; check "the failing file is named" "$?"
echo "$out" | grep -q "boom"; check "the failing file's output is kept" "$?"
echo "$out" | grep -q "slow-one"; check "the passing file still ran" "$?"

# A job that dies before it records its exit code (here: the python kills the shell that wraps it, as an OOM kill
# or a runner timeout would) leaves no .rc file. That is a failure, never a pass.
mkdir "$TMP/died"
cp "$TMP/pass/b-fast.test.py" "$TMP/died/a-fast.test.py"
printf 'import os, signal\nprint("dying")\nos.kill(os.getppid(), signal.SIGKILL)\n' > "$TMP/died/b-died.test.py"
out="$(bash "$RUNNER" -j 2 -d "$TMP/died" 2>&1)"; rc=$?
[ "$rc" = 1 ]; check "a job that died without an exit code exits 1" "$?"
echo "$out" | grep -q "FAILED: $TMP/died/b-died.test.py"; check "the dead job is named as failed" "$?"
echo "$out" | grep -q "b-died.test.py exited 99"; check "the missing exit code reads as 99, not 0" "$?"
echo "$out" | grep -q "all passed" && no_pass=1 || no_pass=0
[ "$no_pass" = 0 ]; check "a dead job never prints 'all passed'" "$?"

bash "$RUNNER" -j 0 -d "$TMP/pass" > /dev/null 2>&1; rc=$?
[ "$rc" = 2 ]; check "-j 0 is refused" "$?"
bash "$RUNNER" -d "$TMP/nothing" > /dev/null 2>&1; rc=$?
[ "$rc" = 2 ]; check "a directory with no tests is refused" "$?"

[ "$fails" = 0 ]
