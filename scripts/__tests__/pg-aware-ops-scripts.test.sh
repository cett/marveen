#!/bin/bash
# The operations scripts on a PostgreSQL install: pre-modify-backup.sh, verify-restore.sh and migrate-main-agent-id.sh
# must not touch the frozen SQLite file (store/claudeclaw.db) and must not say they did.
#
# Every cell runs the real script in a throwaway install root (a copy of scripts/ and a SQLite store) with the
# PostgreSQL layer set ONE at a time (the environment, the .env file, the marker). A PATH shim for sqlite3, launchctl
# and tmux logs every call, so "never opened the frozen file" and "no side effect" are measured, not read off the code.
# The URL is a placeholder with a marker string; it must never reach any output.
#
# Cells:
#   P1  pre-modify-backup on PostgreSQL: no database snapshot, no "consistent snapshot ok", the NOT captured line,
#       exit 0, zero sqlite3 calls; P1b the newest dump is named (a probe dump never is); P1c no dump is said so
#   P2  pre-modify-backup on SQLite: the snapshot is taken and says so, no NOT captured line
#   P3  pre-modify-backup with the helper missing: refuses (exit 1) before it creates a snapshot directory
#   V1  verify-restore on a PostgreSQL install: restore_log keeps 0 rows, the "not written" line, the exit code it was
#       (a PostgreSQL archive: plain 0, drill 3; an old SQLite archive on a PostgreSQL install: 0), zero sqlite3 calls
#       for a PostgreSQL archive; V1n the plain run of a PostgreSQL archive says the database was NOT checked
#   V2  verify-restore on SQLite: one restore_log row, no "not written" line
#   V3  verify-restore with the helper missing: stops, writes nothing
#   M1  migrate-main-agent-id on PostgreSQL with a non-default slug: exit 1, the message, no side effect (frozen file
#       hash, .env bytes, plist, launchctl/tmux shims), the prompt is never reached
#   M2  the default slug: exit 0 as before (the guard sits after the early exit)
#   M3  migrate-main-agent-id with the helper missing: stops, no side effect
#
# SRC_SCRIPTS: another copy of scripts/ (how a mutant is run against these cells).
# Run: bash scripts/__tests__/pg-aware-ops-scripts.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

REAL_SQLITE="$(command -v sqlite3 || true)"
if [[ -z "$REAL_SQLITE" ]]; then echo "  SKIP: sqlite3 is missing, the cells need it"; exit 0; fi

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${SRC_SCRIPTS:-$INSTALL_DIR/scripts}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

URL='postgres://leakmarker-user:leakmarker-pass@leakmarker-host.invalid:5432/leakmarker'
MARK='leakmarker'
SHIM_LOG="$ROOT/shim.log"
mkdir -p "$ROOT/bin" "$ROOT/home/Library/LaunchAgents" "$ROOT/nomount"
printf 'y\n' > "$ROOT/stdin-yes"

# the shims: sqlite3 logs and runs the real one, launchctl and tmux only log
cat > "$ROOT/bin/sqlite3" <<EOF
#!/bin/bash
printf 'sqlite3 %s\n' "\$*" >> "\$SHIM_LOG"
exec "$REAL_SQLITE" "\$@"
EOF
for n in launchctl tmux; do
  printf '#!/bin/bash\nprintf "%s %%s\\n" "$*" >> "$SHIM_LOG"\nexit 0\n' "$n" > "$ROOT/bin/$n"
done
chmod +x "$ROOT/bin/sqlite3" "$ROOT/bin/launchctl" "$ROOT/bin/tmux"

sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }

# mk_install <name> [nohelper]: a throwaway install with a frozen SQLite file (memories + an EMPTY restore_log)
mk_install() {
  local r="$ROOT/$1"
  mkdir -p "$r/scripts/lib" "$r/store"
  cp "$SRC/pre-modify-backup.sh" "$SRC/verify-restore.sh" "$SRC/migrate-main-agent-id.sh" "$r/scripts/"
  cp "$SRC/lib/portable.sh" "$r/scripts/lib/" 2>/dev/null || true
  [[ "${2:-}" == nohelper ]] || cp "$SRC/pg-configured.sh" "$r/scripts/"
  "$REAL_SQLITE" "$r/store/claudeclaw.db" \
    "CREATE TABLE memories (id INTEGER PRIMARY KEY, agent_id TEXT, body TEXT); INSERT INTO memories (agent_id, body) VALUES ('marveen', 'one');
     CREATE TABLE restore_log (archive_path TEXT, checksum TEXT, integrity_ok INTEGER, note TEXT);"
  echo "$r"
}

# run_in <install> <layer> <script> [args...]: sets OUT (stdout + stderr), RC. The PostgreSQL layer is set in ONE place:
#   env | file | marker | none. The .env always exists (migrate-main-agent-id requires it); BOT_NAME comes from $BOT.
BOT=""
run_in() {
  local r="$1" layer="$2" script="$3"
  shift 3
  local envs=(PATH="$ROOT/bin:$PATH" HOME="$ROOT/home" SHIM_LOG="$SHIM_LOG" SECRET_MOUNT_DIR="$ROOT/nomount")
  [[ -n "$BOT" ]] && printf 'BOT_NAME="%s"\n' "$BOT" > "$r/.env" || printf 'OTHER_KEY=1\n' > "$r/.env"
  case "$layer" in
    env) envs+=(MARVEEN_PG_URL="$URL") ;;
    file) printf 'MARVEEN_PG_URL=%s\n' "$URL" >> "$r/.env" ;;
    marker) envs+=(MARVEEN_PG_CONFIGURED=1) ;;
    none) ;;
  esac
  [[ -n "${EXTRA_ENV:-}" ]] && envs+=("$EXTRA_ENV")
  OUT="$(cd "$r" && env -i "${envs[@]}" bash "scripts/$script" "$@" 2>&1 < "$ROOT/stdin-yes")"; RC=$?
}

shim_calls() { grep -c "^$1" "$SHIM_LOG" 2>/dev/null || true; }
reset_log() { : > "$SHIM_LOG"; }
log_rows() { "$REAL_SQLITE" "$1/store/claudeclaw.db" 'SELECT COUNT(*) FROM restore_log;'; }
no_leak() { if ! grep -q "$MARK" <<<"$OUT"; then pass "$1: the URL is not in the output"; else fail "$1 leak" "no $MARK" "found"; fi; }

# ---------------------------------------------------------------------------------------------------------------------
echo "pre-modify-backup.sh"
for layer in env file marker; do
  R="$(mk_install p1-$layer)"; reset_log; BOT=""
  FROZEN_BEFORE="$(sha_of "$R/store/claudeclaw.db")"
  EXTRA_ENV="PG_DRILL_DUMP_DIR=$ROOT/no-dumps" run_in "$R" "$layer" pre-modify-backup.sh p1
  SNAP="$(ls -1d "$R"/store/backups/*-p1 2>/dev/null | head -1)"
  [[ $RC -eq 0 ]] && pass "P1 $layer: exit 0" || fail "P1 $layer exit" "0" "$RC"
  [[ -n "$SNAP" && ! -e "$SNAP/claudeclaw.db" ]] && pass "P1 $layer: no database in the snapshot" || fail "P1 $layer snapshot" "a snapshot dir without claudeclaw.db" "${SNAP:-none}"
  if ! grep -q 'consistent snapshot ok' <<<"$OUT"; then pass "P1 $layer: no 'consistent snapshot ok'"; else fail "P1 $layer false green" "no 'consistent snapshot ok'" "present"; fi
  if grep -qF 'db: NOT captured (PostgreSQL install): the database is in PostgreSQL; the newest nightly dump is the restore point' <<<"$OUT"; then pass "P1 $layer: the NOT captured line"; else fail "P1 $layer NOT captured" "the line" "absent"; fi
  if [[ "$(tail -n 1 <<<"$OUT")" == *'-- DATABASE NOT INCLUDED (PostgreSQL install)' ]]; then pass "P1 $layer: the LAST line says DATABASE NOT INCLUDED"; else fail "P1 $layer last line" "ends with -- DATABASE NOT INCLUDED (PostgreSQL install)" "$(tail -n 1 <<<"$OUT")"; fi
  [[ "$(shim_calls sqlite3)" == "0" ]] && pass "P1 $layer: zero sqlite3 calls" || fail "P1 $layer sqlite3 calls" "0" "$(shim_calls sqlite3)"
  [[ "$(sha_of "$R/store/claudeclaw.db")" == "$FROZEN_BEFORE" ]] && pass "P1 $layer: the frozen file is unchanged" || fail "P1 $layer frozen file" "same sha" "changed"
  no_leak "P1 $layer"
done

# P1b: the newest nightly dump is named with its age; a probe dump and a foreign file never are
DUMPS="$ROOT/dumps"; mkdir -p "$DUMPS"
touch -t 202611260330 "$DUMPS/marveen-20261126-033014.dump"
touch -t 202611270330 "$DUMPS/marveen-20261127-033014.dump"
touch "$DUMPS/marveen-probe-20261128.dump" "$DUMPS/notes.txt"
R="$(mk_install p1b)"; BOT=""
EXTRA_ENV="PG_DRILL_DUMP_DIR=$DUMPS" run_in "$R" env pre-modify-backup.sh p1b
if grep -qE 'newest dump: marveen-20261127-033014\.dump \([0-9]+ h old\)' <<<"$OUT"; then pass "P1b: the newest nightly dump is named with its age"; else fail "P1b newest dump" "marveen-20261127-033014.dump (N h old)" "$(grep 'dump' <<<"$OUT" | head -2 | tr '\n' '|')"; fi
if ! grep -q 'probe' <<<"$OUT"; then pass "P1b: a probe dump is never named"; else fail "P1b probe" "no probe name" "named"; fi
# P1c: no dump at all
R="$(mk_install p1c)"; BOT=""
EXTRA_ENV="PG_DRILL_DUMP_DIR=$ROOT/empty-dumps" run_in "$R" env pre-modify-backup.sh p1c
if grep -q 'newest dump: none found' <<<"$OUT"; then pass "P1c: no dump is said so"; else fail "P1c no dump" "newest dump: none found" "$(head -c 200 <<<"$OUT")"; fi

# P2: SQLite install, no PostgreSQL layer: the snapshot is taken and says so
R="$(mk_install p2)"; reset_log; BOT=""
run_in "$R" none pre-modify-backup.sh p2
SNAP="$(ls -1d "$R"/store/backups/*-p2 2>/dev/null | head -1)"
[[ $RC -eq 0 && -f "$SNAP/claudeclaw.db" ]] && pass "P2: SQLite install: the database snapshot is there, exit 0" || fail "P2 snapshot" "claudeclaw.db in the snapshot" "exit $RC"
grep -q 'db: consistent snapshot ok' <<<"$OUT" && pass "P2: SQLite install: says 'consistent snapshot ok'" || fail "P2 line" "consistent snapshot ok" "absent"
if ! grep -q 'NOT captured' <<<"$OUT"; then pass "P2: SQLite install: no NOT captured line"; else fail "P2 NOT captured" "absent" "present"; fi
if [[ "$(tail -n 1 <<<"$OUT")" == backup\ ok:* && "$(tail -n 1 <<<"$OUT")" != *'NOT INCLUDED'* ]]; then pass "P2: SQLite install: the last line is the plain 'backup ok' line"; else fail "P2 last line" "backup ok: ... without NOT INCLUDED" "$(tail -n 1 <<<"$OUT")"; fi

# P3: the helper is missing: refuse loudly, before any snapshot directory exists, never take the SQLite branch
R="$(mk_install p3 nohelper)"; reset_log; BOT=""
run_in "$R" none pre-modify-backup.sh p3
if [[ $RC -eq 1 ]] && grep -q 'pg-configured.sh is missing' <<<"$OUT"; then pass "P3: helper missing: exit 1 with the error"; else fail "P3 helper missing" "exit 1 and the error" "exit $RC: $(head -c 160 <<<"$OUT")"; fi
if [[ -z "$(ls -A "$R/store/backups" 2>/dev/null)" && "$(shim_calls sqlite3)" == "0" ]]; then pass "P3: helper missing: no snapshot directory, zero sqlite3 calls"; else fail "P3 side effect" "nothing created" "something was"; fi

# ---------------------------------------------------------------------------------------------------------------------
echo "verify-restore.sh"
# a PostgreSQL archive (no database inside, the MANIFEST says so) and a SQLite archive of the old kind
STAGE="$ROOT/stage-pg"; mkdir -p "$STAGE/repo"
printf 'database: not included (PostgreSQL install)\n' > "$STAGE/MANIFEST.txt"; echo placeholder > "$STAGE/repo/placeholder.txt"
tar -czf "$ROOT/pg.tar.gz" -C "$STAGE" MANIFEST.txt repo
STAGE="$ROOT/stage-sqlite"; mkdir -p "$STAGE/repo/store"
printf 'manifest\n' > "$STAGE/MANIFEST.txt"
"$REAL_SQLITE" "$STAGE/repo/store/claudeclaw.db" 'CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO memories (body) VALUES ("one");'
tar -czf "$ROOT/sqlite.tar.gz" -C "$STAGE" MANIFEST.txt repo

for layer in env file marker; do
  R="$(mk_install v1-$layer)"; reset_log; BOT=""
  FROZEN_BEFORE="$(sha_of "$R/store/claudeclaw.db")"
  run_in "$R" "$layer" verify-restore.sh "$ROOT/pg.tar.gz"
  [[ $RC -eq 0 ]] && pass "V1 $layer: PostgreSQL archive, plain: exit 0 as before" || fail "V1 $layer exit" "0" "$RC: $(tail -c 200 <<<"$OUT")"
  [[ "$(log_rows "$R")" == "0" ]] && pass "V1 $layer: restore_log still has 0 rows" || fail "V1 $layer rows" "0" "$(log_rows "$R")"
  grep -qF 'restore_log: not written (PostgreSQL install: the frozen SQLite file is not a log target)' <<<"$OUT" && pass "V1 $layer: the 'not written' line" || fail "V1 $layer line" "the not written line" "absent"
  [[ "$(shim_calls sqlite3)" == "0" ]] && pass "V1 $layer: zero sqlite3 calls" || fail "V1 $layer sqlite3 calls" "0" "$(shim_calls sqlite3)"
  [[ "$(sha_of "$R/store/claudeclaw.db")" == "$FROZEN_BEFORE" ]] && pass "V1 $layer: the frozen file is unchanged" || fail "V1 $layer frozen file" "same sha" "changed"
  no_leak "V1 $layer"
  # the drill of the same archive: NOT APPLICABLE, exit 3, still no row
  run_in "$R" "$layer" verify-restore.sh --drill "$ROOT/pg.tar.gz"
  [[ $RC -eq 3 && "$(log_rows "$R")" == "0" ]] && pass "V1 $layer: drill: exit 3 (NOT APPLICABLE), still 0 rows" || fail "V1 $layer drill" "exit 3 and 0 rows" "exit $RC, $(log_rows "$R") rows"
done

# V1n: the plain run of a PostgreSQL archive must not end on a bare "ALL CHECKS PASSED": it says the database was not checked
R="$(mk_install v1n)"; BOT=""
run_in "$R" env verify-restore.sh "$ROOT/pg.tar.gz"
if grep -q 'the database was NOT checked or compared' <<<"$OUT"; then pass "V1n: a PostgreSQL archive, plain run: says the database was NOT checked"; else fail "V1n note" "the NOT checked note" "absent"; fi
run_in "$R" none verify-restore.sh "$ROOT/sqlite.tar.gz"
if ! grep -q 'the database was NOT checked or compared' <<<"$OUT"; then pass "V1n: a SQLite archive: no such note"; else fail "V1n sqlite" "absent" "present"; fi

# V1b: an old SQLite archive verified on a PostgreSQL install: the install decides, no row in the frozen file
R="$(mk_install v1b)"; BOT=""
run_in "$R" env verify-restore.sh "$ROOT/sqlite.tar.gz"
[[ $RC -eq 0 && "$(log_rows "$R")" == "0" ]] && pass "V1b: SQLite archive on a PostgreSQL install: exit 0, 0 rows in the frozen file" || fail "V1b" "exit 0 and 0 rows" "exit $RC, $(log_rows "$R") rows"

# V2: SQLite install: one row, no 'not written' line (no regression)
R="$(mk_install v2)"; BOT=""
run_in "$R" none verify-restore.sh "$ROOT/sqlite.tar.gz"
[[ $RC -eq 0 && "$(log_rows "$R")" == "1" ]] && pass "V2: SQLite install: exit 0 and one restore_log row" || fail "V2" "exit 0 and 1 row" "exit $RC, $(log_rows "$R") rows"
if ! grep -q 'restore_log: not written' <<<"$OUT"; then pass "V2: SQLite install: no 'not written' line"; else fail "V2 line" "absent" "present"; fi

# V3: the helper is missing: the script stops, it does not fall to the SQLite branch and write a row
R="$(mk_install v3 nohelper)"; BOT=""
run_in "$R" none verify-restore.sh "$ROOT/sqlite.tar.gz"
[[ $RC -ne 0 && "$(log_rows "$R")" == "0" ]] && pass "V3: helper missing: the script stops (exit $RC), nothing written" || fail "V3" "non-zero exit and 0 rows" "exit $RC, $(log_rows "$R") rows"

# ---------------------------------------------------------------------------------------------------------------------
echo "migrate-main-agent-id.sh"
cp /dev/null "$ROOT/home/Library/LaunchAgents/com.marveen.dashboard.plist"
for layer in env file marker; do
  R="$(mk_install m1-$layer)"; reset_log; BOT="Probe Agent"
  FROZEN_BEFORE="$(sha_of "$R/store/claudeclaw.db")"
  run_in "$R" "$layer" migrate-main-agent-id.sh
  ENV_AFTER_RUN="$(cat "$R/.env")"
  EXPECT_ENV='BOT_NAME="Probe Agent"'; [[ "$layer" == file ]] && EXPECT_ENV="$EXPECT_ENV
MARVEEN_PG_URL=$URL"
  [[ $RC -eq 1 ]] && pass "M1 $layer: exit 1" || fail "M1 $layer exit" "1" "$RC: $(head -c 160 <<<"$OUT")"
  grep -qF 'ERROR: this install runs on PostgreSQL; the main agent id rename rewrites the frozen SQLite file only and would split the database from MAIN_AGENT_ID. Not supported on PostgreSQL yet.' <<<"$OUT" && pass "M1 $layer: the message" || fail "M1 $layer message" "the PostgreSQL error" "$(head -c 160 <<<"$OUT")"
  if ! grep -q 'Migrating main agent id' <<<"$OUT"; then pass "M1 $layer: the prompt is never reached"; else fail "M1 $layer prompt" "no 'Migrating' line" "reached"; fi
  [[ "$(sha_of "$R/store/claudeclaw.db")" == "$FROZEN_BEFORE" ]] && pass "M1 $layer: the frozen file hash is unchanged" || fail "M1 $layer frozen file" "same sha" "changed"
  [[ "$("$REAL_SQLITE" "$R/store/claudeclaw.db" "SELECT agent_id FROM memories;")" == "marveen" ]] && pass "M1 $layer: the rows keep the old id" || fail "M1 $layer rows" "marveen" "changed"
  [[ "$ENV_AFTER_RUN" == "$EXPECT_ENV" ]] && pass "M1 $layer: .env is byte-identical (no MAIN_AGENT_ID written)" || fail "M1 $layer .env" "$EXPECT_ENV" "$ENV_AFTER_RUN"
  [[ -f "$ROOT/home/Library/LaunchAgents/com.marveen.dashboard.plist" && ! -e "$ROOT/home/Library/LaunchAgents/com.probe-agent.dashboard.plist" ]] && pass "M1 $layer: the plist is not renamed" || fail "M1 $layer plist" "untouched" "renamed"
  if [[ "$(shim_calls launchctl)" == "0" && "$(shim_calls tmux)" == "0" && "$(shim_calls sqlite3)" == "0" ]]; then pass "M1 $layer: zero launchctl, tmux and sqlite3 calls"; else fail "M1 $layer shim calls" "0/0/0" "$(shim_calls launchctl)/$(shim_calls tmux)/$(shim_calls sqlite3)"; fi
  no_leak "M1 $layer"
done

# M2: the default slug on a PostgreSQL install: exit 0 as today (the guard sits after the early exit)
R="$(mk_install m2)"; reset_log; BOT=""
run_in "$R" env migrate-main-agent-id.sh
[[ $RC -eq 0 ]] && pass "M2: default slug on PostgreSQL: exit 0" || fail "M2 exit" "0" "$RC: $(head -c 160 <<<"$OUT")"
grep -q 'Nothing to migrate' <<<"$OUT" && pass "M2: default slug on PostgreSQL: 'Nothing to migrate'" || fail "M2 line" "Nothing to migrate" "absent"
if ! grep -q 'runs on PostgreSQL' <<<"$OUT"; then pass "M2: the refusal is not printed for the default slug"; else fail "M2 refusal" "absent" "printed"; fi

# M3: the helper is missing on a non-default slug: stops, no side effect, does not fall to the SQLite branch
R="$(mk_install m3 nohelper)"; reset_log; BOT="Probe Agent"
FROZEN_BEFORE="$(sha_of "$R/store/claudeclaw.db")"
run_in "$R" none migrate-main-agent-id.sh
if [[ $RC -ne 0 ]] && ! grep -q 'Migrating main agent id' <<<"$OUT" && [[ "$(sha_of "$R/store/claudeclaw.db")" == "$FROZEN_BEFORE" && "$(shim_calls launchctl)" == "0" ]]; then
  pass "M3: helper missing: the script stops (exit $RC), no side effect"
else
  fail "M3" "non-zero exit, no Migrating line, no side effect" "exit $RC"
fi

echo ""
echo "pg-aware-ops-scripts: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
