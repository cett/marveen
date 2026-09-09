#!/bin/bash
# Contract tests for scripts/vault-file-materializer.sh.
# Run: bash scripts/__tests__/vault-file-materializer.test.sh
#
# Exercises the shell orchestration (env-var parsing, file/dir materialization,
# cleanup, signal forwarding, sync-back, malformed input) against a STUB
# vault-materialize.mjs -- the real one's get/set correctness (encryption,
# tenant scoping) is already covered by src/__tests__/vault.test.ts. This test
# owns the part vault.test.ts cannot: the bash 3.2 orchestration around it.

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Stub environment: a copy of the real wrapper alongside a flat-file stub of
# vault-materialize.mjs (no encryption, no keychain), so tests never touch the
# real vault.json / macOS Keychain.
STUB_DIR="$TMPDIR_BASE/stub"
mkdir -p "$STUB_DIR"
cp "$INSTALL_DIR/scripts/vault-file-materializer.sh" "$STUB_DIR/"
STORE="$TMPDIR_BASE/stub-store"
mkdir -p "$STORE"

cat > "$STUB_DIR/vault-materialize.mjs" << 'EOF'
#!/usr/bin/env node
// Test stub: flat files under STUB_VAULT_STORE instead of encrypted vault.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const store = process.env.STUB_VAULT_STORE
const [, , mode, vaultId] = process.argv
const path = join(store, vaultId + '.secret')
if (mode === 'get') {
  if (!existsSync(path)) { process.stderr.write('not found\n'); process.exit(1) }
  process.stdout.write(readFileSync(path, 'utf-8'))
} else if (mode === 'set') {
  const chunks = []
  process.stdin.on('data', c => chunks.push(c))
  process.stdin.on('end', () => { writeFileSync(path, Buffer.concat(chunks).toString('utf-8')); process.exit(0) })
} else {
  process.exit(1)
}
EOF
export STUB_VAULT_STORE="$STORE"

WRAPPER="$STUB_DIR/vault-file-materializer.sh"
seed_secret() { printf '%s' "$2" > "$STORE/$1.secret"; }
read_secret() { cat "$STORE/$1.secret" 2>/dev/null; }

echo "vault-file-materializer tests"
echo "============================="

# ---------------------------------------------------------------------------
# (a) mode=file -> env var becomes the materialized file's full path
# ---------------------------------------------------------------------------
echo ""
echo "(a) mode=file"
seed_secret "test-a" "content-a-123"
export CRED_A="vault-file:test-a:file:cred.json"
OUT_A="$("$WRAPPER" bash -c 'cat "$CRED_A"')"
[ "$OUT_A" = "content-a-123" ] && pass "mode=file: child reads materialized content" || fail "mode=file: got '$OUT_A'"
OUT_A_NAME="$("$WRAPPER" bash -c 'basename "$CRED_A"')"
[ "$OUT_A_NAME" = "cred.json" ] && pass "mode=file: filename preserved" || fail "mode=file: filename was '$OUT_A_NAME'"
unset CRED_A

# ---------------------------------------------------------------------------
# (b) mode=dir -> env var becomes the containing directory
# ---------------------------------------------------------------------------
echo ""
echo "(b) mode=dir"
seed_secret "test-b" "content-b-456"
export CRED_B="vault-file:test-b:dir:tok.json"
OUT_B="$("$WRAPPER" bash -c 'cat "$CRED_B/tok.json"')"
[ "$OUT_B" = "content-b-456" ] && pass "mode=dir: child reads file inside the exported dir" || fail "mode=dir: got '$OUT_B'"
unset CRED_B

# ---------------------------------------------------------------------------
# (c) cleanup -> temp dir removed after the child exits
# ---------------------------------------------------------------------------
echo ""
echo "(c) cleanup"
seed_secret "test-c" "content-c"
export CRED_C="vault-file:test-c:file:c.json"
CAPTURED_PATH="$TMPDIR_BASE/captured-path-c"
"$WRAPPER" bash -c 'echo "$CRED_C" > "'"$CAPTURED_PATH"'"'
P="$(cat "$CAPTURED_PATH")"
[ ! -e "$P" ] && pass "cleanup: materialized file removed after exit" || fail "cleanup: $P still exists"
[ ! -d "$(dirname "$P")" ] && pass "cleanup: temp dir removed after exit" || fail "cleanup: temp dir $(dirname "$P") still exists"
unset CRED_C

# ---------------------------------------------------------------------------
# (d) syncback -> content the child writes is persisted back to the vault
# ---------------------------------------------------------------------------
echo ""
echo "(d) syncback"
seed_secret "test-d" "original-content"
export CRED_D="vault-file:test-d:dir:tok.json:syncback"
"$WRAPPER" bash -c 'echo -n "refreshed-content" > "$CRED_D/tok.json"'
[ "$(read_secret test-d)" = "refreshed-content" ] && pass "syncback: refreshed content written back to vault" || fail "syncback: vault still has '$(read_secret test-d)'"
unset CRED_D

seed_secret "test-d2" "original-content-2"
export CRED_D2="vault-file:test-d2:dir:tok.json"
"$WRAPPER" bash -c 'echo -n "should-not-persist" > "$CRED_D2/tok.json"'
[ "$(read_secret test-d2)" = "original-content-2" ] && pass "no syncback flag: vault left untouched" || fail "no syncback flag: vault was modified to '$(read_secret test-d2)'"
unset CRED_D2

# ---------------------------------------------------------------------------
# (e) exit code propagation
# ---------------------------------------------------------------------------
echo ""
echo "(e) exit code propagation"
seed_secret "test-e" "x"
export CRED_E="vault-file:test-e:file:x.json"
"$WRAPPER" bash -c 'exit 7'
[ "$?" = "7" ] && pass "exit code: child's exit status propagated" || fail "exit code: got $?"
unset CRED_E

# ---------------------------------------------------------------------------
# (f) malformed reference -> exit 1, no partial temp dir left behind
# ---------------------------------------------------------------------------
echo ""
echo "(f) malformed reference"
export CRED_F="vault-file:test-f:file"   # missing filename field
BEFORE_COUNT=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'vault-file.*' 2>/dev/null | wc -l | tr -d ' ')
"$WRAPPER" bash -c 'echo should-not-run' > "$TMPDIR_BASE/f-out" 2>"$TMPDIR_BASE/f-err"
RC=$?
AFTER_COUNT=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'vault-file.*' 2>/dev/null | wc -l | tr -d ' ')
[ "$RC" = "1" ] && pass "malformed: exits 1" || fail "malformed: exit code $RC"
[ ! -s "$TMPDIR_BASE/f-out" ] && pass "malformed: child never ran" || fail "malformed: child ran anyway"
[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] && pass "malformed: no leaked temp dir" || fail "malformed: temp dir count changed ($BEFORE_COUNT -> $AFTER_COUNT)"
unset CRED_F

# ---------------------------------------------------------------------------
# (g) unknown vault id -> materialize failure exits 1, no partial temp dir
# ---------------------------------------------------------------------------
echo ""
echo "(g) unknown vault id"
export CRED_G="vault-file:does-not-exist:file:x.json"
"$WRAPPER" bash -c 'echo should-not-run' > "$TMPDIR_BASE/g-out" 2>/dev/null
RC=$?
[ "$RC" = "1" ] && pass "unknown id: exits 1" || fail "unknown id: exit code $RC"
[ ! -s "$TMPDIR_BASE/g-out" ] && pass "unknown id: child never ran" || fail "unknown id: child ran anyway"
unset CRED_G

# ---------------------------------------------------------------------------
# (h) SIGTERM -> forwarded to the child, wrapper waits for real exit before
#     cleanup (does not delete the temp dir out from under a still-running
#     child, and does not report a false-early exit code)
# ---------------------------------------------------------------------------
echo ""
echo "(h) SIGTERM forwarding"
seed_secret "test-h" "x"
export CRED_H="vault-file:test-h:dir:tok.json:syncback"
MARKER="$TMPDIR_BASE/h-marker"
CHILD_SCRIPT="$TMPDIR_BASE/h-child.sh"
cat > "$CHILD_SCRIPT" << EOF
#!/bin/bash
trap 'echo -n "graceful" > "$CHILD_SCRIPT.marker"; echo -n "written-on-shutdown" > "\$CRED_H/tok.json"; exit 0' TERM
sleep 30
EOF
chmod +x "$CHILD_SCRIPT"
"$WRAPPER" "$CHILD_SCRIPT" &
WPID=$!
sleep 1
kill -TERM "$WPID"
wait "$WPID"
WRC=$?
[ "$WRC" = "0" ] && pass "SIGTERM: wrapper reports the child's OWN graceful exit code, not a synthetic 143" || fail "SIGTERM: wrapper exit code $WRC"
[ -f "$CHILD_SCRIPT.marker" ] && pass "SIGTERM: child's own trap ran (signal was forwarded)" || fail "SIGTERM: child never saw the signal"
[ "$(read_secret test-h)" = "written-on-shutdown" ] && pass "SIGTERM: syncback captured the shutdown-time write" || fail "SIGTERM: vault has '$(read_secret test-h)'"
unset CRED_H

# ---------------------------------------------------------------------------
# (i) stdin forwarding -- a backgrounded child in a non-interactive shell gets
#     /dev/null as stdin by POSIX default unless the wrapper explicitly ties
#     it back to its own stdin. A stdio MCP server (e.g. garmin-mcp) run
#     through this wrapper needs its JSON-RPC input on stdin or its login
#     hangs forever (#806).
# ---------------------------------------------------------------------------
echo ""
echo "(i) stdin forwarding"
seed_secret "test-i" "x"
export CRED_I="vault-file:test-i:file:x.json"
STDIN_OUT="$("$WRAPPER" bash -c 'cat' <<< "piped-stdin-content")"
[ "$STDIN_OUT" = "piped-stdin-content" ] && pass "stdin: child receives the wrapper's stdin" || fail "stdin: child got '$STDIN_OUT'"
unset CRED_I

# ---------------------------------------------------------------------------
echo ""
echo "============================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
