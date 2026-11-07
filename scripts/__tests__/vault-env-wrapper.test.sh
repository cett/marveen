#!/bin/bash
# Contract tests for scripts/vault-env-wrapper.sh: which env values it hands to the resolver.
# Run: bash scripts/__tests__/vault-env-wrapper.test.sh
#
# The wrapper is copied next to a STUB vault-resolve.mjs (it records what it is given on stdin and answers
# NAME=RESOLVED(id)), at the layout the wrapper expects (project root = <scripts-dir>/..). No real vault, no
# Keychain, no real secret is touched; the real resolver is covered by the vault tests.
#
# The wrapper is started through its shebang (/bin/bash, 3.2 on macOS), so the same file is exercised by the
# bash the production launcher uses.

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

STUB_DIR="$TMPDIR_BASE/stub"
mkdir -p "$STUB_DIR/scripts"
cp "$INSTALL_DIR/scripts/vault-env-wrapper.sh" "$STUB_DIR/scripts/"
cat > "$STUB_DIR/scripts/vault-resolve.mjs" << 'EOF'
// Test stub of the resolver: records its stdin, answers NAME=RESOLVED(id) per line (the real one splits on the
// first "=", line by line, exactly like this).
import { appendFileSync } from 'node:fs'
let data = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', c => { data += c })
process.stdin.on('end', () => {
  appendFileSync(process.env.STUB_LOG, data)
  for (const line of data.trim().split('\n')) {
    if (!line.trim()) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    process.stdout.write(`${line.slice(0, eq)}=RESOLVED(${line.slice(eq + 1)})\n`)
  }
})
EOF
WRAPPER="$STUB_DIR/scripts/vault-env-wrapper.sh"

# The command the wrapper execs: writes every variable it can see (of the names below) to $OUT/NAME, byte for
# byte, so a value with a newline can be compared exactly. A variable that is unset gets no file.
PROBE='for n in A B C Y Z PLAIN PLAIN2; do if [ -n "${!n+x}" ]; then printf "%s" "${!n}" > "$OUT/$n"; fi; done; : > "$OUT/.ran"'

CASE=0
# run_case NAME=VALUE ...: runs the wrapper with exactly those variables, leaves OUT (probe files), LOG (what the
# resolver got) and ERR (the wrapper's stderr) set for the checks, and RC.
run_case() {
  CASE=$((CASE + 1))
  OUT="$TMPDIR_BASE/case$CASE.out"; LOG="$TMPDIR_BASE/case$CASE.log"; ERR="$TMPDIR_BASE/case$CASE.err"
  mkdir -p "$OUT"; : > "$LOG"
  env -i PATH="$PATH" OUT="$OUT" STUB_LOG="$LOG" "$@" "$WRAPPER" bash -c "$PROBE" 2> "$ERR"
  RC=$?
}
val() { cat "$OUT/$1" 2>/dev/null; }
unset_var() { [ ! -e "$OUT/$1" ]; }

echo "vault-env-wrapper tests"
echo "============================"

# ---------------------------------------------------------------------------
echo ""
echo "T1 a canonical reference is resolved"
run_case A=vault:okid
[ "$RC" = "0" ] && pass "exits 0, the command ran" || fail "exit code $RC"
[ "$(val A)" = "RESOLVED(okid)" ] && pass "A is resolved" || fail "A is '$(val A)'"
[ "$(cat "$LOG")" = "A=okid" ] && pass "the resolver got exactly one line, A=okid" || fail "the resolver got '$(cat "$LOG")'"
unset_var Z && pass "no other variable appears" || fail "Z appeared"
[ ! -s "$ERR" ] && pass "no warning for a good reference" || fail "unexpected stderr: $(cat "$ERR")"

# ---------------------------------------------------------------------------
echo ""
echo "T2 a value with a newline cannot put an extra line to the resolver"
run_case A=$'vault:okid\nZ=other-secret-id'
[ "$RC" = "0" ] && [ -e "$OUT/.ran" ] && pass "the command still runs (exec reached)" || fail "exit code $RC / command did not run"
unset_var Z && pass "Z is not resolved (not even set)" || fail "Z was injected: $(val Z)"
[ "$(val A)" = "$(printf 'vault:okid\nZ=other-secret-id')" ] && pass "A keeps its original value, unresolved" || fail "A changed: '$(val A)'"
grep -q "other-secret-id" "$LOG" && fail "the resolver was handed the injected id" || pass "the resolver never saw the injected id"
grep -q ": A skipped" "$ERR" && pass "a warning names the variable A" || fail "no warning on stderr"

# ---------------------------------------------------------------------------
echo ""
echo "T3 a second line that looks like a reference does not crash the wrapper"
run_case A=$'vault:okid\nY=vault:other'
[ "$RC" = "0" ] && [ -e "$OUT/.ran" ] && pass "no crash, the command ran" || fail "exit code $RC (unbound variable?) / command did not run"
unset_var Y && pass "Y is not set" || fail "Y appeared"
[ "$(val A)" = "$(printf 'vault:okid\nY=vault:other')" ] && pass "A left unresolved" || fail "A is '$(val A)'"
grep -q ": A skipped" "$ERR" && pass "a warning names the variable A" || fail "no warning on stderr"
[ ! -s "$LOG" ] && pass "the resolver got nothing" || fail "the resolver got '$(cat "$LOG")'"

# ---------------------------------------------------------------------------
echo ""
echo "T4 a non-canonical id is skipped with a warning, the value stays as it was"
check_skipped() { # label, value
  run_case A="$2"
  [ "$RC" = "0" ] && [ -e "$OUT/.ran" ] && pass "$1: command ran, exit 0" || fail "$1: exit code $RC / did not run"
  printf '%s' "$2" | cmp -s - "$OUT/A" && pass "$1: A unchanged (byte for byte)" || fail "$1: A changed or unset"
  [ ! -s "$LOG" ] && pass "$1: the resolver got nothing" || fail "$1: the resolver got '$(cat "$LOG")'"
  grep -q ": A skipped" "$ERR" && pass "$1: warning on stderr" || fail "$1: no warning on stderr"
}
check_skipped "space" "vault:has space"
check_skipped "semicolon" "vault:a;b"
check_skipped "command substitution" 'vault:$(touch '"$TMPDIR_BASE"'/pwned)'
[ ! -e "$TMPDIR_BASE/pwned" ] && pass "command substitution: nothing was executed" || fail "command substitution: the substitution ran"
check_skipped "slash" "vault:a/b"
check_skipped "empty id" "vault:"
check_skipped "trailing newline" $'vault:okid\n'
check_skipped "non-ASCII letter" "vault:caf$(printf '\303\251')"
check_skipped "channel-token style id (colon)" "vault:channel-token:agent-a"

# ---------------------------------------------------------------------------
echo ""
echo "T5 the length limit: 128 characters resolve, 129 do not"
ID128="$(printf 'a%.0s' $(seq 1 128))"
ID129="${ID128}a"
run_case A="vault:$ID128"
[ "$(val A)" = "RESOLVED($ID128)" ] && pass "128 characters: resolved" || fail "128 characters: A is '$(val A | cut -c1-30)'"
run_case A="vault:$ID129"
[ "$(val A)" = "vault:$ID129" ] && pass "129 characters: left unresolved" || fail "129 characters: A is '$(val A | cut -c1-30)'"
[ -s "$ERR" ] && pass "129 characters: warning" || fail "129 characters: no warning"
run_case A="vault:a.B_c-9"
[ "$(val A)" = "RESOLVED(a.B_c-9)" ] && pass "the whole allowed character set resolves (letters, digits, dot, underscore, hyphen)" || fail "allowed set: A is '$(val A)'"

# ---------------------------------------------------------------------------
echo ""
echo "T6 several valid references are all resolved in one go"
run_case A=vault:id-a B=vault:id-b C=vault:id-c
[ "$(val A)" = "RESOLVED(id-a)" ] && [ "$(val B)" = "RESOLVED(id-b)" ] && [ "$(val C)" = "RESOLVED(id-c)" ] && pass "A, B and C are resolved" || fail "A='$(val A)' B='$(val B)' C='$(val C)'"
[ "$(sort "$LOG" | tr '\n' ' ')" = "A=id-a B=id-b C=id-c " ] && pass "the resolver got exactly those three lines" || fail "the resolver got '$(cat "$LOG" | tr '\n' ' ')'"
run_case A=vault:id-a B="vault:bad id" C=vault:id-c
[ "$(val A)" = "RESOLVED(id-a)" ] && [ "$(val C)" = "RESOLVED(id-c)" ] && [ "$(val B)" = "vault:bad id" ] && pass "one bad reference does not stop the good ones" || fail "A='$(val A)' B='$(val B)' C='$(val C)'"

# ---------------------------------------------------------------------------
echo ""
echo "T7 an env value that is not a vault reference is untouched"
run_case PLAIN=hello PLAIN2="see vault:okid inside" A=vault:okid
[ "$(val PLAIN)" = "hello" ] && pass "PLAIN untouched" || fail "PLAIN is '$(val PLAIN)'"
[ "$(val PLAIN2)" = "see vault:okid inside" ] && pass "a value that only contains vault: is untouched" || fail "PLAIN2 is '$(val PLAIN2)'"
[ "$(cat "$LOG")" = "A=okid" ] && pass "only A went to the resolver" || fail "the resolver got '$(cat "$LOG")'"
[ ! -s "$ERR" ] && pass "no warning for non-references" || fail "unexpected stderr: $(cat "$ERR")"
run_case PLAIN=hello
[ "$RC" = "0" ] && [ "$(val PLAIN)" = "hello" ] && [ ! -s "$LOG" ] && pass "no reference at all: the resolver is not called" || fail "RC=$RC LOG='$(cat "$LOG")'"

# ---------------------------------------------------------------------------
echo ""
echo "T8 the warning carries the variable name, never the value"
run_case A=$'vault:okid\nZ=SECRETMARK-one' B="vault:bad;SECRETMARK-two" C='vault:$(SECRETMARK-three)'
[ "$RC" = "0" ] && pass "exits 0" || fail "exit code $RC"
grep -q "SECRETMARK" "$ERR" && fail "stderr contains a value: $(cat "$ERR")" || pass "stderr has no part of any value"
grep -q "okid" "$ERR" && fail "stderr contains an id" || pass "stderr has no id"
for n in A B C; do grep -q ": $n skipped" "$ERR" && pass "the warning names $n" || fail "no warning names $n"; done

# ---------------------------------------------------------------------------
echo ""
echo "T9 an exported name that is not a shell identifier is never handed on (it could not be exported back anyway)"
run_case 'a-b=vault:okid' 'X.Y=vault:okid' A=vault:okid
[ "$RC" = "0" ] && [ -e "$OUT/.ran" ] && pass "the command ran, exit 0" || fail "exit code $RC / command did not run"
[ "$(cat "$LOG")" = "A=okid" ] && pass "only the valid name reached the resolver" || fail "the resolver got '$(cat "$LOG" | tr '\n' ' ')'"
[ "$(val A)" = "RESOLVED(okid)" ] && pass "A is resolved" || fail "A is '$(val A)'"

# ---------------------------------------------------------------------------
echo ""
echo "============================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
