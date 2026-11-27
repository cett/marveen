#!/bin/bash
# scripts/backup.sh on a PostgreSQL install: the two residual SQLite tables (hook_audit_log, gate_decision_counts) that the
# gate hooks still write into store/claudeclaw.db after the cutover are dumped into the archive as
# repo/store/residual-gate-audit.sql, because the archive excludes the (stale) database file itself.
#
# Cells:
#   R1 PG-mode archive holds the dump with both tables and a known row, mode 600, listed in MANIFEST.txt, and replays
#   R2 no database file: a warning, the archive is still written, MANIFEST says NOT included
#   R3 one table missing: a warning naming it, the other one is archived
#   R4 neither table exists / the file is not a database: a warning, no dump file, exit 0
#   R5 a SQLite-mode (no PostgreSQL URL) archive is unchanged: no residual file, no residual MANIFEST line
#   R6 verify-restore passes on a PG archive with and without the file; a drill of it stays NOT APPLICABLE (exit 3)
#   R7 nothing else of the SQLite file reaches the archive (a marker row of another table is absent), and the
#      PostgreSQL URL never appears in the output or the archive
#   R8 a row written to the live file AFTER the export started cannot corrupt the dump (the dump replays cleanly)
# Run: bash scripts/__tests__/backup-residual-tables.test.sh

set -u

if ! command -v sqlite3 >/dev/null 2>&1; then echo "SKIP: sqlite3 not installed"; exit 0; fi

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

URL='postgres://leakmarker-user:leakmarker-pass@leakmarker-host.invalid:5432/leakmarker'
MARK='leakmarker'
OTHER_MARK='other-table-marker-7f3a'

# mkrepo <name> [full|one|none|garbage]: a temp install with the scripts and its own empty HOME.
#   full: both residual tables, a known row each, and an unrelated table with a marker row (must NOT be archived)
#   one: only gate_decision_counts; none: no store file at all; garbage: a file that is not a database
mkrepo() {
  local r="$ROOT/$1" kind="${2:-full}"
  mkdir -p "$r/scripts/lib" "$r/store" "$r/home" "$r/nomount"
  printf '[]\n' > "$r/scheduled-tasks.json"
  cp "$INSTALL_DIR/scripts/backup.sh" "$INSTALL_DIR/scripts/verify-restore.sh" "$INSTALL_DIR/scripts/restore-drill.sh" \
     "$INSTALL_DIR/scripts/pg-configured.sh" "$r/scripts/"
  cp "$INSTALL_DIR/scripts/lib/portable.sh" "$r/scripts/lib/" 2>/dev/null || true
  case "$kind" in
    full)
      sqlite3 "$r/store/claudeclaw.db" "PRAGMA journal_mode=WAL;
        CREATE TABLE hook_audit_log (id INTEGER PRIMARY KEY, ts INTEGER, agent_id TEXT, hook_type TEXT, verdict TEXT);
        CREATE TABLE gate_decision_counts (gate TEXT, decision TEXT, reason TEXT, count INTEGER, PRIMARY KEY (gate, decision, reason));
        CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT);
        INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES (1700000000, 'agent-a', 'egress', 'deny');
        INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES (1700000001, 'agent-b', 'destructive', 'deny');
        INSERT INTO gate_decision_counts VALUES ('egress', 'allow', 'ok', 41);
        INSERT INTO memories (body) VALUES ('$OTHER_MARK');" >/dev/null ;;
    one)
      sqlite3 "$r/store/claudeclaw.db" "CREATE TABLE gate_decision_counts (gate TEXT, decision TEXT, reason TEXT, count INTEGER);
        INSERT INTO gate_decision_counts VALUES ('egress', 'allow', 'ok', 7);" >/dev/null ;;
    garbage) head -c 4096 /dev/urandom > "$r/store/claudeclaw.db" ;;
    none) ;;
  esac
  echo "$r"
}
# run_backup <repo> <pg|sqlite>: the real script, PostgreSQL URL in the environment only for pg
run_backup() {
  local r="$1" mode="$2"
  local envs=(PATH="$PATH" HOME="$r/home" BACKUP_SECURITY_BIN=/usr/bin/false SECRET_MOUNT_DIR="$r/nomount")
  [[ "$mode" == pg ]] && envs+=(MARVEEN_PG_URL="$URL")
  (cd "$r" && env -i "${envs[@]}" bash scripts/backup.sh 2>&1)
}
newest() { ls -1t "$1"/backups/claudeclaw-*.tar.gz 2>/dev/null | head -1; }

echo "R1: PG mode: the residual dump is in the archive"
R="$(mkrepo r1)"
OUT="$(run_backup "$R" pg)"; RC=$?
A="$(newest "$R")"
[[ $RC -eq 0 && -n "$A" ]] && pass "R1: backup exits 0 and writes an archive" || fail "R1 backup" "exit 0 + archive" "exit $RC: $OUT"
LIST="$(tar -tzf "$A" 2>/dev/null)"
grep -qx 'repo/store/residual-gate-audit.sql' <<<"$LIST" && pass "R1: repo/store/residual-gate-audit.sql is in the archive" || fail "R1 dump listed" "present" "absent"
grep -q 'repo/store/claudeclaw.db' <<<"$LIST" && fail "R1 stale db" "no claudeclaw.db in the archive" "present" || pass "R1: the stale database file is still not in the archive"
X="$ROOT/r1-x"; mkdir -p "$X"; tar -xzf "$A" -C "$X" 2>/dev/null
DUMP="$X/repo/store/residual-gate-audit.sql"
if [[ -f "$DUMP" ]]; then
  # GNU first: on Linux `stat -f` exits 0 with the filesystem report (a multi-line "File: ..." text), not the mode
  MODE="$(stat -c '%a' "$DUMP" 2>/dev/null || stat -f '%Lp' "$DUMP")"
  [[ "$MODE" == "600" ]] && pass "R1: the dump file is mode 600 in the archive" || fail "R1 dump mode" "600" "$MODE"
  # replay into a fresh database: both tables, the known rows
  sqlite3 "$ROOT/r1-replay.db" < "$DUMP" 2>/dev/null
  N1="$(sqlite3 "$ROOT/r1-replay.db" 'SELECT count(*) FROM hook_audit_log' 2>/dev/null)"
  N2="$(sqlite3 "$ROOT/r1-replay.db" "SELECT count FROM gate_decision_counts WHERE gate='egress' AND decision='allow'" 2>/dev/null)"
  V="$(sqlite3 "$ROOT/r1-replay.db" "SELECT verdict FROM hook_audit_log WHERE agent_id='agent-b'" 2>/dev/null)"
  [[ "$N1" == "2" && "$N2" == "41" && "$V" == "deny" ]] && pass "R1: the dump replays with both tables and the known rows" || fail "R1 replay" "2 audit rows, count 41, verdict deny" "$N1 / $N2 / $V"
else
  fail "R1 dump present" "file extracted" "missing"
fi
MAN="$(tar -xzOf "$A" MANIFEST.txt 2>/dev/null)"
grep -qxF 'residual-gate-audit: store/residual-gate-audit.sql (rows: hook_audit_log=2, gate_decision_counts=1)' <<<"$MAN" && pass "R1: MANIFEST.txt names the dump and its row counts" || fail "R1 MANIFEST" "residual line with counts" "$(grep residual <<<"$MAN")"
grep -qxF 'database: not included (PostgreSQL install)' <<<"$MAN" && pass "R1: MANIFEST still says the database is not included" || fail "R1 database line" "present" "absent"
grep -qx 'repo/store/residual-gate-audit.sql' <<<"$MAN" && pass "R1: the dump is in the MANIFEST repo/ list" || fail "R1 repo list" "listed" "absent"

echo "R7: only the two tables, no URL"
if [[ -f "$DUMP" ]] && ! grep -q "$OTHER_MARK" "$DUMP" && ! grep -qi 'CREATE TABLE.*memories' "$DUMP"; then pass "R7: the unrelated table is not in the dump"; else fail "R7 unrelated table" "absent" "present"; fi
if ! grep -rq "$MARK" "$X" 2>/dev/null && ! grep -q "$MARK" <<<"$OUT$LIST$MAN"; then pass "R7: the PostgreSQL URL is not in the output or the archive"; else fail "R7 leak" "no $MARK" "found"; fi

echo "R6: verify-restore on the PG archive with the file, then without it"
VOUT="$(cd "$R" && env -i PATH="$PATH" HOME="$R/home" bash scripts/verify-restore.sh "$A" 2>&1)"; VRC=$?
[[ $VRC -eq 0 ]] && pass "R6: verify-restore passes on the archive with the residual dump" || fail "R6 verify with file" "exit 0" "exit $VRC: $(tail -5 <<<"$VOUT")"
DOUT="$(cd "$R" && env -i PATH="$PATH" HOME="$R/home" bash scripts/verify-restore.sh --drill "$A" 2>&1)"; DRC=$?
[[ $DRC -eq 3 ]] && grep -q 'NOT APPLICABLE' <<<"$DOUT" && pass "R6: a drill of the PG archive stays NOT APPLICABLE (exit 3)" || fail "R6 drill" "exit 3 NOT APPLICABLE" "exit $DRC"
# the same archive without the residual file and without its MANIFEST line (an archive of the previous version)
S="$ROOT/r6-strip"; mkdir -p "$S"; tar -xzf "$A" -C "$S"
rm -f "$S/repo/store/residual-gate-audit.sql"
grep -v 'residual-gate-audit' "$S/MANIFEST.txt" > "$S/MANIFEST.new" && mv "$S/MANIFEST.new" "$S/MANIFEST.txt"
( cd "$S" && tar -czf "$ROOT/r6-old.tar.gz" MANIFEST.txt $(ls -d repo home 2>/dev/null) )
VOUT2="$(cd "$R" && env -i PATH="$PATH" HOME="$R/home" bash scripts/verify-restore.sh "$ROOT/r6-old.tar.gz" 2>&1)"; VRC2=$?
[[ $VRC2 -eq 0 ]] && pass "R6: verify-restore passes on a PG archive without the residual dump" || fail "R6 verify without file" "exit 0" "exit $VRC2: $(tail -5 <<<"$VOUT2")"

echo "R2: no database file"
R="$(mkrepo r2 none)"
OUT="$(run_backup "$R" pg)"; RC=$?
A="$(newest "$R")"
[[ $RC -eq 0 && -n "$A" ]] && pass "R2: backup exits 0 and still writes the archive" || fail "R2 backup" "exit 0 + archive" "exit $RC: $OUT"
grep -q 'WARNING -- the residual gate-audit tables are not in this archive' <<<"$OUT" && pass "R2: a warning is printed" || fail "R2 warning" "warning" "none: $OUT"
tar -tzf "$A" 2>/dev/null | grep -q 'residual-gate-audit' && fail "R2 no dump" "no dump file" "present" || pass "R2: no dump file in the archive"
tar -xzOf "$A" MANIFEST.txt 2>/dev/null | grep -q '^residual-gate-audit: NOT included' && pass "R2: MANIFEST says NOT included" || fail "R2 MANIFEST" "NOT included line" "absent"

echo "R3: one table missing"
R="$(mkrepo r3 one)"
OUT="$(run_backup "$R" pg)"; RC=$?
A="$(newest "$R")"
[[ $RC -eq 0 && -n "$A" ]] && pass "R3: backup exits 0 and writes the archive" || fail "R3 backup" "exit 0 + archive" "exit $RC"
grep -q 'residual table hook_audit_log is missing' <<<"$OUT" && pass "R3: the warning names the missing table" || fail "R3 warning" "names hook_audit_log" "$OUT"
X="$ROOT/r3-x"; mkdir -p "$X"; tar -xzf "$A" -C "$X" 2>/dev/null
if [[ -f "$X/repo/store/residual-gate-audit.sql" ]] && grep -q 'gate_decision_counts' "$X/repo/store/residual-gate-audit.sql" && ! grep -q 'hook_audit_log' "$X/repo/store/residual-gate-audit.sql"; then
  pass "R3: the present table is archived, the missing one is not invented"
else
  fail "R3 partial dump" "only gate_decision_counts" "$(head -c 200 "$X/repo/store/residual-gate-audit.sql" 2>/dev/null)"
fi

echo "R4: neither table / not a database"
R="$(mkrepo r4 garbage)"
OUT="$(run_backup "$R" pg)"; RC=$?
A="$(newest "$R")"
[[ $RC -eq 0 && -n "$A" ]] && pass "R4: a file that is not a database: exit 0, archive written" || fail "R4 garbage backup" "exit 0 + archive" "exit $RC: $OUT"
grep -q 'WARNING -- the residual gate-audit tables are not in this archive' <<<"$OUT" && pass "R4: a warning is printed" || fail "R4 warning" "warning" "none"
tar -tzf "$A" 2>/dev/null | grep -q 'residual-gate-audit' && fail "R4 no dump" "no dump file" "present" || pass "R4: no dump file"
R="$(mkrepo r4b none)"
sqlite3 "$R/store/claudeclaw.db" 'CREATE TABLE unrelated (x);' >/dev/null
OUT="$(run_backup "$R" pg)"; RC=$?
A="$(newest "$R")"
[[ $RC -eq 0 && -n "$A" ]] && grep -q 'none of hook_audit_log gate_decision_counts exists' <<<"$OUT" && ! tar -tzf "$A" | grep -q 'residual-gate-audit' \
  && pass "R4: a database without either table: warning, no dump file, exit 0" || fail "R4 no tables" "warning, no file, exit 0" "exit $RC: $OUT"

echo "R5: SQLite mode is unchanged"
R="$(mkrepo r5)"
OUT="$(run_backup "$R" sqlite)"; RC=$?
A="$(newest "$R")"
[[ $RC -eq 0 && -n "$A" ]] && pass "R5: backup exits 0" || fail "R5 backup" "exit 0" "exit $RC: $OUT"
LIST="$(tar -tzf "$A" 2>/dev/null)"
grep -q 'residual-gate-audit' <<<"$LIST" && fail "R5 no residual file" "absent" "present" || pass "R5: no residual file in a SQLite-mode archive"
grep -qx 'repo/store/claudeclaw.db' <<<"$LIST" && pass "R5: the database snapshot is archived as before" || fail "R5 database" "present" "absent"
tar -xzOf "$A" MANIFEST.txt 2>/dev/null | grep -q 'residual' && fail "R5 MANIFEST" "no residual line" "present" || pass "R5: MANIFEST has no residual line"
grep -q 'residual' <<<"$OUT" && fail "R5 output" "no residual output" "present" || pass "R5: no residual output on stdout/stderr"

echo "R8: the dump is taken from a copy, a hook write cannot corrupt it"
R="$(mkrepo r8)"
# a writer that holds the live file busy with a steady stream of inserts while the backup runs
( for i in $(seq 1 200); do sqlite3 -cmd '.timeout 2000' "$R/store/claudeclaw.db" "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES ($i, 'agent-w', 'egress', 'deny');" >/dev/null 2>&1; done ) &
WRITER=$!
OUT="$(run_backup "$R" pg)"; RC=$?
wait "$WRITER" 2>/dev/null
A="$(newest "$R")"
X="$ROOT/r8-x"; mkdir -p "$X"; tar -xzf "$A" -C "$X" 2>/dev/null
if [[ $RC -eq 0 && -f "$X/repo/store/residual-gate-audit.sql" ]] && sqlite3 "$ROOT/r8-replay.db" < "$X/repo/store/residual-gate-audit.sql" 2>/dev/null \
   && [[ "$(sqlite3 "$ROOT/r8-replay.db" 'PRAGMA integrity_check' 2>/dev/null)" == "ok" ]] \
   && [[ "$(sqlite3 "$ROOT/r8-replay.db" 'SELECT count(*) FROM hook_audit_log' 2>/dev/null)" -ge 2 ]]; then
  pass "R8: the dump taken under concurrent writes replays and the replayed database is intact"
else
  fail "R8 concurrent writes" "exit 0, dump replays, integrity ok" "exit $RC: $OUT"
fi
if ls "$ROOT/r8/store" 2>/dev/null | grep -q 'residual'; then fail "R8 no stray files" "no residual file in the install" "found"; else pass "R8: nothing is left in the install's store/ directory"; fi

echo "R9: the live file is read only for the two tables (no whole-file copy, one door)"
BLOCK="$(sed -n '/^RESIDUAL_REL=/,/^if \[\[ "\${PG_CONFIGURED}" -eq 1 \]\]; then$/p' "$INSTALL_DIR/scripts/backup.sh")"
[[ -n "$BLOCK" ]] || fail "R9 block found" "the residual block" "empty"
grep -v '^ *#' <<<"$BLOCK" | grep -q '\.backup\|VACUUM INTO' && fail "R9 no whole-file copy" "no .backup / VACUUM INTO" "found" || pass "R9: no .backup or VACUUM INTO of the live file"
N_SQLITE="$(grep -v '^ *#' <<<"$BLOCK" | grep -c 'sqlite3 ')"
[[ "$N_SQLITE" == "2" ]] && pass "R9: sqlite3 is called in two places only (the command check and the one helper)" || fail "R9 one door" "2 sqlite3 call sites (command -v + helper)" "$N_SQLITE"
grep -v '^ *#' <<<"$BLOCK" | grep -E 'SELECT' | grep -vq "sqlite_master WHERE type='table' AND name IN ('hook_audit_log','gate_decision_counts')" \
  && fail "R9 reads" "only the catalog read of the two names" "another SELECT" || pass "R9: the only SELECT is the catalog read of the two table names"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
