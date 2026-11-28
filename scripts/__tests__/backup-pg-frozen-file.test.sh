#!/bin/bash
# scripts/backup.sh on a PostgreSQL install never opens the frozen SQLite file (store/claudeclaw.db) and archives nothing
# of it. (Until the gate hooks wrote their audit rows to PostgreSQL, a block of backup.sh dumped two tables of the frozen
# file into repo/store/residual-gate-audit.sql; that block is gone and these cells replace the ones that tested it.)
#
# Cells:
#   B1 PostgreSQL install, the layer set ONE at a time (the environment, the .env file, the marker): the archive has no
#      repo/store/residual-gate-audit.sql and no claudeclaw.db, MANIFEST.txt has no residual line and still says the
#      database is not included, no row of the frozen file (a marker in every table) is anywhere in the archive, the
#      sqlite3 shim logged ZERO calls in the run, and the SHA-256 of the frozen file (and of its -wal) is unchanged
#   B2 a SQLite install (no PostgreSQL layer) archives the database snapshot as before: no residual file or line, no
#      residual output
#   B3 the PostgreSQL URL never appears in the output, the archive listing or the MANIFEST (the archived .env may carry it)
#
# SRC_SCRIPTS: another copy of scripts/ (how a mutant is run against these cells).
# Run: bash scripts/__tests__/backup-pg-frozen-file.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

REAL_SQLITE="$(command -v sqlite3 || true)"
if [[ -z "$REAL_SQLITE" ]]; then echo "SKIP: sqlite3 not installed"; exit 0; fi

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${SRC_SCRIPTS:-$INSTALL_DIR/scripts}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

URL='postgres://leakmarker-user:leakmarker-pass@leakmarker-host.invalid:5432/leakmarker'
MARK='leakmarker'
ROW_MARK_A='frozen-audit-row-marker-91c2'
ROW_MARK_B='frozen-memory-row-marker-4be7'
SHIM_LOG="$ROOT/shim.log"
mkdir -p "$ROOT/bin" "$ROOT/nomount"
cat > "$ROOT/bin/sqlite3" <<EOF
#!/bin/bash
printf 'sqlite3 %s\n' "\$*" >> "\$SHIM_LOG"
exec "$REAL_SQLITE" "\$@"
EOF
chmod +x "$ROOT/bin/sqlite3"

sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }

# mkrepo <name>: a temp install with the scripts, its own empty HOME and a frozen SQLite file in WAL mode with the two
# former residual tables and an unrelated one, a marker row in each. The writing connection is closed, so a -wal may or
# may not be left behind; whatever is there is hashed.
mkrepo() {
  local r="$ROOT/$1"
  mkdir -p "$r/scripts/lib" "$r/store" "$r/home"
  printf '[]\n' > "$r/scheduled-tasks.json"
  cp "$SRC/backup.sh" "$SRC/pg-configured.sh" "$r/scripts/"
  cp "$SRC/lib/portable.sh" "$r/scripts/lib/" 2>/dev/null || true
  "$REAL_SQLITE" "$r/store/claudeclaw.db" "PRAGMA journal_mode=WAL;
    CREATE TABLE hook_audit_log (id INTEGER PRIMARY KEY, ts INTEGER, agent_id TEXT, hook_type TEXT, verdict TEXT);
    CREATE TABLE gate_decision_counts (gate TEXT, decision TEXT, reason TEXT, count INTEGER, PRIMARY KEY (gate, decision, reason));
    CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES (1700000000, '$ROW_MARK_A', 'egress', 'deny');
    INSERT INTO gate_decision_counts VALUES ('egress', 'allow', 'ok', 41);
    INSERT INTO memories (body) VALUES ('$ROW_MARK_B');" >/dev/null
  echo "$r"
}

# run_backup <repo> <layer>: the real script; layer env | file | marker | none (the PostgreSQL layer in ONE place)
run_backup() {
  local r="$1" layer="$2"
  local envs=(PATH="$ROOT/bin:$PATH" HOME="$r/home" BACKUP_SECURITY_BIN=/usr/bin/false SECRET_MOUNT_DIR="$ROOT/nomount" SHIM_LOG="$SHIM_LOG")
  rm -f "$r/.env"
  case "$layer" in
    env) envs+=(MARVEEN_PG_URL="$URL") ;;
    file) printf 'MARVEEN_PG_URL=%s\n' "$URL" > "$r/.env" ;;
    marker) envs+=(MARVEEN_PG_CONFIGURED=1) ;;
  esac
  (cd "$r" && env -i "${envs[@]}" bash scripts/backup.sh 2>&1)
}
newest() { ls -1t "$1"/backups/claudeclaw-*.tar.gz 2>/dev/null | head -1; }
sha_wal() { if [[ -f "$1/store/claudeclaw.db-wal" ]]; then sha_of "$1/store/claudeclaw.db-wal"; else echo none; fi; }

for layer in env file marker; do
  R="$(mkrepo b1-$layer)"; : > "$SHIM_LOG"
  DB_BEFORE="$(sha_of "$R/store/claudeclaw.db")"; WAL_BEFORE="$(sha_wal "$R")"
  OUT="$(run_backup "$R" "$layer")"; RC=$?
  A="$(newest "$R")"
  LIST="$(tar -tzf "$A" 2>/dev/null)"
  MAN="$(tar -xzOf "$A" MANIFEST.txt 2>/dev/null)"
  X="$ROOT/x-$layer"; mkdir -p "$X"; tar -xzf "$A" -C "$X" 2>/dev/null

  [[ $RC -eq 0 && -n "$A" ]] && pass "B1 $layer: backup exits 0 and writes an archive" || fail "B1 $layer backup" "exit 0 and an archive" "exit $RC: $(tail -c 300 <<<"$OUT")"
  if ! grep -q 'residual' <<<"$LIST"; then pass "B1 $layer: no residual dump in the archive"; else fail "B1 $layer residual file" "none" "$(grep residual <<<"$LIST")"; fi
  if ! grep -q 'claudeclaw.db' <<<"$LIST"; then pass "B1 $layer: no database file in the archive"; else fail "B1 $layer database" "none" "present"; fi
  if ! grep -qi 'residual' <<<"$MAN"; then pass "B1 $layer: MANIFEST.txt has no residual line"; else fail "B1 $layer MANIFEST" "no residual line" "$(grep -i residual <<<"$MAN")"; fi
  grep -qxF 'database: not included (PostgreSQL install)' <<<"$MAN" && pass "B1 $layer: MANIFEST says the database is not included" || fail "B1 $layer MANIFEST database line" "present" "absent"
  if ! grep -rqE "$ROW_MARK_A|$ROW_MARK_B" "$X" 2>/dev/null; then pass "B1 $layer: no row of the frozen file is anywhere in the archive"; else fail "B1 $layer frozen rows" "none" "found"; fi
  if ! grep -qi 'residual' <<<"$OUT"; then pass "B1 $layer: the run says nothing about residual tables"; else fail "B1 $layer output" "no residual text" "present"; fi
  [[ "$(grep -c '^sqlite3' "$SHIM_LOG")" == "0" ]] && pass "B1 $layer: the sqlite3 shim logged ZERO calls" || fail "B1 $layer sqlite3 calls" "0" "$(grep '^sqlite3' "$SHIM_LOG" | head -2 | tr '\n' '|')"
  [[ "$(sha_of "$R/store/claudeclaw.db")" == "$DB_BEFORE" && "$(sha_wal "$R")" == "$WAL_BEFORE" ]] && pass "B1 $layer: the frozen file and its -wal are byte-identical" || fail "B1 $layer frozen file" "same SHA-256" "changed"
  # (the archive CONTENT may carry the install's own .env, by design; the output, the listing and the MANIFEST must not)
  if ! grep -q "$MARK" <<<"$OUT$LIST$MAN"; then pass "B3 $layer: the PostgreSQL URL is not in the output, the listing or the MANIFEST"; else fail "B3 $layer leak" "no $MARK" "found"; fi
done

# B2: a SQLite install: the snapshot is archived as before, nothing residual anywhere
R="$(mkrepo b2)"; : > "$SHIM_LOG"
OUT="$(run_backup "$R" none)"; RC=$?
A="$(newest "$R")"; LIST="$(tar -tzf "$A" 2>/dev/null)"; MAN="$(tar -xzOf "$A" MANIFEST.txt 2>/dev/null)"
[[ $RC -eq 0 && -n "$A" ]] && pass "B2: SQLite install: backup exits 0" || fail "B2 backup" "exit 0" "exit $RC: $(tail -c 300 <<<"$OUT")"
grep -qx 'repo/store/claudeclaw.db' <<<"$LIST" && pass "B2: SQLite install: the database snapshot is archived as before" || fail "B2 database" "present" "absent"
if ! grep -qi 'residual' <<<"$LIST$MAN$OUT"; then pass "B2: SQLite install: no residual file, MANIFEST line or output"; else fail "B2 residual" "none" "present"; fi
if ! grep -q 'database: not included' <<<"$MAN"; then pass "B2: SQLite install: MANIFEST does not say the database is missing"; else fail "B2 MANIFEST" "no 'not included' line" "present"; fi

echo ""
echo "backup-pg-frozen-file: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
