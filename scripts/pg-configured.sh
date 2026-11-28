#!/usr/bin/env bash
# pg_configured: is this install configured for PostgreSQL? Sourced by backup.sh, verify-restore.sh, restore-drill.sh, pre-modify-backup.sh and migrate-main-agent-id.sh.
#
# TRUE when ANY layer says PostgreSQL, with the rules of the app (src/db/pg/url.ts, src/env.ts):
#   1. the secret mount file ${SECRET_MOUNT_DIR:-/run/secrets}/MARVEEN_PG_URL, non-blank after trimming;
#   2. the environment variable MARVEEN_PG_URL, non-blank;
#   3. the MARVEEN_PG_URL line of the install's .env (CLAUDECLAW_ENV_DIR overrides the directory, as env.ts does);
#   4. the marker MARVEEN_PG_CONFIGURED=1, which the app sets at start so that a child process (a scheduled command
#      task) can still tell that the install is PostgreSQL when it cannot read the URL;
#   5. the store marker <install>/store/.pg-installed, or $MARVEEN_STORE_DIR/.pg-installed when that variable is set (either
#      place counts), which the PostgreSQL boot writes once (P-E): durable, it survives a lost .env or a shell without the
#      variable. A PostgreSQL install that lost its configuration is not read as SQLite. A store that cannot be read or is
#      not a directory counts as present (pg_store_marker_at).
# Blank or whitespace-only counts as absent, as in the app. When the .env cannot be read but the marker is set, the
# answer is TRUE: doubt means PostgreSQL, because a false FALSE is the false green this check exists to stop.
# The URL is never printed, logged or stored here.
#
# Usage: pg_configured [install-root]   (returns 0 for TRUE, 1 for FALSE)

# pg_store_marker_at <store-dir>: the store marker is present in this store dir (P-E). Present when the marker file can be
# stat'ed, OR when the store dir exists and is not a traversable directory (an unreadable store, or a store that is a
# file): doubt is PostgreSQL, the same rule as the app's reader (pgInstallMarkerPresentIn) and the hook side
# (hook_pg_mode._marker_present). A store dir that does not exist at all is absent (a fresh SQLite install).
pg_store_marker_at() {
  local store="${1%/}"
  # -L as well: a symlink loop at the marker path fails -e (ELOOP) and is still a marker present (python and the app stat-fail to present)
  [[ -e "$store/.pg-installed" || -L "$store/.pg-installed" ]] && return 0
  if [[ -e "$store" ]]; then
    [[ ! -d "$store" || ! -x "$store" ]] && return 0
  fi
  return 1
}

pg_configured() {
  local root="${1:-}"
  local mount_dir="${SECRET_MOUNT_DIR:-/run/secrets}"
  mount_dir="${mount_dir%/}"

  # 1. the secret mount
  if [[ -r "$mount_dir/MARVEEN_PG_URL" ]]; then
    if [[ -n "$(tr -d '[:space:]' < "$mount_dir/MARVEEN_PG_URL" 2>/dev/null)" ]]; then
      return 0
    fi
  fi

  # 2. the environment
  if [[ -n "$(printf '%s' "${MARVEEN_PG_URL:-}" | tr -d '[:space:]')" ]]; then
    return 0
  fi

  # 3. the .env file of the install, parsed the way src/env.ts readEnvFile parses it: each line trimmed, comments and
  #    lines without '=' skipped, the key and the value split at the FIRST '=' and both trimmed, one pair of outer quotes
  #    removed, and the last assignment of the key wins
  local env_dir="${CLAUDECLAW_ENV_DIR:-$root}"
  local env_file="$env_dir/.env"
  if [[ -r "$env_file" ]]; then
    local raw line key value first last found=""
    while IFS= read -r raw || [[ -n "$raw" ]]; do
      line="${raw#"${raw%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      [[ "$line" == *=* ]] || continue
      key="${line%%=*}"
      value="${line#*=}"
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ ${#value} -ge 2 ]]; then
        first="${value:0:1}"
        last="${value: -1}"
        if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
          value="${value:1:${#value}-2}"
        fi
      elif [[ "$value" == '"' || "$value" == "'" ]]; then
        value=""
      fi
      if [[ "$key" == "MARVEEN_PG_URL" ]]; then
        found="$value"
      fi
    done < "$env_file"
    if [[ -n "$(printf '%s' "$found" | tr -d '[:space:]')" ]]; then
      return 0
    fi
  elif [[ "${MARVEEN_PG_CONFIGURED:-}" == "1" ]]; then
    # the .env cannot be read and the marker says PostgreSQL: doubt is PostgreSQL
    return 0
  fi

  # 5. the store marker: the PostgreSQL boot writes <store>/.pg-installed once, and it outlives the environment (a lost .env
  #    or a shell without the marker variable does not erase it). Read from the install root's store, as the hooks read it.
  # either place (P-E, decision 4): the install's store, and $MARVEEN_STORE_DIR when that variable is set
  if [[ -n "$root" ]] && pg_store_marker_at "$root/store"; then
    return 0
  fi
  if [[ -n "${MARVEEN_STORE_DIR:-}" ]] && pg_store_marker_at "$MARVEEN_STORE_DIR"; then
    return 0
  fi

  # 4. the marker alone
  [[ "${MARVEEN_PG_CONFIGURED:-}" == "1" ]]
}
