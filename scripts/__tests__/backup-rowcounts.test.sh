#!/bin/bash
# scripts/backup.sh + verify-restore.sh + restore-drill.sh: the database snapshot, the per-table row counts in
# MANIFEST.txt, and the restore check that compares them. A restore check that passes an archive with an empty
# database is the failure this pins (it printed "ALL CHECKS PASSED" for a database with no tables).
# Run: bash scripts/__tests__/backup-rowcounts.test.sh
#
# Every scenario runs in a temp "repo" holding copies of the scripts and its own HOME, so the real store/,
# backups/ and home are never touched.

set -u

if ! command -v sqlite3 >/dev/null 2>&1; then echo "SKIP: sqlite3 not installed"; exit 0; fi

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# mkrepo <name>: a temp repo with the three scripts, an empty HOME, and a WAL-mode database with a (3 rows),
# b (no rows) and c (1 row). The last insert stays in the -wal file on purpose.
mkrepo() {
  local r="$TMPDIR_BASE/$1"
  mkdir -p "$r/scripts" "$r/store" "$r/home"
  cp "$INSTALL_DIR/scripts/backup.sh" "$INSTALL_DIR/scripts/verify-restore.sh" "$INSTALL_DIR/scripts/restore-drill.sh" "$r/scripts/"
  sqlite3 "$r/store/claudeclaw.db" 'PRAGMA journal_mode=WAL; CREATE TABLE a(x); CREATE TABLE b(x); CREATE TABLE c(x); INSERT INTO a VALUES (1),(2),(3);' >/dev/null
  chmod 600 "$r/store/claudeclaw.db"
  echo "$r"
}
backup_in() { ( cd "$1" && HOME="$1/home" bash scripts/backup.sh ) ; }
newest() { ls -1t "$1"/backups/claudeclaw-*.tar.gz | head -1; }

# synth <name> <manifest-body> <sql>: a hand-made archive (MANIFEST.txt + repo/store/claudeclaw.db) in $TMPDIR_BASE/<name>.tar.gz
synth() {
  local d="$TMPDIR_BASE/synth-$1"
  mkdir -p "$d/repo/store"
  printf 'Marveen backup test\n%s' "$2" > "$d/MANIFEST.txt"
  sqlite3 "$d/repo/store/claudeclaw.db" "$3" >/dev/null
  ( cd "$d" && tar -czf "$TMPDIR_BASE/$1.tar.gz" MANIFEST.txt repo )
  echo "$TMPDIR_BASE/$1.tar.gz"
}
verify() { ( cd "$VR" && HOME="$VR/home" bash scripts/verify-restore.sh "$@" 2>&1 ); }
VR="$(mkrepo vr)"

echo "(a) backup.sh: one consistent snapshot and the row counts"
R="$(mkrepo a)"
OUT="$(backup_in "$R" 2>&1)"; RC=$?
[ $RC -eq 0 ] && pass "backup.sh exits 0" || fail "backup.sh exit $RC: $OUT"
ARC="$(newest "$R")"
LIST="$(tar -tzf "$ARC")"
echo "$LIST" | grep -qx 'repo/store/claudeclaw.db' && pass "the database is in the archive" || fail "no database in the archive"
echo "$LIST" | grep -qE 'claudeclaw\.db-(wal|shm)' && fail "-wal/-shm were archived next to the snapshot" || pass "no -wal/-shm in the archive"
MAN="$(tar -xzOf "$ARC" MANIFEST.txt)"
echo "$MAN" | grep -q '^--- db-rowcounts' && pass "MANIFEST.txt has the row count section" || fail "no row count section"
printf '%s\n' "$MAN" | grep -qE "^a$(printf '\t')3\$" && printf '%s\n' "$MAN" | grep -qE "^b$(printf '\t')0\$" && printf '%s\n' "$MAN" | grep -qE "^c$(printf '\t')0\$" \
  && pass "counts: a 3, b 0, c 0" || fail "wrong counts in the manifest: $MAN"
X="$TMPDIR_BASE/a-x"; mkdir -p "$X"; tar -xzf "$ARC" -C "$X" repo/store/claudeclaw.db
[ "$(sqlite3 "$X/repo/store/claudeclaw.db" 'SELECT count(*) FROM a')" = "3" ] && pass "the archived database holds the rows" || fail "archived database lost its rows"
# The live file is in WAL mode; only the snapshot (rewritten as one self-contained file) is in the rollback journal mode.
[ "$(sqlite3 "$X/repo/store/claudeclaw.db" 'PRAGMA journal_mode;')" = "delete" ] && pass "the archived file is the snapshot, not a copy of the live file" || fail "the archived database is not the snapshot (journal_mode: $(sqlite3 "$X/repo/store/claudeclaw.db" 'PRAGMA journal_mode;'))"

[ "$(tar -tvzf "$ARC" repo/store/claudeclaw.db | cut -c1-10)" = "-rw-------" ] && pass "the archived database keeps the live file's 0600 mode" || fail "archived database mode: $(tar -tvzf "$ARC" repo/store/claudeclaw.db | cut -c1-10)"

echo "(b) a row that is only in the -wal file is in the snapshot"
R="$(mkrepo b)"
( cd "$R" && sqlite3 store/claudeclaw.db 'INSERT INTO c VALUES (9);' >/dev/null )
[ -s "$R/store/claudeclaw.db-wal" ] && pass "the live -wal file holds the new row (precondition)" || echo "  NOTE: no -wal left (sqlite checkpointed on close), the scenario degrades to a plain snapshot"
backup_in "$R" >/dev/null 2>&1
ARC="$(newest "$R")"; X="$TMPDIR_BASE/b-x"; mkdir -p "$X"; tar -xzf "$ARC" -C "$X" repo/store/claudeclaw.db
[ "$(sqlite3 "$X/repo/store/claudeclaw.db" 'SELECT count(*) FROM c')" = "1" ] && pass "the snapshot has the row that was in the -wal" || fail "row from the -wal missing in the snapshot"

echo "(c) verify-restore --drill on a good archive: counts compared"
cp "$ARC" "$VR/good.tar.gz"
OUT="$(verify --drill "$VR/good.tar.gz")"; RC=$?
[ $RC -eq 0 ] && pass "exit 0" || fail "exit $RC: $OUT"
echo "$OUT" | grep -q '3 of 3 tables, 4 of 4 rows' && pass "prints 'N of M tables, X of Y rows'" || fail "no count line: $(echo "$OUT" | grep '5a' -A2)"

echo "(d) verify-restore refuses an archive whose database is empty or wrong"
A="$(synth empty-db "--- db-rowcounts (table<TAB>rows) ---
" "PRAGMA user_version=1;")"
OUT="$(verify "$A")"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'has no tables' && pass "a database with no tables FAILS (it used to pass)" || fail "empty database not refused (exit $RC)"
A="$(synth emptied "--- db-rowcounts (table<TAB>rows) ---
a$(printf '\t')3
" "CREATE TABLE a(x);")"
OUT="$(verify "$A")"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'EMPTY a (manifest 3, archive 0)' && pass "a table filled at backup time and empty now FAILS" || fail "emptied table not refused (exit $RC): $OUT"
A="$(synth missing "--- db-rowcounts (table<TAB>rows) ---
a$(printf '\t')1
c$(printf '\t')2
" "CREATE TABLE a(x); INSERT INTO a VALUES (1);")"
OUT="$(verify "$A")"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING c' && echo "$OUT" | grep -q '1 of 2 tables' && pass "a missing table FAILS and the count line says 1 of 2" || fail "missing table not refused (exit $RC): $OUT"
A="$(synth differs "--- db-rowcounts (table<TAB>rows) ---
a$(printf '\t')5
" "CREATE TABLE a(x); INSERT INTO a VALUES (1),(2),(3),(4);")"
OUT="$(verify "$A")"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'DIFF a (manifest 5, archive 4)' && pass "a different row count FAILS" || fail "different count not refused (exit $RC)"
A="$(synth extra "--- db-rowcounts (table<TAB>rows) ---
a$(printf '\t')1
" "CREATE TABLE a(x); INSERT INTO a VALUES (1); CREATE TABLE z(x);")"
OUT="$(verify "$A")"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'EXTRA z' && pass "a table the manifest does not know FAILS" || fail "extra table not refused (exit $RC)"

echo "(e) an archive from before the counts"
A="$(synth legacy "" "CREATE TABLE a(x); INSERT INTO a VALUES (1);")"
OUT="$(verify "$A")"; RC=$?
[ $RC -eq 0 ] && echo "$OUT" | grep -q 'WARN.*no row counts' && pass "normal mode: WARN, exit 0" || fail "legacy archive: exit $RC"
OUT="$(verify --drill "$A")"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'no row counts to compare' && pass "--drill: FAILS (nothing was compared)" || fail "legacy archive under --drill: exit $RC"

echo "(f) no sqlite3: the backup stops, the drill fails, the plain check says it skipped"
MINBIN="$TMPDIR_BASE/minbin"; mkdir -p "$MINBIN"
for t in bash env sh cat cp mkdir rm ls head tail wc tr grep sed awk sort find tar gzip mktemp dirname basename date hostname stat touch shasum sha256sum perl uname id printf; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$MINBIN/$t"
done
R="$(mkrepo nosql)"
OUT="$( cd "$R" && HOME="$R/home" PATH="$MINBIN" bash scripts/backup.sh 2>&1 )"; RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'sqlite3 CLI is missing' && pass "backup.sh without sqlite3: ABORT, exit 2" || fail "backup without sqlite3: exit $RC: $OUT"
ls "$R"/backups/claudeclaw-*.tar.gz >/dev/null 2>&1 && fail "an archive was written anyway" || pass "no archive written"
OUT="$( cd "$VR" && HOME="$VR/home" PATH="$MINBIN" bash scripts/verify-restore.sh --drill "$VR/good.tar.gz" 2>&1 )"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'sqlite3 not found' && pass "--drill without sqlite3 FAILS" || fail "drill without sqlite3: exit $RC"
OUT="$( cd "$VR" && HOME="$VR/home" PATH="$MINBIN" bash scripts/verify-restore.sh "$VR/good.tar.gz" 2>&1 )"; RC=$?
[ $RC -eq 0 ] && echo "$OUT" | grep -q 'SKIP.*sqlite3' && pass "plain run: SKIP, exit 0 (as before)" || fail "plain run without sqlite3: exit $RC"

echo "(g) restore-drill.sh"
R="$(mkrepo drill)"
OUT="$( cd "$R" && HOME="$R/home" bash scripts/restore-drill.sh 2>&1 )"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'no backup archive' && pass "no archive: FAIL" || fail "drill without archive: exit $RC"
backup_in "$R" >/dev/null 2>&1
OUT="$( cd "$R" && HOME="$R/home" bash scripts/restore-drill.sh 2>&1 )"; RC=$?
[ $RC -eq 0 ] && echo "$OUT" | grep -qE '^restore-drill: OK .* -- 3 of 3 tables, 3 of 3 rows' && pass "fresh archive: OK with the counts in the last line" || fail "drill on a fresh archive: exit $RC: $(echo "$OUT" | tail -3)"
ARC="$(newest "$R")"; touch -t 202001010000 "$ARC"
OUT="$( cd "$R" && HOME="$R/home" bash scripts/restore-drill.sh 2>&1 )"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'nightly backup has stopped' && pass "a stale newest archive FAILS (the nightly backup stopped)" || fail "stale archive: exit $RC"
touch "$ARC"; sqlite3 "$R/store/claudeclaw.db" 'SELECT 1' >/dev/null
GOOD="$TMPDIR_BASE/drill-bad"; mkdir -p "$GOOD"; tar -xzf "$ARC" -C "$GOOD"; sqlite3 "$GOOD/repo/store/claudeclaw.db" 'DELETE FROM a;' >/dev/null
( cd "$GOOD" && tar -czf "$ARC" MANIFEST.txt repo ); rm -f "${ARC%.tar.gz}.sha256"
OUT="$( cd "$R" && HOME="$R/home" bash scripts/restore-drill.sh 2>&1 )"; RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'restore-drill: FAIL' && echo "$OUT" | grep -q 'EMPTY a' && pass "an archive with a emptied table FAILS the drill" || fail "damaged archive: exit $RC"

echo "(h) the seeded weekly task"
CFG="$INSTALL_DIR/seed-scheduled-tasks/weekly-restore-drill/task-config.json"
python3 -I - "$CFG" <<'PY' && pass "weekly task: Sunday 03:30 command task, alerts on the first failure, no hardcoded path" || fail "weekly task config"
import json, sys
c = json.load(open(sys.argv[1]))
assert c["schedule"] == "30 3 * * 0" and c["type"] == "command" and c["enabled"] is True
assert c["failThreshold"] == 1 and c["agent"] == "{{MAIN_AGENT_ID}}"
assert c["command"] == "bash '{{INSTALL_DIR}}/scripts/restore-drill.sh'"
assert "/Users/" not in c["command"] and "/home/" not in c["command"]
PY

echo ""
echo "backup-rowcounts: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
