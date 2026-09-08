#!/bin/bash
# Contract tests for scripts/vault-inject-http-mcp.sh + vault-inject-http-mcp.mjs.
# Run: bash scripts/__tests__/vault-inject-http-mcp.test.sh
#
# Exercises the inject/restore round-trip against STUB dist/web/vault.js and
# dist/web/atomic-write.js modules (no encryption, no keychain, no real
# ~/.claude.json touched) -- the real vault.js get/set correctness is already
# covered by src/__tests__/vault.test.ts.

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Stub environment: a copy of the real scripts alongside stub dist/web/vault.js
# + dist/web/atomic-write.js, at the same relative layout the real scripts
# expect (projectRoot = <scripts-dir>/..).
STUB_DIR="$TMPDIR_BASE/stub"
mkdir -p "$STUB_DIR/scripts" "$STUB_DIR/dist/web"
cp "$INSTALL_DIR/scripts/vault-inject-http-mcp.sh" "$STUB_DIR/scripts/"
cp "$INSTALL_DIR/scripts/vault-inject-http-mcp.mjs" "$STUB_DIR/scripts/"

STORE="$TMPDIR_BASE/stub-store"
mkdir -p "$STORE"

cat > "$STUB_DIR/dist/web/vault.js" << 'EOF'
// Test stub: flat files under STUB_VAULT_STORE instead of encrypted vault.json.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export function getSecret(id) {
  const p = join(process.env.STUB_VAULT_STORE, id + '.secret')
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}
EOF

cat > "$STUB_DIR/dist/web/atomic-write.js" << 'EOF'
// Same tmp+rename strategy as src/web/atomic-write.ts, reimplemented here so
// the stub has no dependency on a built dist/ -- covered independently by
// src/__tests__/atomic-write-tmp-mode.test.ts.
import { writeFileSync, chmodSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
export function atomicWriteFileSync(path, data, opts = {}) {
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined)
  if (opts.mode !== undefined) { try { chmodSync(tmp, opts.mode) } catch {} }
  renameSync(tmp, path)
}
EOF

export STUB_VAULT_STORE="$STORE"
WRAPPER="$STUB_DIR/scripts/vault-inject-http-mcp.sh"
seed_secret() { printf '%s' "$2" > "$STORE/$1.secret"; }

echo "vault-inject-http-mcp tests"
echo "============================"

# ---------------------------------------------------------------------------
# (a) inject resolves vault: refs in headers; restore reverts + removes template
# ---------------------------------------------------------------------------
echo ""
echo "(a) inject + restore round-trip"
seed_secret "uptimerobot-UPTIMEROBOT_API_KEY" "real-token-abc123"
TARGET="$TMPDIR_BASE/a-claude.json"
cat > "$TARGET" << 'EOF'
{
  "mcpServers": {
    "uptimerobot": {
      "type": "http",
      "url": "https://example.invalid/mcp",
      "headers": { "Authorization": "Bearer vault:uptimerobot-UPTIMEROBOT_API_KEY" }
    }
  }
}
EOF
ORIGINAL_CONTENT="$(cat "$TARGET")"

"$WRAPPER" inject "$TARGET"
RC=$?
[ "$RC" = "0" ] && pass "inject: exits 0" || fail "inject: exit code $RC"
[ -f "$TARGET.vault-template" ] && pass "inject: template backup created" || fail "inject: no template backup"
grep -q "real-token-abc123" "$TARGET" && pass "inject: real secret written into target" || fail "inject: target missing resolved secret"
grep -q "vault:uptimerobot" "$TARGET" && fail "inject: target still contains a vault: reference" || pass "inject: no vault: reference left in target"
grep -q "vault:uptimerobot" "$TARGET.vault-template" && pass "inject: template still holds the vault: reference" || fail "inject: template lost its vault: reference"

"$WRAPPER" restore "$TARGET"
RC=$?
[ "$RC" = "0" ] && pass "restore: exits 0" || fail "restore: exit code $RC"
[ ! -f "$TARGET.vault-template" ] && pass "restore: template backup removed" || fail "restore: template backup still present"
grep -q "real-token-abc123" "$TARGET" && fail "restore: plaintext token still present after restore" || pass "restore: no plaintext token left in target"
[ "$(cat "$TARGET")" = "$ORIGINAL_CONTENT" ] && pass "restore: target byte-identical to original template" || fail "restore: target content diverged from original"

# ---------------------------------------------------------------------------
# (b) no vault: references in headers -> inject is a no-op
# ---------------------------------------------------------------------------
echo ""
echo "(b) no-op when nothing to inject"
TARGET_B="$TMPDIR_BASE/b-claude.json"
cat > "$TARGET_B" << 'EOF'
{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "server"] } } }
EOF
"$WRAPPER" inject "$TARGET_B"
[ ! -f "$TARGET_B.vault-template" ] && pass "no vault refs: no template created" || fail "no vault refs: template created anyway"

# ---------------------------------------------------------------------------
# (c) missing target file -> inject is a no-op, exit 0
# ---------------------------------------------------------------------------
echo ""
echo "(c) missing target file"
TARGET_C="$TMPDIR_BASE/does-not-exist.json"
"$WRAPPER" inject "$TARGET_C"
RC=$?
[ "$RC" = "0" ] && pass "missing target: exits 0" || fail "missing target: exit code $RC"
[ ! -f "$TARGET_C" ] && pass "missing target: not created as a side effect" || fail "missing target: file appeared"

# ---------------------------------------------------------------------------
# (d) unresolved vault id -> inject aborts, target AND template left untouched
# ---------------------------------------------------------------------------
echo ""
echo "(d) unresolved vault id"
TARGET_D="$TMPDIR_BASE/d-claude.json"
cat > "$TARGET_D" << 'EOF'
{ "mcpServers": { "x": { "type": "http", "url": "https://x.invalid", "headers": { "Authorization": "Bearer vault:does-not-exist-ANYTHING" } } } }
EOF
BEFORE_D="$(cat "$TARGET_D")"
"$WRAPPER" inject "$TARGET_D" 2>"$TMPDIR_BASE/d-err"
RC=$?
[ "$RC" != "0" ] && pass "unresolved id: nonzero exit" || fail "unresolved id: exit code $RC"
[ -s "$TMPDIR_BASE/d-err" ] && pass "unresolved id: error message printed" || fail "unresolved id: silent failure"
[ "$(cat "$TARGET_D")" = "$BEFORE_D" ] && pass "unresolved id: target left byte-identical" || fail "unresolved id: target was modified"
[ ! -f "$TARGET_D.vault-template" ] && pass "unresolved id: no template left behind" || fail "unresolved id: template created despite failure"

# ---------------------------------------------------------------------------
# (e) double inject is idempotent -- second call does not clobber the template
# ---------------------------------------------------------------------------
echo ""
echo "(e) idempotent double inject"
seed_secret "svc-KEY" "token-1"
TARGET_E="$TMPDIR_BASE/e-claude.json"
cat > "$TARGET_E" << 'EOF'
{ "mcpServers": { "svc": { "type": "http", "url": "https://svc.invalid", "headers": { "Authorization": "Bearer vault:svc-KEY" } } } }
EOF
"$WRAPPER" inject "$TARGET_E"
TEMPLATE_AFTER_FIRST="$(cat "$TARGET_E.vault-template")"
"$WRAPPER" inject "$TARGET_E" 2>/dev/null
RC=$?
[ "$RC" = "0" ] && pass "double inject: second call still exits 0" || fail "double inject: exit code $RC"
[ "$(cat "$TARGET_E.vault-template")" = "$TEMPLATE_AFTER_FIRST" ] && pass "double inject: template unchanged by second call" || fail "double inject: template was overwritten"
grep -q "token-1" "$TARGET_E" && pass "double inject: target still resolved" || fail "double inject: target lost its resolved secret"

# ---------------------------------------------------------------------------
# (f) restore with no template present -> no-op, target unchanged
# ---------------------------------------------------------------------------
echo ""
echo "(f) restore with nothing to restore"
TARGET_F="$TMPDIR_BASE/f-claude.json"
echo '{"mcpServers":{}}' > "$TARGET_F"
BEFORE_F="$(cat "$TARGET_F")"
"$WRAPPER" restore "$TARGET_F"
RC=$?
[ "$RC" = "0" ] && pass "restore no-op: exits 0" || fail "restore no-op: exit code $RC"
[ "$(cat "$TARGET_F")" = "$BEFORE_F" ] && pass "restore no-op: target unchanged" || fail "restore no-op: target was modified"

# ---------------------------------------------------------------------------
# (g) scope discipline: a vault: reference OUTSIDE mcpServers.*.headers (e.g.
#     a stdio server's env, already vault-env-wrapper.sh's job) is left alone
# ---------------------------------------------------------------------------
echo ""
echo "(g) scope: only mcpServers.*.headers.* is touched"
seed_secret "http-KEY" "http-secret"
TARGET_G="$TMPDIR_BASE/g-claude.json"
cat > "$TARGET_G" << 'EOF'
{
  "mcpServers": {
    "stdio-svc": { "command": "npx", "args": ["-y", "server"], "env": { "TOKEN": "vault:should-not-be-touched" } },
    "http-svc": { "type": "http", "url": "https://h.invalid", "headers": { "Authorization": "Bearer vault:http-KEY" } }
  }
}
EOF
"$WRAPPER" inject "$TARGET_G"
grep -q "vault:should-not-be-touched" "$TARGET_G" && pass "scope: stdio env: reference left untouched" || fail "scope: stdio env: reference was resolved (out of scope)"
grep -q "http-secret" "$TARGET_G" && pass "scope: http headers: reference resolved" || fail "scope: http headers: reference not resolved"

# ---------------------------------------------------------------------------
echo ""
echo "============================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
