#!/usr/bin/env bash
# Marveen backup.
#
# The archive has two top-level groups so a restore is unambiguous about
# where each file belongs (see docs/MIGRATION.md):
#
#   repo/   -> extract under the project root (this repo)
#     store/claudeclaw.db (+ -shm/-wal; WAL-checkpointed before copy)
#       (memories, kanban, artifacts, artifacts_fts*, vec_artifacts* tables)
#     store/.dashboard-token   (dashboard bearer)
#     store/vault.json         (ENCRYPTED secret vault; the key is NOT in this archive)
#     .env                     (project root secrets)
#     scheduled-tasks.json     (legacy, if present)
#     assets/meetings/**       (meeting transcripts/memos)
#     agents/*/CLAUDE.md, SOUL.md, .mcp.json
#     agents/*/.claude/channels/{telegram,slack,discord}/.env, access.json
#     agents/*/memory/**                                  (per-agent memory dir)
#     (auto-memory <config>/projects/*/memory/** lives wherever the `projects`
#      dirs really point -- see below: usually the shared home/ copy)
#
#   home/   -> extract under $HOME
#     .claude/skills/**            (the self-built skill library)
#     .claude/scheduled-tasks/**   (file-based scheduled tasks: SKILL.md + config)
#     .claude/projects/*/memory/** (auto-memory of the main agent, workers and
#                                   sub-agents; the .channels-config/projects and
#                                   agents/*/.claude-config/projects symlinks all
#                                   resolve here, so it is stored once)
#     .claude/channels/*/.env      (MAIN orchestrator channel token)
#     .claude/channels/*/access.json, invites.json, approved/**  (pairing state)
#     Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist (launchd jobs)
#
# Vault master key: kept OUT of the archive on purpose. Whoever holds the
# archive AND the key can decrypt store/vault.json, so the key goes to a
# separate 0600 file next to it (backups/claudeclaw-YYYYmmdd-HHMMSS.vault-key)
# that the operator should store somewhere else. It is read the way
# src/web/vault.ts finds it: macOS Keychain (service com.marveen.vault,
# account master-key) first, then store/.vault-key, then store/.vault-key.migrated
# as a last resort. If vault.json exists but no key can be found, the backup
# still completes and says so loudly (the vault part is then unrestorable).
#
# Output: backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
#         backups/claudeclaw-YYYYmmdd-HHMMSS.sha256      (archive checksum)
#         backups/claudeclaw-YYYYmmdd-HHMMSS.vault-key   (only when a vault exists)
# Retention: keeps the most recent BACKUP_KEEP archives (default 30), prunes the rest.
#
# Restore (preserve modes so the 0600 token files stay private):
#   tar -xpzf <archive> -C /tmp/restore        # inspect first
#   then copy repo/* into the project root and home/* into $HOME.
#   the vault key file restores to store/.vault-key (mode 0600) -- or import it
#   into the Keychain WITHOUT putting the key on a command line (argv is visible to other
#   processes via ps): run `security add-generic-password -U -s com.marveen.vault -a master-key -w`
#   with -w as the last option and no value, then paste the key when it prompts.
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/claudeclaw-${STAMP}.tar.gz"
# Retention count: override with BACKUP_KEEP env var (default 30).
KEEP="${BACKUP_KEEP:-30}"
VAULT_KEY_OUT="${ARCHIVE%.tar.gz}.vault-key"
# Keychain item of the vault master key. Keep in sync with src/web/keychain.ts
# (a test pins that). BACKUP_SECURITY_BIN lets tests stub the keychain.
SECURITY_BIN="${BACKUP_SECURITY_BIN:-/usr/bin/security}"
KEYCHAIN_SERVICE="com.marveen.vault"
KEYCHAIN_ACCOUNT="master-key"

mkdir -p "${BACKUP_DIR}"
cd "${REPO_ROOT}"

# Checkpoint WAL into the main DB file so the snapshot is self-contained.
# Tolerate a missing sqlite3 CLI -- just fall back to copying the files as-is.
if [[ -f store/claudeclaw.db ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 store/claudeclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || true
  # Verify the artifacts table survived the checkpoint (absent on fresh installs is OK).
  if ! sqlite3 store/claudeclaw.db "SELECT 1 FROM sqlite_master WHERE name='artifacts'" 2>/dev/null | grep -q 1; then
    echo "backup: WARNING -- artifacts table missing in DB (fresh install?)" >&2
  fi
  # Integrity check: a corrupt DB is worse than no backup -- abort early.
  IC_RESULT="$(sqlite3 store/claudeclaw.db 'PRAGMA integrity_check(1);' 2>/dev/null || echo 'error')"
  if [[ "${IC_RESULT}" != "ok" ]]; then
    echo "backup: ABORT -- PRAGMA integrity_check failed: ${IC_RESULT}" >&2
    exit 2
  fi
fi

# --- Build the two path lists (each relative to its own base). -------------
# tar refuses missing entries, which would fail the whole backup on a fresh
# machine (no agents yet) -- so we only list paths that actually exist.
REPOLIST="$(mktemp -t claudeclaw-repo.XXXXXX)"
HOMELIST="$(mktemp -t claudeclaw-home.XXXXXX)"
MANIFEST="$(mktemp -t claudeclaw-manifest.XXXXXX)"
STAGE="$(mktemp -d -t claudeclaw-stage.XXXXXX)"
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}"; rm -rf "${STAGE}"' EXIT

# add_if <listfile> <base> <relpath>  -- append relpath when <base>/<relpath> exists.
add_if() {
  local list="$1" base="$2" rel="$3"
  if [[ -e "${base}/${rel}" ]]; then echo "${rel}" >> "${list}"; fi
}

# repo/ group (relative to REPO_ROOT)
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-shm
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-wal
add_if "${REPOLIST}" "${REPO_ROOT}" store/.dashboard-token
add_if "${REPOLIST}" "${REPO_ROOT}" store/vault.json
add_if "${REPOLIST}" "${REPO_ROOT}" .env
add_if "${REPOLIST}" "${REPO_ROOT}" scheduled-tasks.json
add_if "${REPOLIST}" "${REPO_ROOT}" assets/meetings
# Per-agent identity + channel secrets (glob; missing dir is not an error).
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${REPOLIST}"
  # Per-agent memory dir. Depth is pinned so a stray "memory" dir deeper in an
  # agent's tree is not swept in.
  find agents -mindepth 2 -maxdepth 2 -type d -name memory -print >> "${REPOLIST}"
fi

# Auto-memory (Claude Code's <config>/projects/<project>/memory) of the main
# agent, the workers and every sub-agent. On a typical install each of those
# config dirs' `projects` is a SYMLINK to the one shared $HOME/.claude/projects,
# which find would not follow -- so resolve each candidate to its physical path,
# dedupe (ten symlinks to one target are one copy), and file the memory dirs
# under repo/ or home/ depending on where they really live.
REPO_ROOT_P="$(cd "${REPO_ROOT}" && pwd -P)"
HOME_P="$(cd "${HOME}" 2>/dev/null && pwd -P || echo "${HOME}")"
SEEN_PROJECT_DIRS="|"
collect_project_memory() {  # collect_project_memory <projects-dir>
  local pdir="$1" real memdir
  [[ -d "${pdir}" ]] || return 0
  real="$(cd -P "${pdir}" 2>/dev/null && pwd -P)" || return 0
  case "${SEEN_PROJECT_DIRS}" in *"|${real}|"*) return 0 ;; esac
  SEEN_PROJECT_DIRS="${SEEN_PROJECT_DIRS}${real}|"
  for memdir in "${real}"/*/memory; do
    [[ -d "${memdir}" ]] || continue
    case "${memdir}" in
      "${REPO_ROOT_P}"/*) echo "${memdir#"${REPO_ROOT_P}"/}" >> "${REPOLIST}" ;;
      "${HOME_P}"/*)      echo "${memdir#"${HOME_P}"/}" >> "${HOMELIST}" ;;
      *) echo "backup: WARNING -- memory dir outside the repo and \$HOME, not backed up: ${memdir}" >&2 ;;
    esac
  done
}
collect_project_memory .channels-config/projects
for _pd in agents/*/.claude-config/projects; do collect_project_memory "${_pd}"; done
collect_project_memory "${HOME}/.claude/projects"

# home/ group (relative to $HOME)
add_if "${HOMELIST}" "${HOME}" .claude/skills
add_if "${HOMELIST}" "${HOME}" .claude/scheduled-tasks
# MAIN orchestrator channel tokens + pairing state, per provider. bot.pid and
# inbox/ are runtime/transient and intentionally excluded.
if [[ -d "${HOME}/.claude/channels" ]]; then
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${HOMELIST}"
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${HOMELIST}"
fi
# launchd jobs for this fleet. The job labels are com.<MAIN_AGENT_ID>.<service>
# (see src/web/main-agent.ts), so resolve MAIN_AGENT_ID the way the app does
# (src/env.ts: read from .env, default "marveen" when unset) instead of
# hardcoding one deployment's prefix. Parsing mirrors env.ts: last definition
# wins, surrounding matching quotes stripped.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # `|| true`: with `set -o pipefail`, a no-match grep would otherwise fail the
  # whole substitution (and, under `set -e`, abort the backup) on any install
  # that leaves MAIN_AGENT_ID unset and relies on the "marveen" default.
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
if [[ -d "${HOME}/Library/LaunchAgents" ]]; then
  ( cd "${HOME}" && find Library/LaunchAgents -maxdepth 1 -name "com.${MAIN_AGENT_ID}.*.plist" -print ) >> "${HOMELIST}"
fi

# --- Vault master key (goes to a SEPARATE file, never into the archive). ---
# The key value only ever lives in this shell variable and the 0600 output
# file; it is never echoed or passed on a command line.
VAULT_KEY_VALUE=""
VAULT_KEY_SOURCE=""
if [[ -f store/vault.json ]]; then
  # Only macOS ships ${SECURITY_BIN}; elsewhere the -x test simply skips the Keychain.
  if [[ -x "${SECURITY_BIN}" ]] && command -v perl >/dev/null 2>&1; then
    # A locked keychain makes `security` block on a GUI prompt; alarm(5) kills
    # it (same reason keychain.ts has a timeout). perl is always present on macOS.
    # Only a clean exit counts: a non-zero rc (item missing, access denied, alarm
    # kill) discards whatever was printed, so no partial value becomes the sidecar.
    KEYCHAIN_RC=0
    VAULT_KEY_VALUE="$(perl -e 'alarm 5; exec @ARGV' "${SECURITY_BIN}" find-generic-password \
      -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w 2>/dev/null)" || KEYCHAIN_RC=$?
    if [[ "${KEYCHAIN_RC}" -ne 0 ]]; then
      VAULT_KEY_VALUE=""
    elif [[ -n "${VAULT_KEY_VALUE}" ]]; then
      VAULT_KEY_SOURCE="macOS Keychain"
    fi
  fi
  if [[ -z "${VAULT_KEY_VALUE}" && -s store/.vault-key ]]; then
    VAULT_KEY_VALUE="$(tr -d '[:space:]' < store/.vault-key)"
    [[ -n "${VAULT_KEY_VALUE}" ]] && VAULT_KEY_SOURCE="store/.vault-key"
  fi
  if [[ -z "${VAULT_KEY_VALUE}" && -s store/.vault-key.migrated ]]; then
    VAULT_KEY_VALUE="$(tr -d '[:space:]' < store/.vault-key.migrated)"
    if [[ -n "${VAULT_KEY_VALUE}" ]]; then
      VAULT_KEY_SOURCE="store/.vault-key.migrated (last resort)"
      echo "backup: WARNING -- vault key taken from store/.vault-key.migrated; the Keychain did not answer." >&2
    fi
  fi
  if [[ -z "${VAULT_KEY_VALUE}" ]]; then
    echo "backup: WARNING -- store/vault.json is archived but NO vault master key was found (Keychain locked/empty, no store/.vault-key). The vault in this backup cannot be decrypted." >&2
  fi
fi

if [[ ! -s "${REPOLIST}" && ! -s "${HOMELIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

# --- Manifest (stored at the archive root for self-description). -----------
{
  echo "Marveen backup ${STAMP}"
  echo "host: $(hostname 2>/dev/null || echo '?')   user: ${USER:-?}   home: ${HOME}"
  echo "repo root: ${REPO_ROOT}"
  echo "Restore: tar -xpzf <archive> -C <tmp>; copy repo/* -> project root, home/* -> \$HOME."
  echo "See docs/MIGRATION.md for the full runbook (TCC, launchd paths, one-bot-one-poller, venv rebuild)."
  if [[ -n "${VAULT_KEY_SOURCE}" ]]; then
    echo "vault key: separate file $(basename "${VAULT_KEY_OUT}") (NOT in this archive; source: ${VAULT_KEY_SOURCE})"
  elif [[ -f store/vault.json ]]; then
    echo "vault key: NOT AVAILABLE at backup time -- vault.json in this archive cannot be decrypted"
  fi
  echo "--- repo/ ---"; sed 's,^,repo/,' "${REPOLIST}" 2>/dev/null || true
  echo "--- home/ ---"; sed 's,^,home/,' "${HOMELIST}" 2>/dev/null || true
} > "${MANIFEST}"

# --- Assemble the archive via a staging dir, then one plain tar. -----------
# The repo/ and home/ groups are produced by copying into a staging tree, NOT
# by tar name-substitution: bsdtar's `-s` and GNU tar's `--transform` are
# mutually incompatible (on GNU tar, `-s` is `--same-order` and takes no
# argument), so a substitution-based build is not portable. Staging + a single
# `tar -czf -C "${STAGE}" .` works identically on macOS (bsdtar) and Linux
# (GNU tar). Everything backed up is small (a few MB), so the copy is cheap;
# `cp -pR` preserves modes so the 0600 token files stay private.
cp "${MANIFEST}" "${STAGE}/MANIFEST.txt"

stage_group() {  # stage_group <listfile> <base> <group>
  local list="$1" base="$2" group="$3" rel parent
  [[ -s "${list}" ]] || return 0
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    parent="$(dirname "${rel}")"
    mkdir -p "${STAGE}/${group}/${parent}"
    cp -pR "${base}/${rel}" "${STAGE}/${group}/${parent}/"
  done < "${list}"
}

stage_group "${REPOLIST}" "${REPO_ROOT}" repo
stage_group "${HOMELIST}" "${HOME}" home

# Archive only the top-level entries that exist (a group dir is absent when
# its list was empty), so tar never errors on a missing entry and the names
# stay clean (no leading "./").
( cd "${STAGE}" && tar -czf "${ARCHIVE}" MANIFEST.txt \
    $( [[ -d repo ]] && echo repo ) $( [[ -d home ]] && echo home ) )

# Vault key sidecar, written only after the archive succeeded (no orphan key
# file when tar fails). umask 077 so it is never group/world readable.
if [[ -n "${VAULT_KEY_VALUE}" ]]; then
  ( umask 077; printf '%s\n' "${VAULT_KEY_VALUE}" > "${VAULT_KEY_OUT}" )
  chmod 600 "${VAULT_KEY_OUT}"
  echo "backup: wrote ${VAULT_KEY_OUT} (vault master key, separate from the archive)"
  echo "backup: WARNING -- store ${VAULT_KEY_OUT} somewhere OTHER than the archive; archive + key together decrypt the vault." >&2
fi
VAULT_KEY_VALUE=""

ARCHIVE_BYTES="$(wc -c < "${ARCHIVE}" | awk '{print $1}')"
# sha256: shasum on macOS, sha256sum on Linux -- pick whichever is present.
if command -v shasum >/dev/null 2>&1; then
  CHECKSUM="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
else
  CHECKSUM="unavailable"
fi
# Write a sidecar .sha256 file next to the archive for offline verification.
echo "${CHECKSUM}  $(basename "${ARCHIVE}")" > "${ARCHIVE%.tar.gz}.sha256"
echo "backup: wrote ${ARCHIVE} (${ARCHIVE_BYTES} bytes)"
echo "backup: sha256 ${CHECKSUM}"

# The archive contains sensitive tokens (dashboard bearer, channel bot tokens,
# project .env secrets). Do not auto-sync ${BACKUP_DIR} to iCloud, Dropbox,
# Google Drive, or any other cloud-backup folder. Keep it local.
echo "backup: WARNING -- archive contains sensitive tokens; keep ${BACKUP_DIR} out of cloud-sync folders (iCloud / Dropbox / Google Drive)." >&2

# Keep the newest ${KEEP} archives, drop the rest. while-read (not mapfile)
# for macOS bash 3.2 compatibility. Remove the .sha256 sidecar alongside.
ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  rm -f "${f}" "${f%.tar.gz}.sha256" "${f%.tar.gz}.vault-key"
  echo "backup: pruned $(basename "${f}")"
done
