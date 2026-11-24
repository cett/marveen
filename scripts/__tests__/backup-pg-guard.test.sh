#!/bin/bash
# The stale-SQLite backup guard (scripts/pg-configured.sh, backup.sh, verify-restore.sh, restore-drill.sh; the cutover
# plan's G5). With a PostgreSQL URL configured, a backup must not claim to contain the database, and a drill must never
# end in OK on a database-less archive.
#
# Each case runs the real scripts in a throwaway install root (a copy of scripts/ and a SQLite store) with the URL placed
# in ONE layer at a time: the secret mount, the environment, the .env file, or the marker alone.
#
# Cells: A1 drill NOT APPLICABLE in each layer; A2 blank/absent layers behave as before; A3 backup writes an archive
# without the database and says so; A4 verify-restore skips the database and a drill is NOT APPLICABLE; A6 the URL
# never appears in any output or in the archive. The URL is a placeholder with a marker string.
# Run: bash scripts/__tests__/backup-pg-guard.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

URL='postgres://leakmarker-user:leakmarker-pass@leakmarker-host.invalid:5432/leakmarker'
MARK='leakmarker'

SETUP="$ROOT/install"
mkdir -p "$SETUP/scripts/lib" "$SETUP/store" "$SETUP/secrets"
# the test HOME: its own, empty, never the runner's (a real HOME can hold files the backup archives, or none)
mkdir -p "$ROOT/home"
printf '[]\n' > "$SETUP/scheduled-tasks.json"
cp "$INSTALL_DIR/scripts/backup.sh" "$INSTALL_DIR/scripts/verify-restore.sh" \
   "$INSTALL_DIR/scripts/restore-drill.sh" "$INSTALL_DIR/scripts/pg-configured.sh" "$SETUP/scripts/"
cp "$INSTALL_DIR/scripts/lib/portable.sh" "$SETUP/scripts/lib/" 2>/dev/null || true
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SETUP/store/claudeclaw.db" 'CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO memories (body) VALUES ("one");'
else
  echo "  SKIP: sqlite3 is missing, the guard cells need it"
  exit 0
fi

# run_in <layer> <script> [args...]: runs a script of the install with the URL in one layer only
#   layer: mount | env | file | marker | none | blank
run_in() {
  local layer="$1" script="$2"
  shift 2
  local envs=(PATH="$PATH" HOME="$ROOT/home" BACKUP_SECURITY_BIN=/usr/bin/false)
  rm -f "$SETUP/.env"
  case "$layer" in
    mount) printf '%s\n' "$URL" > "$SETUP/secrets/MARVEEN_PG_URL"; envs+=(SECRET_MOUNT_DIR="$SETUP/secrets") ;;
    env) envs+=(MARVEEN_PG_URL="$URL" SECRET_MOUNT_DIR="$SETUP/nomount") ;;
    file) printf 'MARVEEN_PG_URL=%s\n' "$URL" > "$SETUP/.env"; envs+=(SECRET_MOUNT_DIR="$SETUP/nomount") ;;
    marker) envs+=(MARVEEN_PG_CONFIGURED=1 SECRET_MOUNT_DIR="$SETUP/nomount") ;;
    markerenv) printf 'OTHER_KEY=1\n' > "$SETUP/.env"; envs+=(MARVEEN_PG_CONFIGURED=1 SECRET_MOUNT_DIR="$SETUP/nomount") ;;
    blank) printf '%s\n' '  ' > "$SETUP/secrets/MARVEEN_PG_URL"; printf 'MARVEEN_PG_URL=   \n' > "$SETUP/.env"
           envs+=(MARVEEN_PG_URL='   ' SECRET_MOUNT_DIR="$SETUP/secrets") ;;
    none) envs+=(SECRET_MOUNT_DIR="$SETUP/nomount") ;;
  esac
  [[ "$layer" == mount || "$layer" == blank ]] || rm -f "$SETUP/secrets/MARVEEN_PG_URL"
  [[ "$layer" == blank ]] || true
  (cd "$SETUP" && env -i "${envs[@]}" bash "scripts/$script" "$@" 2>&1)
  return $?
}

# a good SQLite archive, taken with no PostgreSQL layer (the blank layers)
rm -rf "$SETUP/backups"
OUT_BK="$(run_in none backup.sh)"; RC_BK=$?
ARCHIVE="$(ls -1t "$SETUP"/backups/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
if [[ $RC_BK -ne 0 || -z "$ARCHIVE" ]]; then
  echo "  SKIP: the SQLite baseline backup failed, cannot run the cells: $OUT_BK"
  exit 0
fi

# A2: blank and absent layers behave as before (a good archive drills OK, exit 0)
RC_A2="$(run_in blank restore-drill.sh >/dev/null 2>&1; echo $?)"
if [[ "$RC_A2" == "0" ]]; then pass "A2: blank layers: the drill of a good SQLite archive is OK (exit 0)"; else fail "A2 blank layers drill" "0" "$RC_A2"; fi
RC_A2N="$(run_in none restore-drill.sh >/dev/null 2>&1; echo $?)"
if [[ "$RC_A2N" == "0" ]]; then pass "A2: no PostgreSQL layer: the drill is OK (exit 0)"; else fail "A2 absent layers drill" "0" "$RC_A2N"; fi

# A1: each layer with a PostgreSQL URL: the drill is NOT APPLICABLE (exit 3) even with a good archive in place
for layer in mount env file marker markerenv; do
  OUT="$(run_in "$layer" restore-drill.sh 2>&1)"; RC=$?
  if [[ $RC -eq 3 ]] && grep -q 'NOT APPLICABLE' <<<"$OUT"; then
    pass "A1: $layer layer: drill NOT APPLICABLE (exit 3)"
  else
    fail "A1 $layer layer drill" "exit 3 with NOT APPLICABLE" "exit $RC: $(head -c 160 <<<"$OUT")"
  fi
done

# A1b: the .env cannot be read but the marker is set: doubt is PostgreSQL, the drill is NOT APPLICABLE
printf 'MARVEEN_PG_URL=%s\n' "$URL" > "$SETUP/.env"
chmod 000 "$SETUP/.env"
OUT="$(cd "$SETUP" && env -i PATH="$PATH" HOME="$ROOT/home" MARVEEN_PG_CONFIGURED=1 SECRET_MOUNT_DIR="$SETUP/nomount" bash scripts/restore-drill.sh 2>&1)"; RC=$?
chmod 600 "$SETUP/.env" 2>/dev/null || true
rm -f "$SETUP/.env"
if [[ $RC -eq 3 ]] && grep -q 'NOT APPLICABLE' <<<"$OUT"; then
  pass "A1b: unreadable .env with the marker: drill NOT APPLICABLE (exit 3)"
else
  fail "A1b unreadable .env with marker" "exit 3 with NOT APPLICABLE" "exit $RC"
fi

# A3: backup with each layer: archive written, exit 0, no database inside, the MANIFEST line, the stderr notice
for layer in mount env file marker markerenv; do
  rm -rf "$SETUP/backups"
  ERR="$ROOT/stderr-$layer"
  run_in "$layer" backup.sh >"$ROOT/stdout-$layer" 2>"$ERR"; RC=$?
  A="$(ls -1t "$SETUP"/backups/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
  LIST="$(tar -tzf "$A" 2>/dev/null)"
  MAN="$(tar -xzOf "$A" MANIFEST.txt 2>/dev/null)"
  if [[ $RC -eq 0 && -n "$A" ]]; then pass "A3: $layer layer: backup exits 0 and writes an archive"; else fail "A3 $layer backup" "exit 0 and an archive" "exit $RC"; fi
  if ! grep -q 'repo/store/claudeclaw.db' <<<"$LIST"; then pass "A3: $layer layer: the stale database is not in the archive"; else fail "A3 $layer database excluded" "no repo/store/claudeclaw.db" "present"; fi
  if grep -qxF 'database: not included (PostgreSQL install)' <<<"$MAN"; then pass "A3: $layer layer: MANIFEST says the database is not included"; else fail "A3 $layer MANIFEST line" "the line" "absent"; fi
  # run_in merges stderr into the output: the notice is in the captured output (stdout + stderr)
  if grep -q 'NOTICE -- this install is configured for PostgreSQL' "$ROOT/stdout-$layer"; then pass "A3: $layer layer: the stderr notice is printed"; else fail "A3 $layer notice" "the NOTICE line" "absent"; fi
  if grep -q 'repo/.env\|repo/store/vault.json\|repo/scheduled-tasks.json' <<<"$LIST" || [[ ! -f "$SETUP/.env" && ! -f "$SETUP/secrets/MARVEEN_PG_URL" ]]; then
    pass "A3: $layer layer: the rest of the packing list is still archived"
  fi
  # A6: the URL never appears in the output, the archive listing, or the manifest
  if ! grep -q "$MARK" "$ROOT/stdout-$layer" "$ERR" <<<"$LIST$MAN" 2>/dev/null; then
    pass "A6: $layer layer: the URL is not in the output or the archive"
  else
    fail "A6 $layer leak" "no $MARK anywhere" "found"
  fi
  # A4: verify-restore on the PostgreSQL archive: plain mode skips the database and exits per the other checks
  VOUT="$(cd "$SETUP" && env -i PATH="$PATH" HOME="$ROOT/home" bash scripts/verify-restore.sh "$A" 2>&1)"; VRC=$?
  if [[ $VRC -eq 0 ]] && grep -q '\[SKIP\] database not in this archive (PostgreSQL install)' <<<"$VOUT"; then
    pass "A4: $layer archive: plain verify skips the database, exit 0"
  else
    fail "A4 $layer plain verify" "exit 0 with the SKIP line" "exit $VRC"
  fi
  DOUT="$(cd "$SETUP" && env -i PATH="$PATH" HOME="$ROOT/home" bash scripts/verify-restore.sh --drill "$A" 2>&1)"; DRC=$?
  if [[ $DRC -eq 3 ]] && grep -q 'NOT APPLICABLE' <<<"$DOUT" && ! grep -q 'ALL CHECKS PASSED' <<<"$DOUT"; then
    pass "A4: $layer archive: drill verify is NOT APPLICABLE (exit 3), no OK line"
  else
    fail "A4 $layer drill verify" "exit 3, NOT APPLICABLE, no ALL CHECKS PASSED" "exit $DRC"
  fi
done

# One source: backup.sh and restore-drill.sh source scripts/pg-configured.sh, and define no copy of the function.
for name in backup.sh restore-drill.sh; do
  if grep -qF '. "${REPO_ROOT}/scripts/pg-configured.sh"' "$INSTALL_DIR/scripts/$name" && ! grep -q '^pg_configured() {' "$INSTALL_DIR/scripts/$name"; then
    pass "$name sources scripts/pg-configured.sh and holds no copy of the detection function"
  else
    fail "$name detection source" "sources pg-configured.sh, no copy" "differs"
  fi
done

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
