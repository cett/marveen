#!/usr/bin/env bash
# pg-restore-drill.sh -- the weekly restore drill of a PostgreSQL install: proves that the newest nightly dump restores.
#
# Usage: bash scripts/pg-restore-drill.sh
#
# What it does, in order:
#   1. takes the newest ${PG_DRILL_DUMP_DIR:-$HOME/pg-backups}/marveen-<date>-<time>.dump and fails when there is none,
#      when it is older than 36 hours (the nightly dump has stopped), when its .sha256 sidecar is missing or does not
#      match, or when pg_restore cannot list it;
#   2. checks what the restore needs and says exactly what is missing (see "One-time setup" below);
#   3. first drops throwaway databases an earlier, killed run left behind (see "ORPHANS"), then creates a throwaway
#      database marveen_drill_<stamp>_<pid> as the DRILL role, restores the dump into it with pg_restore, compares the
#      row counts of a fixed list of key tables with the LIVE database, and ALWAYS drops the throwaway database again
#      (an EXIT trap: success, failure, signal, set -e abort);
#   4. prints ONE summary line as the very last line and exits 0 (OK) or 1 (FAIL). Nothing is restored over the live
#      database: the live database is only read, and only through the BACKUP role.
#
# THE COMPARISON RULE (the live database keeps growing for the hours between the dump and the drill):
#   for every table of the list, restored = rows in the restored copy, live = rows in the live database;
#     - restored > live            FAIL  (the dump holds rows the live database lacks: rows were lost, or this is another
#                                         database's dump);
#     - restored = 0 and live > 0  FAIL  (an empty table after a restore is a failed restore, whatever the tolerance);
#     - live - restored > allowed  FAIL  with allowed = max(PG_DRILL_TOL_ABS, restored * PG_DRILL_TOL_PCT / 100),
#                                        defaults 2 rows and 10 percent;
#     - otherwise OK. A table that cannot be counted on either side (missing in the restored copy) is a FAIL.
#   BOTH sides are counted through the read-only BACKUP role (it bypasses row-level security): the restored tables are under
#   forced row-level security, so the drill role that owns them would be bound by it and count 0. Because the restore uses
#   --no-acl, the backup role holds no grant on the restored copy; the script gives it SELECT right after the restore, as
#   the drill role (the owner of the copy), which is the one grant of the whole run.
#
# Credentials never appear on a command line (ps shows argv) and are never printed: libpq reads them from PGPASSFILE
# files outside the repository, the same way the nightly dump does (command task nightly-pg-dump):
#   backup role: ${PG_DRILL_BACKUP_PASSFILE:-$HOME/.pgpass-marveen-backup}   (exists, the nightly dump uses it)
#   drill role:  ${PG_DRILL_PASSFILE:-$HOME/.pgpass-marveen-drill}     (new, mode 0600, one line:
#                127.0.0.1:5432:*:marveen_drill:<drill-password>   the database field is * because the throwaway
#                database name changes every run)
# The BACKUP role's file must have * in its database field too, for the same reason: the script connects as the backup
# role to the throwaway database (libpq knows only a complete * there, no partial marveen_drill_*), and the nightly dump
# works with * as well. The script checks this against the template database BEFORE it creates anything.
#
# THE DRILL ROLE is its own role, NOT marveen_owner: LOGIN, CREATEDB, NOSUPERUSER, NOBYPASSRLS, no grant on and no
# membership in anything that reaches the live database. The script refuses to run when it can read a live table.
#
# ORPHANS: a run that is killed (SIGKILL, the command task's timeout) skips the EXIT trap and leaves its throwaway database.
# At the start of every run the script drops each database that (a) is named marveen_drill_<14 digit UTC stamp>_<pid>,
# (b) is OWNED by the drill role (pg_database.datdba: only this script's role can have created it) and (c) carries a stamp
# older than 24 hours. A younger one (maybe a run in progress) and one of another owner are never touched.
#
# ONE-TIME SETUP, as a PostgreSQL superuser (docs/pg-provisioning.md, "The weekly restore drill"). The script checks each
# item before it creates anything and names the missing one:
#   CREATE ROLE marveen_drill LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD '<drill-password>';
#   CREATE DATABASE marveen_drill_tpl;            -- an empty database that only holds the two extensions
#   \c marveen_drill_tpl
#   CREATE EXTENSION vector; CREATE EXTENSION unaccent;   -- pgvector is not a trusted extension: the drill role cannot create it
#   ALTER DATABASE marveen_drill_tpl IS_TEMPLATE true;
# The throwaway database is cloned from that template, so the restore skips the EXTENSION entries of the dump, and it
# restores with --no-owner --no-acl (no owner, grant or default privilege of the dump is replayed: the dump's default
# privileges name marveen_owner, and replaying them would need the drill role to be a member of it, which it must not be).
#
# Environment overrides (tests, other layouts): PG_DRILL_DUMP_DIR, PG_DRILL_MAX_AGE_MIN (default 2160), PG_DRILL_BIN_DIR
# (default /opt/homebrew/opt/postgresql@16/bin, then PATH), PG_DRILL_HOST, PG_DRILL_PORT, PG_DRILL_DB (live database),
# PG_DRILL_MAINT_DB (the database the drill role connects to for CREATE/DROP DATABASE, default postgres), PG_DRILL_ROLE,
# PG_DRILL_BACKUP_ROLE, PG_DRILL_TEMPLATE, PG_DRILL_TABLES (space separated; default the fixed
# list below), PG_DRILL_TOL_ABS, PG_DRILL_TOL_PCT, PG_DRILL_PASSFILE, PG_DRILL_BACKUP_PASSFILE.
#
# Exit codes: 0 OK; 1 FAIL (the summary line says why). Written for macOS bash 3.2 and GNU bash.

set -uo pipefail

DUMP_DIR="${PG_DRILL_DUMP_DIR:-${HOME}/pg-backups}"
MAX_AGE_MIN="${PG_DRILL_MAX_AGE_MIN:-2160}"
BIN_DIR="${PG_DRILL_BIN_DIR-/opt/homebrew/opt/postgresql@16/bin}"
HOST="${PG_DRILL_HOST:-127.0.0.1}"
PORT="${PG_DRILL_PORT:-5432}"
LIVE_DB="${PG_DRILL_DB:-marveen}"
MAINT_DB="${PG_DRILL_MAINT_DB:-postgres}"
DRILL_ROLE="${PG_DRILL_ROLE:-marveen_drill}"
BACKUP_ROLE="${PG_DRILL_BACKUP_ROLE:-marveen_backup}"
TEMPLATE_DB="${PG_DRILL_TEMPLATE:-marveen_drill_tpl}"
DRILL_PASSFILE="${PG_DRILL_PASSFILE:-${HOME}/.pgpass-marveen-drill}"
BACKUP_PASSFILE="${PG_DRILL_BACKUP_PASSFILE:-${HOME}/.pgpass-marveen-backup}"
TOL_ABS="${PG_DRILL_TOL_ABS:-2}"
TOL_PCT="${PG_DRILL_TOL_PCT:-10}"
# The fixed list of key tables: the ones whose loss would hurt first, each populated on a live install.
TABLES="${PG_DRILL_TABLES:-memories kanban_cards workspace_docs schedules dashboard_users agent_messages tenants system_config conversation_log}"

# --- the single summary line, printed by the EXIT trap so it is always the last line ----------------------------------
RC=1
SUMMARY="pg-restore-drill: FAIL -- the script stopped before it reached a verdict"
DRILL_DB=""        # the throwaway database, set before CREATE DATABASE so a half-created one is dropped too
WORK=""            # temp directory for the filtered restore list and the restore's stderr (owner-only)
LEFTOVER=0

psql_as() {  # psql_as <passfile> <role> <database> <sql>: one value per line, no alignment, never prompts, no psqlrc
  PGPASSFILE="$1" PGCONNECT_TIMEOUT=10 "${PSQL}" -X -w -q -A -t -v ON_ERROR_STOP=1 \
    -h "${HOST}" -p "${PORT}" -U "$2" -d "$3" -c "$4"
}

drop_db() {  # drop_db <name>: 0 when the throwaway database is gone. The drill role created it, so it may drop it.
  # A plain DROP first: PostgreSQL itself cancels an AUTOVACUUM worker that sits on the database (a restore of real data
  # triggers one right away) and waits for it. WITH (FORCE) alone does not work for the drill role: it must terminate every
  # session, and a role without superuser may not terminate an autovacuum worker ("permission denied to terminate
  # process"), so a real-size restore left its throwaway database behind. FORCE stays as the second try for a lingering
  # session of the drill role itself (a failed restore). Three rounds, 2 seconds apart.
  local round
  for round in 1 2 3; do
    psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${MAINT_DB}" "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1 && return 0
    psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${MAINT_DB}" "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" >/dev/null 2>&1 && return 0
    [[ ${round} -lt 3 ]] && sleep 2
  done
  return 1
}

cleanup() {
  local drop_rc=0
  if [[ -n "${DRILL_DB}" ]]; then
    drop_db "${DRILL_DB}" || drop_rc=$?
    if [[ ${drop_rc} -ne 0 ]]; then
      LEFTOVER=1
      RC=1
      SUMMARY="pg-restore-drill: FAIL -- the throwaway database ${DRILL_DB} could NOT be dropped (drop it by hand as the drill role); ${SUMMARY#pg-restore-drill: }"
    fi
  fi
  [[ -n "${WORK}" && -d "${WORK}" ]] && rm -rf "${WORK}"
  if [[ ${RC} -eq 0 ]]; then
    printf '%s\n' "${SUMMARY}"
  else
    printf '%s\n' "${SUMMARY}" >&2
  fi
  exit "${RC}"
}
trap cleanup EXIT
# a signal ends the run through the EXIT trap, with the failure summary
trap 'SUMMARY="pg-restore-drill: FAIL -- interrupted by a signal"; RC=1; exit 1' INT TERM HUP

fail() {  # fail <reason>: the verdict, then the EXIT trap drops the throwaway database and prints it
  SUMMARY="pg-restore-drill: FAIL -- $1"
  RC=1
  exit 1
}

# --- tools -------------------------------------------------------------------------------------------------------------
find_tool() {  # find_tool <name>: BIN_DIR first, then PATH
  if [[ -n "${BIN_DIR}" && -x "${BIN_DIR}/$1" ]]; then echo "${BIN_DIR}/$1"; return 0; fi
  command -v "$1" 2>/dev/null
}
PSQL="$(find_tool psql || true)"
PG_RESTORE="$(find_tool pg_restore || true)"
[[ -n "${PSQL}" ]] || fail "psql not found (PG_DRILL_BIN_DIR=${BIN_DIR:-unset}, PATH)"
[[ -n "${PG_RESTORE}" ]] || fail "pg_restore not found (PG_DRILL_BIN_DIR=${BIN_DIR:-unset}, PATH)"

# table names go into SQL text: only plain identifiers
for t in ${TABLES}; do
  [[ "${t}" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "table name '${t}' is not a plain identifier"
done
# role names go into SQL text (the GRANT) and are double-quoted there: plain lower-case identifiers only
for v in "${DRILL_ROLE}" "${BACKUP_ROLE}"; do
  [[ "${v}" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "role name '${v}' is not a plain lower-case identifier"
done
for v in "${TOL_ABS}" "${TOL_PCT}" "${MAX_AGE_MIN}"; do
  [[ "${v}" =~ ^[0-9]+$ ]] || fail "a tolerance or age setting is not a non-negative integer"
done

# --- 1. the dump -------------------------------------------------------------------------------------------------------
# marveen-<date>-<time>.dump only: a probe dump (marveen-probe-*.dump) or any other file must never be drilled.
NEWEST="$(ls -1t "${DUMP_DIR}"/marveen-[0-9]*-[0-9]*.dump 2>/dev/null | head -1 || true)"
[[ -n "${NEWEST}" ]] || fail "no dump marveen-<date>-<time>.dump in ${DUMP_DIR}"
DUMP_NAME="$(basename "${NEWEST}")"
if [[ -n "$(find "${NEWEST}" -mmin "+${MAX_AGE_MIN}" 2>/dev/null)" ]]; then
  fail "the newest dump (${DUMP_NAME}) is older than $((MAX_AGE_MIN / 60)) hours: the nightly dump has stopped"
fi

SIDECAR="${NEWEST}.sha256"
[[ -f "${SIDECAR}" ]] || fail "${DUMP_NAME} has no .sha256 sidecar"
EXPECTED="$(awk 'NR==1 {print $1}' "${SIDECAR}" 2>/dev/null || true)"
if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "${NEWEST}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${NEWEST}" | awk '{print $1}')"
else
  fail "neither shasum nor sha256sum is available to check the dump"
fi
# the sidecar names the path the nightly job wrote at the time; only the hash field is compared
[[ "${EXPECTED}" =~ ^[0-9a-f]{64}$ && "${EXPECTED}" == "${ACTUAL}" ]] || fail "sha256 of ${DUMP_NAME} does not match its sidecar"

WORK="$(umask 077; mktemp -d -t pg-restore-drill.XXXXXX)" || fail "cannot create a temp directory"
if ! "${PG_RESTORE}" -l "${NEWEST}" > "${WORK}/toc.list" 2> "${WORK}/toc.err"; then
  fail "pg_restore cannot list ${DUMP_NAME}: $(head -c 200 "${WORK}/toc.err" | tr '\n' ' ')"
fi
# the EXTENSION entries (and their comments) are skipped: the drill role may not create pgvector, the template provides both.
# Row-level security and policies ARE restored (the copy is the real schema); the counting goes through the backup role,
# which bypasses them. Grants and owners are not restored at all (--no-acl --no-owner below).
grep -v -E ' EXTENSION - | COMMENT - EXTENSION ' "${WORK}/toc.list" > "${WORK}/restore.list"

# --- 2. what the restore needs, named one by one -----------------------------------------------------------------------
check_passfile() {  # check_passfile <path> <what>
  [[ -f "$1" ]] || fail "$2 password file $1 does not exist (create it, mode 0600; see the header of scripts/pg-restore-drill.sh)"
  local mode
  # GNU stat first (the repo convention, scripts/backup.sh): on GNU, `stat -f` is the FILESYSTEM status and `%L` an unknown
  # directive that prints "?p" with exit 0, which made this check fail OPEN on Linux. BSD/macOS stat rejects `-c` (exit 1), so
  # the fallback to `-f '%Lp'` still works there. Whatever comes back must be an octal mode, or the check fails closed.
  mode="$(stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo unreadable)"
  [[ "${mode}" =~ ^[0-7]{3,4}$ ]] || fail "cannot read the mode of $2 password file $1 (got '${mode}'): it must be 0600"
  [[ $(( 8#${mode} & 077 )) -eq 0 ]] || fail "$2 password file $1 has mode ${mode}: libpq ignores it, it must be 0600"
}
check_passfile "${BACKUP_PASSFILE}" "backup role"
check_passfile "${DRILL_PASSFILE}" "drill role"

if ! DRILL_FACTS="$(psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${MAINT_DB}" \
  "SELECT (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user)::text || ',' || \
          (SELECT (rolsuper OR rolbypassrls)::text FROM pg_roles WHERE rolname = current_user) || ',' || \
          coalesce((SELECT datistemplate::text FROM pg_database WHERE datname = '${TEMPLATE_DB}'), 'missing')" 2>"${WORK}/drill.err")"; then
  fail "cannot connect as ${DRILL_ROLE} to ${MAINT_DB} on ${HOST}:${PORT}: $(head -c 200 "${WORK}/drill.err" | tr '\n' ' ')"
fi
DRILL_CREATEDB="${DRILL_FACTS%%,*}"; REST="${DRILL_FACTS#*,}"
DRILL_PRIVILEGED="${REST%%,*}"; TEMPLATE_STATE="${REST#*,}"
[[ "${DRILL_CREATEDB}" == "true" ]] || fail "role ${DRILL_ROLE} lacks CREATEDB (one-time setup: ALTER ROLE ${DRILL_ROLE} CREATEDB)"
[[ "${DRILL_PRIVILEGED}" == "false" ]] || fail "role ${DRILL_ROLE} is a superuser or has BYPASSRLS: the drill role must be neither"
# The drill role must hold NO right on the live database: a role that can read the live tables is not the isolated role this
# drill is built around. A failed connect to the live database counts as "no rights" (CONNECT withdrawn).
LIVE_RIGHTS="$(psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${LIVE_DB}" \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') AND has_table_privilege(c.oid, 'SELECT')" 2>/dev/null | tr -d '[:space:]')" || LIVE_RIGHTS=0
[[ -z "${LIVE_RIGHTS}" || "${LIVE_RIGHTS}" == "0" ]] || fail "role ${DRILL_ROLE} can read ${LIVE_RIGHTS} table(s) of the live database ${LIVE_DB}: it must hold no right there (not a member of the owner or app role, no grants)"
case "${TEMPLATE_STATE}" in
  true) ;;
  false) fail "database ${TEMPLATE_DB} exists but is not a template (one-time setup: ALTER DATABASE ${TEMPLATE_DB} IS_TEMPLATE true)" ;;
  *) fail "template database ${TEMPLATE_DB} does not exist (one-time setup: an empty database with the vector and unaccent extensions, then IS_TEMPLATE true)" ;;
esac
# the live database must answer to the backup role before anything is created
psql_as "${BACKUP_PASSFILE}" "${BACKUP_ROLE}" "${LIVE_DB}" "SELECT 1" >/dev/null 2>"${WORK}/live.err" \
  || fail "cannot connect as ${BACKUP_ROLE} to the live database ${LIVE_DB}: $(head -c 200 "${WORK}/live.err" | tr '\n' ' ')"

# The restored copy is counted as the backup role, so the backup role must reach a database that is NOT the live one: its
# password file needs * in the database field (the throwaway name changes every run; libpq has no partial match). Tried
# against the template now, before anything is created, so a passfile that only names the live database fails here with the
# fix in the message instead of as "cannot be counted" on every table.
psql_as "${BACKUP_PASSFILE}" "${BACKUP_ROLE}" "${TEMPLATE_DB}" "SELECT 1" >/dev/null 2>"${WORK}/tpl.err" \
  || fail "cannot connect as ${BACKUP_ROLE} to ${TEMPLATE_DB}: the database field of ${BACKUP_PASSFILE} must be * (the throwaway database has a new name every run), not the live database name: $(head -c 200 "${WORK}/tpl.err" | tr '\n' ' ')"

# --- 3. orphans, the throwaway database and the restore -----------------------------------------------------------------
# Orphans of a killed run (see ORPHANS in the header): owned by the drill role, UTC stamp older than 24 hours. The stamp is
# fixed-width digits, so a string comparison against the cutoff in the same shape is a time comparison, with no time zone in it.
SWEPT=0; SWEEP_FAILED=0
ORPHANS="$(psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${MAINT_DB}" \
  "SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND NOT datistemplate AND datname ~ '^marveen_drill_[0-9]{14}_[0-9]+\$' AND substr(datname, 15, 14) < to_char((now() AT TIME ZONE 'UTC') - interval '24 hours', 'YYYYMMDDHH24MISS') ORDER BY 1" 2>/dev/null || true)"
for o in ${ORPHANS}; do
  [[ "${o}" =~ ^marveen_drill_[0-9]{14}_[0-9]+$ ]] || continue   # the query already says so; this is the guard before the DROP
  if drop_db "${o}"; then
    SWEPT=$((SWEPT + 1))
  else
    SWEEP_FAILED=$((SWEEP_FAILED + 1))
  fi
done
SWEEP_NOTE=""
[[ ${SWEPT} -eq 0 ]] || SWEEP_NOTE="${SWEEP_NOTE} -- dropped ${SWEPT} orphaned throwaway database(s) of earlier runs"
[[ ${SWEEP_FAILED} -eq 0 ]] || SWEEP_NOTE="${SWEEP_NOTE} -- could NOT drop ${SWEEP_FAILED} orphaned throwaway database(s) of earlier runs"

DRILL_DB="marveen_drill_$(date -u +%Y%m%d%H%M%S)_$$"
if ! psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${MAINT_DB}" "CREATE DATABASE \"${DRILL_DB}\" TEMPLATE \"${TEMPLATE_DB}\"" >/dev/null 2>"${WORK}/create.err"; then
  fail "CREATE DATABASE ${DRILL_DB} failed: $(head -c 200 "${WORK}/create.err" | tr '\n' ' ')"
fi

# --no-owner --no-acl: the objects belong to the drill role and no grant or default privilege of the dump is replayed (it
# names roles of the live install, and restoring them is not what the drill proves). --exit-on-error: a half restore is a
# failed drill.
if ! PGPASSFILE="${DRILL_PASSFILE}" PGCONNECT_TIMEOUT=10 "${PG_RESTORE}" -w --no-owner --no-acl --exit-on-error \
      -L "${WORK}/restore.list" -h "${HOST}" -p "${PORT}" -U "${DRILL_ROLE}" -d "${DRILL_DB}" "${NEWEST}" \
      >"${WORK}/restore.out" 2>"${WORK}/restore.err"; then
  fail "pg_restore of ${DUMP_NAME} failed: $(head -c 300 "${WORK}/restore.err" | tr '\n' ' ')"
fi

# --no-acl replayed no grant, so the backup role cannot read the restored copy yet. One grant, as the drill role (the owner
# of the copy, because of --no-owner): SELECT on the tables of the public schema, and USAGE on the schema itself (PUBLIC has it
# on a default schema; named anyway so a locked-down template does not turn into "cannot be counted"). Without this line every
# table is "cannot be counted in the restored copy".
if ! psql_as "${DRILL_PASSFILE}" "${DRILL_ROLE}" "${DRILL_DB}" \
      "GRANT USAGE ON SCHEMA public TO \"${BACKUP_ROLE}\"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"${BACKUP_ROLE}\"" \
      >/dev/null 2>"${WORK}/grant.err"; then
  fail "granting SELECT on the restored copy to ${BACKUP_ROLE} failed: $(head -c 200 "${WORK}/grant.err" | tr '\n' ' ')"
fi

# --- 4. the comparison --------------------------------------------------------------------------------------------------
count_rows() {  # count_rows <passfile> <role> <database> <table>: prints the count, or nothing when it cannot be counted
  psql_as "$1" "$2" "$3" "SELECT count(*) FROM public.\"$4\"" 2>/dev/null | tr -d '[:space:]'
}
TOTAL=0; MATCHED=0; SUM_RESTORED=0; SUM_LIVE=0; PROBLEMS=""
for t in ${TABLES}; do
  TOTAL=$((TOTAL + 1))
  r="$(count_rows "${BACKUP_PASSFILE}" "${BACKUP_ROLE}" "${DRILL_DB}" "${t}")"  # the restored copy: the backup role (bypasses RLS), granted above
  l="$(count_rows "${BACKUP_PASSFILE}" "${BACKUP_ROLE}" "${LIVE_DB}" "${t}")"  # the live database: only the read-only backup role
  if ! [[ "${r}" =~ ^[0-9]+$ ]]; then PROBLEMS="${PROBLEMS}${t}: cannot be counted in the restored copy; "; continue; fi
  if ! [[ "${l}" =~ ^[0-9]+$ ]]; then PROBLEMS="${PROBLEMS}${t}: cannot be counted in the live database; "; continue; fi
  SUM_RESTORED=$((SUM_RESTORED + r)); SUM_LIVE=$((SUM_LIVE + l))
  allowed=$((r * TOL_PCT / 100)); [[ ${allowed} -lt ${TOL_ABS} ]] && allowed=${TOL_ABS}
  if [[ ${r} -gt ${l} ]]; then
    PROBLEMS="${PROBLEMS}${t}: restored ${r} > live ${l}; "
  elif [[ ${r} -eq 0 && ${l} -gt 0 ]]; then
    PROBLEMS="${PROBLEMS}${t}: restored copy is empty, live has ${l}; "
  elif [[ $((l - r)) -gt ${allowed} ]]; then
    PROBLEMS="${PROBLEMS}${t}: live ${l} is ahead of restored ${r} by more than ${allowed}; "
  else
    MATCHED=$((MATCHED + 1))
  fi
done

if [[ -n "${PROBLEMS}" ]]; then
  fail "${DUMP_NAME}: ${MATCHED} of ${TOTAL} tables match -- ${PROBLEMS%; }${SWEEP_NOTE}"
fi
SUMMARY="pg-restore-drill: OK ${DUMP_NAME} -- ${MATCHED} of ${TOTAL} tables match (restored ${SUM_RESTORED} rows, live ${SUM_LIVE} rows)${SWEEP_NOTE}"
RC=0
exit 0
