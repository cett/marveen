#!/bin/bash
# scripts/backup.sh coverage contract: the encrypted vault and every agent's
# memory must be in the archive, and the vault master key must NOT be -- it goes
# to a separate 0600 sidecar file. Run: bash scripts/__tests__/backup-vault-memory.test.sh
#
# The Keychain is always stubbed (BACKUP_SECURITY_BIN) and HOME is a temp dir, so
# this never touches the real keychain or the real store/.

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
KEY_VALUE="dGVzdC1tYXN0ZXIta2V5LW5vdC1yZWFs"   # fake base64, not a real key

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }  # GNU first: on Linux `stat -f` exits 0 with filesystem info

# new_repo <name>: a fake install with vault + memory in every location, plus decoys.
new_repo() {
  local r="$TMPDIR_BASE/$1"
  mkdir -p "$r/scripts" "$r/store" "$TMPDIR_BASE/home-$1"
  cp "$INSTALL_DIR/scripts/backup.sh" "$INSTALL_DIR/scripts/verify-restore.sh" "$r/scripts/"
  echo '[{"id":"x","encrypted":"ZW5jcnlwdGVk"}]' > "$r/store/vault.json"; chmod 600 "$r/store/vault.json"
  if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$r/store/claudeclaw.db" 'CREATE TABLE t(x);'; fi
  mkdir -p "$r/agents/zed/memory" "$r/agents/zed/.claude-config/projects/-p1/memory" \
           "$r/agents/zed/src/memory" "$r/agents/zed/a/b/c/memory" "$r/agents/zed/.claude-config/projects/-p1/sessions" \
           "$r/.channels-config/projects/-p2/memory" "$r/.channels-config/projects/-p2/sessions"
  echo agent-memory   > "$r/agents/zed/memory/a.md"
  echo auto-memory    > "$r/agents/zed/.claude-config/projects/-p1/memory/b.md"
  echo main-memory    > "$r/.channels-config/projects/-p2/memory/c.md"
  echo decoy-src      > "$r/agents/zed/src/memory/decoy.md"
  echo decoy-depth5   > "$r/agents/zed/a/b/c/memory/decoy5.md"
  echo decoy-session  > "$r/agents/zed/.claude-config/projects/-p1/sessions/s.jsonl"
  echo decoy-session2 > "$r/.channels-config/projects/-p2/sessions/s.jsonl"
  # The live-install shape: several agents whose .claude-config/projects is a
  # symlink to the ONE shared $HOME/.claude/projects.
  local h="$TMPDIR_BASE/home-$1"
  mkdir -p "$h/.claude/projects/-p3/memory" "$h/.claude/projects/-p3/sessions" "$r/agents/zed2/.claude-config" "$r/agents/zed3/.claude-config"
  echo shared-memory  > "$h/.claude/projects/-p3/memory/d.md"
  echo decoy-session3 > "$h/.claude/projects/-p3/sessions/s.jsonl"
  ln -s "$h/.claude/projects" "$r/agents/zed2/.claude-config/projects"
  ln -s "$h/.claude/projects" "$r/agents/zed3/.claude-config/projects"
  echo "$r"
}

# stub_security <file> <mode>: ok | notfound | hang | partial
stub_security() {
  case "$2" in
    ok)       printf '#!/bin/bash\necho "%s"\n' "$KEY_VALUE" > "$1" ;;
    notfound) printf '#!/bin/bash\nexit 44\n' > "$1" ;;
    hang)     printf '#!/bin/bash\nexec sleep 60\n' > "$1" ;;
    partial)  printf '#!/bin/bash\necho "%s"\nexit 36\n' "$KEY_VALUE" > "$1" ;;   # prints a value, then fails
  esac
  chmod +x "$1"
}

run_backup() {  # run_backup <repo> <stub> [extra env...]; sets OUT, ERR, RC
  local r="$1" stub="$2"; shift 2
  OUT="$TMPDIR_BASE/out.txt"; ERR="$TMPDIR_BASE/err.txt"
  env HOME="$TMPDIR_BASE/home-$(basename "$r")" BACKUP_SECURITY_BIN="$stub" "$@" \
    bash "$r/scripts/backup.sh" >"$OUT" 2>"$ERR"; RC=$?
}
archive_of() { ls -1t "$1"/backups/claudeclaw-*.tar.gz | head -1; }
listing_has() { tar -tzf "$1" | grep -qE "$2"; }

echo "backup.sh vault + memory coverage"
echo "================================="

# ---------------------------------------------------------------------------
echo ""; echo "(a) Keychain key: vault + all memory in, key separate"
R="$(new_repo a)"; stub_security "$TMPDIR_BASE/sec-ok" ok
run_backup "$R" "$TMPDIR_BASE/sec-ok"
A="$(archive_of "$R")"; SIDE="${A%.tar.gz}.vault-key"
[ "$RC" -eq 0 ] && pass "backup exits 0" || fail "backup exit code $RC: $(cat "$ERR")"
listing_has "$A" '^repo/store/vault\.json$' && pass "store/vault.json is archived" || fail "store/vault.json missing"
listing_has "$A" '^repo/agents/zed/memory/a\.md$' && pass "agents/*/memory archived" || fail "agents/*/memory missing"
listing_has "$A" '^repo/agents/zed/\.claude-config/projects/-p1/memory/b\.md$' && pass "agents/*/.claude-config/projects/*/memory archived" || fail "agent auto-memory missing"
listing_has "$A" '^repo/\.channels-config/projects/-p2/memory/c\.md$' && pass ".channels-config/projects/*/memory archived" || fail ".channels-config memory missing"
listing_has "$A" '^home/\.claude/projects/-p3/memory/d\.md$' && pass "symlinked projects/*/memory archived from its real home location" || fail "symlinked auto-memory missing"
[ "$(tar -tzf "$A" | grep -c 'd\.md$')" -eq 1 ] && pass "shared memory stored once (symlinks deduped)" || fail "shared memory duplicated: $(tar -tzf "$A" | grep 'd\.md$')"
if tar -tzf "$A" | grep -qE '^repo/agents/zed[23]/\.claude-config'; then fail "symlinked projects dir copied under repo/"; else pass "symlinked projects dirs not copied under repo/"; fi
if listing_has "$A" 'decoy'; then fail "decoy path (deeper memory dir / sessions) swept in"; else pass "depth-pinned: decoys not archived"; fi
if listing_has "$A" '(^|/)\.vault-key'; then fail "vault key file inside the archive"; else pass "no .vault-key* inside the archive"; fi
X="$TMPDIR_BASE/x-a"; mkdir -p "$X"; tar -xpzf "$A" -C "$X"
if grep -rqF "$KEY_VALUE" "$X"; then fail "key value found inside the archive contents"; else pass "key value absent from archive contents"; fi
[ "$(mode_of "$X/repo/store/vault.json")" = "600" ] && pass "vault.json keeps mode 0600 in the archive" || fail "vault.json mode changed"
[ -f "$SIDE" ] && [ "$(cat "$SIDE")" = "$KEY_VALUE" ] && pass "key sidecar holds the Keychain key" || fail "key sidecar missing/wrong"
[ "$(mode_of "$SIDE")" = "600" ] && pass "key sidecar is 0600" || fail "key sidecar mode $(mode_of "$SIDE")"
grep -qF "$KEY_VALUE" "$OUT" "$ERR" && fail "key value leaked to stdout/stderr" || pass "key value not printed"
[ "$(grep -c 'home/\.claude/projects/-p3/memory$' "$X/MANIFEST.txt")" -eq 1 ] && pass "shared memory dir listed once in the manifest (deduped before copy)" || fail "shared memory dir listed $(grep -c 'projects/-p3/memory$' "$X/MANIFEST.txt")x in the manifest"
grep -q 'vault key: separate file' "$X/MANIFEST.txt" && pass "MANIFEST documents the separate key file" || fail "MANIFEST lacks key note"

# ---------------------------------------------------------------------------
echo ""; echo "(b) verify-restore.sh"
if command -v sqlite3 >/dev/null 2>&1; then
  VOUT="$(bash "$R/scripts/verify-restore.sh" "$A" 2>&1)"; VRC=$?
  [ "$VRC" -eq 0 ] && pass "verify-restore passes a healthy archive" || fail "verify-restore rc=$VRC: $VOUT"
  echo "$VOUT" | grep -q 'vault key sidecar present' && pass "verify-restore sees the key sidecar" || fail "no sidecar line in verify output"
  mv "$SIDE" "$SIDE.moved"
  VOUT="$(bash "$R/scripts/verify-restore.sh" "$A" 2>&1)"; VRC=$?
  [ "$VRC" -eq 0 ] && echo "$VOUT" | grep -q '\[WARN\] vault.json is archived' && pass "missing sidecar is a WARN, not a FAIL" || fail "missing-sidecar handling wrong (rc=$VRC)"
  mv "$SIDE.moved" "$SIDE"
  # Craft a bad archive that carries the key inside.
  BAD="$TMPDIR_BASE/bad"; mkdir -p "$BAD/repo/store"; cp "$R/store/claudeclaw.db" "$BAD/repo/store/"; echo "$KEY_VALUE" > "$BAD/repo/store/.vault-key"; echo m > "$BAD/MANIFEST.txt"
  ( cd "$BAD" && tar -czf "$R/backups/claudeclaw-20200101-000000.tar.gz" MANIFEST.txt repo )
  VOUT="$(bash "$R/scripts/verify-restore.sh" "$R/backups/claudeclaw-20200101-000000.tar.gz" 2>&1)"; VRC=$?
  [ "$VRC" -eq 1 ] && echo "$VOUT" | grep -q 'INSIDE the archive' && pass "verify-restore FAILS when the key is inside the archive" || fail "key-in-archive not caught (rc=$VRC)"
  rm -f "$R/backups/claudeclaw-20200101-000000.tar.gz"
  # Same, but the archived key is the .migrated variant (the regex's optional half).
  BADM="$TMPDIR_BASE/badm"; mkdir -p "$BADM/repo/store"; cp "$R/store/claudeclaw.db" "$BADM/repo/store/"; echo "$KEY_VALUE" > "$BADM/repo/store/.vault-key.migrated"; echo m > "$BADM/MANIFEST.txt"
  ( cd "$BADM" && tar -czf "$R/backups/claudeclaw-20200101-000001.tar.gz" MANIFEST.txt repo )
  VOUT="$(bash "$R/scripts/verify-restore.sh" "$R/backups/claudeclaw-20200101-000001.tar.gz" 2>&1)"; VRC=$?
  [ "$VRC" -eq 1 ] && echo "$VOUT" | grep -q 'INSIDE the archive' && pass "verify-restore FAILS when .vault-key.migrated is inside the archive" || fail ".vault-key.migrated in archive not caught (rc=$VRC)"
  rm -f "$R/backups/claudeclaw-20200101-000001.tar.gz"
  # Regression: printf|grep -q under pipefail = SIGPIPE false negative once the
  # listing exceeds the pipe buffer. Pad the listing to >200 KB and put the
  # sentinels/key at the very START, so grep -q exits long before the writer is done.
  BIG="$TMPDIR_BASE/big"; mkdir -p "$BIG/repo/store" "$BIG/repo/pad"; cp "$R/store/claudeclaw.db" "$BIG/repo/store/"
  echo "$KEY_VALUE" > "$BIG/repo/store/.vault-key"; echo '[]' > "$BIG/repo/store/vault.json"; echo m > "$BIG/MANIFEST.txt"
  ( cd "$BIG/repo/pad" && for i in $(seq 1 3000); do : > "padding-file-with-a-fairly-long-name-to-inflate-the-listing-$i.txt"; done )
  BIGA="$R/backups/claudeclaw-20200101-000002.tar.gz"
  ( cd "$BIG" && tar -czf "$BIGA" MANIFEST.txt repo/store repo/pad )
  [ "$(tar -tzf "$BIGA" | wc -c)" -gt 200000 ] && pass "padded listing is >200 KB" || fail "padded listing too small to exercise the pipe buffer"
  VOUT="$(bash "$R/scripts/verify-restore.sh" "$BIGA" 2>&1)"; VRC=$?
  [ "$VRC" -eq 1 ] && echo "$VOUT" | grep -q 'INSIDE the archive' && pass "verify-restore FAILS on a key inside a >200 KB listing (no SIGPIPE false negative)" || fail "large-listing key-in-archive missed (rc=$VRC)"
  echo "$VOUT" | grep -q 'vault key sidecar present\|\[WARN\] vault.json is archived' && pass "vault.json detected in a >200 KB listing" || fail "vault.json missed in a large listing"
  echo "$VOUT" | grep -q 'MANIFEST.txt present' && echo "$VOUT" | grep -q 'repo/store/claudeclaw.db present' && pass "required sentinels found in a >200 KB listing" || fail "sentinel false FAIL in a large listing"
  rm -f "$BIGA"
else
  echo "  SKIP: sqlite3 not installed"
fi

# ---------------------------------------------------------------------------
echo ""; echo "(c) Keychain empty -> falls back to store/.vault-key"
R="$(new_repo c)"; stub_security "$TMPDIR_BASE/sec-nf" notfound
echo "  $KEY_VALUE  " > "$R/store/.vault-key"; chmod 600 "$R/store/.vault-key"
run_backup "$R" "$TMPDIR_BASE/sec-nf"
A="$(archive_of "$R")"; SIDE="${A%.tar.gz}.vault-key"
[ -f "$SIDE" ] && [ "$(cat "$SIDE")" = "$KEY_VALUE" ] && pass "sidecar built from store/.vault-key (whitespace trimmed)" || fail "fallback key wrong"
if listing_has "$A" '(^|/)\.vault-key'; then fail "store/.vault-key leaked into the archive"; else pass "store/.vault-key not in the archive"; fi

echo ""; echo "(d) only store/.vault-key.migrated left -> last resort with warning"
R="$(new_repo d)"; echo "$KEY_VALUE" > "$R/store/.vault-key.migrated"
run_backup "$R" "$TMPDIR_BASE/sec-nf"
A="$(archive_of "$R")"; SIDE="${A%.tar.gz}.vault-key"
[ -f "$SIDE" ] && grep -q 'taken from store/.vault-key.migrated' "$ERR" && pass "migrated key used, with a warning" || fail "migrated-key fallback wrong"
if listing_has "$A" '(^|/)\.vault-key'; then fail ".vault-key.migrated leaked into the archive"; else pass ".vault-key.migrated not in the archive"; fi

echo ""; echo "(e) no key anywhere -> loud warning, backup still completes, no sidecar"
R="$(new_repo e)"
run_backup "$R" "$TMPDIR_BASE/sec-nf"
A="$(archive_of "$R")"
[ "$RC" -eq 0 ] && pass "backup still exits 0" || fail "exit $RC"
grep -q 'NO vault master key was found' "$ERR" && pass "loud warning on stderr" || fail "no warning"
ls "$R"/backups/*.vault-key >/dev/null 2>&1 && fail "sidecar written without a key" || pass "no sidecar written"
tar -xOzf "$A" MANIFEST.txt | grep -q 'NOT AVAILABLE' && pass "MANIFEST says the key was unavailable" || fail "MANIFEST silent about missing key"

echo ""; echo "(f) no vault.json -> no key handling at all"
R="$(new_repo f)"; rm -f "$R/store/vault.json"
run_backup "$R" "$TMPDIR_BASE/sec-ok"
ls "$R"/backups/*.vault-key >/dev/null 2>&1 && fail "sidecar written without a vault" || pass "no sidecar without vault.json"
grep -q 'vault' "$ERR" && fail "vault warning on a vault-less install: $(cat "$ERR")" || pass "no vault warning on a vault-less install"

echo ""; echo "(g) hanging keychain does not hang the backup"
R="$(new_repo g)"; stub_security "$TMPDIR_BASE/sec-hang" hang
START=$SECONDS
run_backup "$R" "$TMPDIR_BASE/sec-hang"
ELAPSED=$((SECONDS - START))
[ "$RC" -eq 0 ] && [ "$ELAPSED" -lt 25 ] && pass "finished in ${ELAPSED}s despite a hung keychain" || fail "rc=$RC elapsed=${ELAPSED}s"
grep -q 'NO vault master key was found' "$ERR" && pass "hung keychain reported as no key" || fail "hung keychain not reported"

echo ""; echo "(h) retention prunes the key sidecar with its archive"
R="$(new_repo h)"; stub_security "$TMPDIR_BASE/sec-ok" ok
run_backup "$R" "$TMPDIR_BASE/sec-ok" BACKUP_KEEP=1
OLD="$(archive_of "$R")"; sleep 1.1
run_backup "$R" "$TMPDIR_BASE/sec-ok" BACKUP_KEEP=1
NEW="$(archive_of "$R")"
[ "$OLD" != "$NEW" ] && [ ! -e "$OLD" ] && [ ! -e "${OLD%.tar.gz}.vault-key" ] && [ -f "${NEW%.tar.gz}.vault-key" ] \
  && pass "old archive AND its key sidecar pruned, newest kept" || fail "prune left/lost files: $(ls "$R/backups")"

echo ""; echo "(j) no symlinks at all: \$HOME/.claude/projects/*/memory is still picked up"
R="$(new_repo j)"; rm -f "$R/agents/zed2/.claude-config/projects" "$R/agents/zed3/.claude-config/projects"
run_backup "$R" "$TMPDIR_BASE/sec-ok"
A="$(archive_of "$R")"
listing_has "$A" '^home/\.claude/projects/-p3/memory/d\.md$' && pass "home auto-memory archived without any symlink" || fail "home auto-memory missing"

echo ""; echo "(k) keychain prints a value but exits non-zero -> value discarded"
R="$(new_repo k)"; stub_security "$TMPDIR_BASE/sec-partial" partial
run_backup "$R" "$TMPDIR_BASE/sec-partial"
ls "$R"/backups/*.vault-key >/dev/null 2>&1 && fail "sidecar written from a failed keychain read" || pass "no sidecar from a non-zero keychain rc"
grep -q 'NO vault master key was found' "$ERR" && pass "failed keychain read reported as no key" || fail "failed keychain read not reported"
echo "  $KEY_VALUE" > "$R/store/.vault-key"; chmod 600 "$R/store/.vault-key"
sleep 1.1   # archive names are per-second; keep the two runs apart
run_backup "$R" "$TMPDIR_BASE/sec-partial"
A="$(archive_of "$R")"
[ -f "${A%.tar.gz}.vault-key" ] && [ "$(cat "${A%.tar.gz}.vault-key")" = "$KEY_VALUE" ] && tar -xOzf "$A" MANIFEST.txt | grep -q 'source: store/.vault-key' && pass "falls through to store/.vault-key after a failed keychain read" || fail "no fallback after failed keychain read"

echo ""; echo "(l) restore instructions keep the key off argv"
if grep -rnE 'add-generic-password[^`]*-w[[:space:]]+"?\$\(' "$INSTALL_DIR/scripts/backup.sh" "$INSTALL_DIR/docs/fork-guide" >/dev/null; then fail "a restore doc still passes the key via -w \"\$(cat ...)\""; else pass "no doc/header passes the key as a -w argument"; fi

echo ""; echo "(i) contract with the app's keychain module and no baked-in paths"
SVC="$(grep -oE "SERVICE = '[^']+'" "$INSTALL_DIR/src/web/keychain.ts" | sed -E "s/.*'(.*)'/\1/")"
ACC="$(grep -oE "ACCOUNT = '[^']+'" "$INSTALL_DIR/src/web/keychain.ts" | sed -E "s/.*'(.*)'/\1/")"
grep -qF "KEYCHAIN_SERVICE=\"$SVC\"" "$INSTALL_DIR/scripts/backup.sh" && grep -qF "KEYCHAIN_ACCOUNT=\"$ACC\"" "$INSTALL_DIR/scripts/backup.sh" \
  && pass "keychain service/account match src/web/keychain.ts ($SVC / $ACC)" || fail "backup.sh keychain item drifted from src/web/keychain.ts"
if grep -qE '/Users/|/home/[a-z]+/' "$INSTALL_DIR/scripts/backup.sh"; then fail "backup.sh has a hardcoded home path"; else pass "backup.sh has no hardcoded home path"; fi
if grep -q 'config-overrides' "$INSTALL_DIR/scripts/backup.sh"; then fail "backup.sh still references retired config-overrides.json"; else pass "no retired config-overrides.json"; fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
