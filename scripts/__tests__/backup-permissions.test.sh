#!/bin/bash
# scripts/backup.sh: the archive holds the whole database and the channel secrets, so the backups directory, the archive and
# its checksum sidecar (and the vault key sidecar) are owner-only, whatever umask the caller runs under and whatever mode
# the directory already had.
# Run: bash scripts/__tests__/backup-permissions.test.sh
#
# Every scenario runs in a temp "repo" holding a copy of the script and its own HOME, so the real store/, backups/ and home
# are never touched. BACKUP_SECURITY_BIN is a stub that fails, so the real keychain is never asked.

set -u

if ! command -v sqlite3 >/dev/null 2>&1; then echo "SKIP: sqlite3 not installed"; exit 0; fi

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# mode <path>: the permission bits, portable (GNU stat first, then BSD).
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
check_mode() { # check_mode <label> <path> <expected>
  local got; got="$(mode "$2")"
  [ "$got" = "$3" ] && pass "$1 is $3" || fail "$1 is $got, expected $3"
}

KEYCHAIN_STUB="$TMPDIR_BASE/security-stub"
printf '#!/bin/bash\nexit 44\n' > "$KEYCHAIN_STUB"; chmod 755 "$KEYCHAIN_STUB"

# mkrepo <name>: a temp repo with the script, an empty HOME, a database, a vault and its key file.
mkrepo() {
  local r="$TMPDIR_BASE/$1"
  mkdir -p "$r/scripts" "$r/store" "$r/home"
  # BACKUP_SH: another copy of the script (how a mutant is run against these checks)
  cp "${BACKUP_SH:-$INSTALL_DIR/scripts/backup.sh}" "$r/scripts/backup.sh"
  sqlite3 "$r/store/claudeclaw.db" 'CREATE TABLE a(x); INSERT INTO a VALUES (1),(2);' >/dev/null
  chmod 600 "$r/store/claudeclaw.db"
  echo '{}' > "$r/store/vault.json"
  echo 'key-fixture-0451' > "$r/store/.vault-key"
  echo "$r"
}
# backup_in <repo> <umask>: the script under the given umask, with the stubbed keychain.
backup_in() { ( umask "$2"; cd "$1" && HOME="$1/home" BACKUP_SECURITY_BIN="$KEYCHAIN_STUB" bash scripts/backup.sh 2>&1 ); }

echo "(a) a fresh backups directory under a loose umask (022)"
R="$(mkrepo a)"
OUT="$(backup_in "$R" 022)"; RC=$?
[ $RC -eq 0 ] && pass "backup.sh exits 0" || fail "backup.sh exit $RC: $OUT"
ARC="$(ls -1t "$R"/backups/claudeclaw-*.tar.gz | head -1)"
check_mode "the backups directory" "$R/backups" 700
check_mode "the archive" "$ARC" 600
check_mode "the checksum sidecar" "${ARC%.tar.gz}.sha256" 600
check_mode "the vault key sidecar" "${ARC%.tar.gz}.vault-key" 600

echo "(b) a pre-existing, loose backups directory is tightened"
R="$(mkrepo b)"
mkdir -p "$R/backups"; chmod 755 "$R/backups"
OUT="$(backup_in "$R" 022)"; RC=$?
[ $RC -eq 0 ] && pass "backup.sh exits 0" || fail "backup.sh exit $RC: $OUT"
check_mode "the backups directory" "$R/backups" 700
ARC="$(ls -1t "$R"/backups/claudeclaw-*.tar.gz | head -1)"
check_mode "the archive" "$ARC" 600

echo "(c) an even looser umask (000) still ends owner-only"
R="$(mkrepo c)"
OUT="$(backup_in "$R" 000)"; RC=$?
[ $RC -eq 0 ] && pass "backup.sh exits 0" || fail "backup.sh exit $RC: $OUT"
ARC="$(ls -1t "$R"/backups/claudeclaw-*.tar.gz | head -1)"
check_mode "the backups directory" "$R/backups" 700
check_mode "the archive" "$ARC" 600
check_mode "the checksum sidecar" "${ARC%.tar.gz}.sha256" 600

echo "(d) the owner-only archive is still a good archive (checksum verifies, listing works)"
( cd "$R/backups" && { sha256sum -c "$(basename "${ARC%.tar.gz}").sha256" >/dev/null 2>&1 || shasum -a 256 -c "$(basename "${ARC%.tar.gz}").sha256" >/dev/null 2>&1; } ) \
  && pass "the sidecar checksum matches the archive" || fail "the sidecar checksum does not match"
tar -tzf "$ARC" | grep -qx 'repo/store/claudeclaw.db' && pass "the database is in the archive" || fail "no database in the archive"

echo "(e) pre-modify-backup.sh: the snapshot directory, the database copy and the copied secrets are owner-only"
# PRE_MODIFY_SH: another copy of the script (how a mutant is run against these checks)
R="$(mkrepo e)"
cp "${PRE_MODIFY_SH:-$INSTALL_DIR/scripts/pre-modify-backup.sh}" "$R/scripts/pre-modify-backup.sh"
# loosely moded source files: cp -p would carry these modes into the copy
echo 'token-fixture-0451' > "$R/store/.dashboard-token"; chmod 644 "$R/store/.dashboard-token" "$R/store/vault.json" "$R/store/.vault-key"
mkdir -p "$R/store/backups"; chmod 755 "$R/store/backups"
OUT="$( umask 022; cd "$R" && HOME="$R/home" bash scripts/pre-modify-backup.sh perm 2>&1 )"; RC=$?
[ $RC -eq 0 ] && pass "pre-modify-backup.sh exits 0" || fail "pre-modify-backup.sh exit $RC: $OUT"
SNAP="$(ls -1d "$R"/store/backups/*-perm | head -1)"
[ -f "$SNAP/claudeclaw.db" ] && pass "the database snapshot is there" || fail "no database snapshot in $SNAP"
check_mode "store/backups" "$R/store/backups" 700
check_mode "the snapshot directory" "$SNAP" 700
check_mode "the database snapshot" "$SNAP/claudeclaw.db" 600
check_mode "the copied vault.json" "$SNAP/vault.json" 600
check_mode "the copied vault key" "$SNAP/.vault-key" 600
check_mode "the copied dashboard token" "$SNAP/.dashboard-token" 600
check_mode "the git-HEAD.txt note" "$SNAP/git-HEAD.txt" 600

echo ""
echo "backup-permissions: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
