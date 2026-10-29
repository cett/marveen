#!/usr/bin/env bash
# Runs the python gate tests (scripts/__tests__/*.test.py) in parallel and reports like the old serial loop:
# one "== file ==" block per test, a summary, exit 1 when any test failed. The CI "Python tests" step calls it.
#
#   bash scripts/run-python-tests.sh [-j N] [-d DIR]
#
#   -j N   parallel jobs (default: PYTEST_JOBS, else 4)
#   -d DIR test directory (default scripts/__tests__)
#
# The slowest tests start first, so the wall time is about the slowest single test instead of the sum.
# Portable to the bash 3.2 of macOS: no associative arrays, no mapfile, no `wait -n`.
set -u

JOBS="${PYTEST_JOBS:-4}"
DIR="scripts/__tests__"
while getopts "j:d:" opt; do
  case "$opt" in
    j) JOBS="$OPTARG" ;;
    d) DIR="$OPTARG" ;;
    *) echo "usage: run-python-tests.sh [-j N] [-d DIR]" >&2; exit 2 ;;
  esac
done
case "$JOBS" in ''|*[!0-9]*|0) echo "run-python-tests: -j needs a positive number" >&2; exit 2 ;; esac

# Measured slowest first (seconds, serial, 10-29): gmail-send 133, email-approval-gate 49, gate-audit-lib 48,
# secret-read-gate 40, auth-admin-gate 21. A test missing here simply runs after them, in name order.
SLOW_FIRST="gmail-send email-approval-gate gate-audit-lib secret-read-gate auth-admin-gate"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/pytests.XXXXXX")" || exit 2
trap 'rm -rf "$OUT"' EXIT

ALL="$(ls "$DIR"/*.test.py 2>/dev/null | sort)"
if [ -z "$ALL" ]; then echo "run-python-tests: no *.test.py in $DIR" >&2; exit 2; fi

ORDER=""
for name in $SLOW_FIRST; do
  f="$DIR/$name.test.py"
  [ -f "$f" ] && ORDER="$ORDER$f"$'\n'
done
for f in $ALL; do
  skip=0
  for name in $SLOW_FIRST; do [ "$f" = "$DIR/$name.test.py" ] && skip=1; done
  [ "$skip" = 0 ] && ORDER="$ORDER$f"$'\n'
done

run_one() {
  local f="$1" base start end
  base="$(basename "$f")"
  start="$(date +%s)"
  python3 "$f" > "$OUT/$base.log" 2>&1
  echo $? > "$OUT/$base.rc"
  end="$(date +%s)"
  echo $((end - start)) > "$OUT/$base.sec"
}
export -f run_one
export OUT

T0="$(date +%s)"
printf '%s' "$ORDER" | xargs -P "$JOBS" -I{} bash -c 'run_one "$1"' _ {}
T1="$(date +%s)"

fail=0
failed_list=""
total_sec=0
for f in $ALL; do
  base="$(basename "$f")"
  rc="$(cat "$OUT/$base.rc" 2>/dev/null || echo 99)"
  sec="$(cat "$OUT/$base.sec" 2>/dev/null || echo 0)"
  total_sec=$((total_sec + sec))
  echo "== $f == (${sec}s)"
  cat "$OUT/$base.log" 2>/dev/null
  if [ "$rc" != 0 ]; then
    fail=1
    failed_list="$failed_list $f"
    echo "!! $f exited $rc"
  fi
done

echo
echo "python tests: $(echo "$ALL" | wc -l | tr -d ' ') file(s), $JOBS job(s), wall $((T1 - T0))s, sum of the tests ${total_sec}s"
if [ "$fail" != 0 ]; then
  echo "FAILED:$failed_list"
  exit 1
fi
echo "all passed"
exit 0
