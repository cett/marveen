#!/bin/bash
# scripts/verify-restore.sh token contract: no agent/operator token file may be inside an archive (FAIL),
# an archive whose shared token is older than the live one is flagged (WARN, still exit 0), the run ends
# with the token steps, and the restore_log note says "token-step pending".
# Run: bash scripts/__tests__/verify-restore-tokens.test.sh
#
# The "repo" is a temp dir with a copy of the script, so REPO_ROOT (and the live DB) is the temp dir's:
# the real store/ is never touched. The shared-token comparison lives in the agent-tokens CLI (covered by
# src/__tests__/agent-tokens-check.test.ts); here `npm` is a stub that honours the same contract
# (prints predates | current | unknown for the extracted archive database), so what is tested is how
# verify-restore.sh reacts to each verdict, and that it hands the CLI the extracted archive copy.

set -u

if ! command -v sqlite3 >/dev/null 2>&1; then echo "SKIP: sqlite3 not installed"; exit 0; fi

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# The npm stub: `npm run --silent agent-tokens -- archive-shared-age <db>`, run from the repo root. It
# compares the newest active `dashboard` row of <db> with the one in ./store/claudeclaw.db, and records
# the database path it was handed.
mkdir -p "$TMPDIR_BASE/bin"
cat > "$TMPDIR_BASE/bin/npm" <<'STUB'
#!/bin/bash
db=""; for a in "$@"; do db="$a"; done
echo "$db" > "$PWD/npm-stub-arg"
q="SELECT COALESCE(MAX(created_at),0) FROM api_tokens WHERE name='dashboard' AND revoked_at IS NULL"
a="$(sqlite3 "$db" "$q" 2>/dev/null)" || { echo unknown; exit 0; }
l="$(sqlite3 store/claudeclaw.db "$q" 2>/dev/null)" || { echo unknown; exit 0; }
if [ "${a:-0}" -le 0 ] || [ "${l:-0}" -le 0 ]; then echo unknown
elif [ "$l" -gt "$a" ]; then echo predates
else echo current; fi
STUB
chmod +x "$TMPDIR_BASE/bin/npm"

# new_repo <name> [live_dashboard_created_at]: a fake install whose live DB has api_tokens + restore_log.
new_repo() {
  local r="$TMPDIR_BASE/$1"
  mkdir -p "$r/scripts" "$r/store" "$r/node_modules"
  cp "$INSTALL_DIR/scripts/verify-restore.sh" "$r/scripts/"
  sqlite3 "$r/store/claudeclaw.db" "
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER, revoked_at INTEGER);
    CREATE TABLE restore_log (archive_path TEXT, checksum TEXT, integrity_ok INTEGER, note TEXT);
    INSERT INTO api_tokens (name, created_at) VALUES ('dashboard', ${2:-1000});"
  echo "$r"
}

# make_archive <name> <archive_dashboard_created_at> [extra file path inside repo/]
make_archive() {
  local name="$1" created="$2" extra="${3:-}"
  local stage="$TMPDIR_BASE/stage-$name"
  mkdir -p "$stage/repo/store"
  echo "manifest" > "$stage/MANIFEST.txt"
  sqlite3 "$stage/repo/store/claudeclaw.db" "
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER, revoked_at INTEGER);
    INSERT INTO api_tokens (name, created_at) VALUES ('dashboard', ${created});"
  if [ -n "$extra" ]; then mkdir -p "$stage/repo/$(dirname "$extra")"; echo "not-a-real-token" > "$stage/repo/$extra"; fi
  tar -czf "$TMPDIR_BASE/$name.tar.gz" -C "$stage" MANIFEST.txt repo
  echo "$TMPDIR_BASE/$name.tar.gz"
}

run_verify() {  # run_verify <repo> <archive>; sets OUT, RC
  OUT="$(PATH="$TMPDIR_BASE/bin:$PATH" bash "$1/scripts/verify-restore.sh" "$2" 2>&1)"; RC=$?
}
log_note() { sqlite3 "$1/store/claudeclaw.db" 'SELECT note FROM restore_log ORDER BY rowid DESC LIMIT 1;'; }

echo "verify-restore.sh token checks"

# --- a clean archive, same age as the live shared token ---
R="$(new_repo clean 1000)"; A="$(make_archive clean 1000)"
run_verify "$R" "$A"
[ "$RC" -eq 0 ] && pass "clean archive: exit 0" || { fail "clean archive: exit $RC"; echo "$OUT"; }
grep -q "no agent or operator token file inside the archive" <<<"$OUT" && pass "clean archive: token-file check passes" || fail "clean archive: no token-file pass line"
grep -q "the archive's shared token is not older than the live one" <<<"$OUT" && pass "equal age: no resurrection warning" || fail "equal age: expected the not-older pass line"
! grep -q "WARN\] the archive predates" <<<"$OUT" && pass "equal age: no WARN" || fail "equal age: unexpected WARN"
grep -q "agent-tokens -- issue-operator" <<<"$OUT" && grep -q "BEFORE the dashboard and the agents start" <<<"$OUT" && pass "the output ends with the token steps" || fail "token steps missing from the output"
grep -q "token-step pending" <<<"$(log_note "$R")" && pass "restore_log note says token-step pending" || fail "restore_log note: '$(log_note "$R")'"
case "$(cat "$R/npm-stub-arg" 2>/dev/null)" in
  */repo/store/claudeclaw.db) pass "the CLI is handed the extracted archive copy" ;;
  *) fail "the CLI was handed '$(cat "$R/npm-stub-arg" 2>/dev/null)'" ;;
esac

# --- an agent token file inside the archive ---
R="$(new_repo agenttok 1000)"; A="$(make_archive agenttok 1000 "agents/alpha/.agent-token")"
run_verify "$R" "$A"
[ "$RC" -eq 1 ] && pass "agent token file in the archive: exit 1" || fail "agent token file in the archive: exit $RC"
grep -q "\[FAIL\] an agent or operator token file is INSIDE the archive" <<<"$OUT" && pass "agent token file: FAIL line names the problem" || fail "agent token file: no FAIL line"

# --- the main agent's root token file ---
R="$(new_repo roottok 1000)"; A="$(make_archive roottok 1000 ".agent-token")"
run_verify "$R" "$A"
[ "$RC" -eq 1 ] && pass "root .agent-token in the archive: exit 1" || fail "root .agent-token in the archive: exit $RC"

# --- the operator token file ---
R="$(new_repo operatortok 1000)"; A="$(make_archive operatortok 1000 "store/.operator-token")"
run_verify "$R" "$A"
[ "$RC" -eq 1 ] && pass "operator token file in the archive: exit 1" || fail "operator token file in the archive: exit $RC"

# --- decoys that are NOT token files must not trip the check ---
R="$(new_repo decoy 1000)"; A="$(make_archive decoy 1000 "agents/alpha/agent-token-notes.md")"
run_verify "$R" "$A"
[ "$RC" -eq 0 ] && pass "a file merely named like a token note: exit 0" || fail "decoy tripped the check: exit $RC"

# --- an archive from before a rotation: the live shared token row is newer ---
R="$(new_repo rotated 5000)"; A="$(make_archive rotated 1000)"
run_verify "$R" "$A"
[ "$RC" -eq 0 ] && pass "archive predating a rotation: still exit 0 (a warning, not a failure)" || fail "predating archive: exit $RC"
grep -q "\[WARN\] the archive predates the last rotation of the shared token" <<<"$OUT" && pass "predating archive: WARN names the rotation" || { fail "predating archive: no WARN"; echo "$OUT"; }
grep -q "WARN:archive predates shared token rotation" <<<"$(log_note "$R")" && pass "predating archive: the warning is in the restore_log note" || fail "restore_log note lacks the warning: '$(log_note "$R")'"

# --- an archive NEWER than the live DB (restoring onto an older install) is no resurrection ---
R="$(new_repo newer 1000)"; A="$(make_archive newer 5000)"
run_verify "$R" "$A"
! grep -q "WARN\] the archive predates" <<<"$OUT" && pass "newer archive: no WARN" || fail "newer archive: unexpected WARN"

# --- a verdict of unknown (older backup without the table) is skipped, not failed ---
R="$(new_repo oldarchive 1000)"
STAGE="$TMPDIR_BASE/stage-old"; mkdir -p "$STAGE/repo/store"; echo m > "$STAGE/MANIFEST.txt"
sqlite3 "$STAGE/repo/store/claudeclaw.db" 'CREATE TABLE t(x);'
tar -czf "$TMPDIR_BASE/old.tar.gz" -C "$STAGE" MANIFEST.txt repo
run_verify "$R" "$TMPDIR_BASE/old.tar.gz"
[ "$RC" -eq 0 ] && grep -q "skipping the shared token age check" <<<"$OUT" && pass "unknown verdict: skipped, exit 0" || fail "unknown verdict: exit $RC"

# --- no live database yet (a fresh machine): the CLI must NOT be run (it would create a database) ---
R="$(new_repo fresh 1000)"; rm -f "$R/store/claudeclaw.db"; A="$(make_archive fresh 1000)"
run_verify "$R" "$A"
[ ! -e "$R/npm-stub-arg" ] && pass "no live database: the CLI is not run" || fail "the CLI ran without a live database"
grep -q "skipping the shared token age check" <<<"$OUT" && pass "no live database: the age check is skipped" || fail "no live database: no skip line"

echo ""
echo "verify-restore tokens: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
