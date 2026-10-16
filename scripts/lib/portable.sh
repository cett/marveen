# Portable shell helpers for the scripts that run on macOS as well as Linux. Sourced, never executed:
#
#     . "$INSTALL_DIR/scripts/lib/portable.sh"
#
# macOS ships BSD userland and bash 3.2: there is no sha256sum or md5sum, `stat -c` is an illegal option, and
# `timeout` is missing unless coreutils is installed. Each helper tries the GNU form, then the BSD form, and says
# "I could not" with a non-zero status and no output, so a caller can pick the safe side instead of working with an
# empty or wrong value. Plain POSIX plus bash 3.2 syntax only (no ${var,,}, no associative arrays, no mapfile).
# A script that sources this file and finds it missing gets "command not found" (status 127) from the helpers,
# which every caller treats like "could not": degraded, not dead.

# portable_mtime FILE: modification time in epoch seconds.
# GNU `stat -c %Y` goes first: on a GNU host `stat -f` means filesystem status and prints a multi-line report with
# exit 0, so it can only be the fallback, and the answer must be all digits before it is believed.
portable_mtime() {
  local out
  out="$(stat -c %Y "$1" 2>/dev/null)" || out=""
  case "$out" in ''|*[!0-9]*) out="$(stat -f %m "$1" 2>/dev/null)" || out="" ;; esac
  case "$out" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$out"
}

# portable_sha256 [FILE]: the SHA-256 of FILE, or of standard input without an argument, as 64 hex characters.
# sha256sum (Linux), shasum -a 256 (macOS, perl), openssl dgst -sha256 (last resort). A tool that is present but
# answers with anything other than 64 hex characters is skipped for the next one; reading standard input can be
# done once, so in that mode only the first tool present is tried.
portable_sha256() {
  local tool out
  for tool in sha256sum shasum openssl; do
    command -v "$tool" >/dev/null 2>&1 || continue
    out=""
    case "$tool" in
      sha256sum) if [ $# -gt 0 ]; then out="$(sha256sum "$1" 2>/dev/null)"; else out="$(sha256sum 2>/dev/null)"; fi ;;
      shasum)    if [ $# -gt 0 ]; then out="$(shasum -a 256 "$1" 2>/dev/null)"; else out="$(shasum -a 256 2>/dev/null)"; fi ;;
      openssl)   if [ $# -gt 0 ]; then out="$(openssl dgst -sha256 "$1" 2>/dev/null)"; else out="$(openssl dgst -sha256 2>/dev/null)"; fi
                 out="${out##* }" ;;
    esac
    out="${out%% *}"
    case "$out" in
      ''|*[!0-9a-fA-F]*) ;;
      *) if [ "${#out}" -eq 64 ]; then printf '%s\n' "$out"; return 0; fi ;;
    esac
    [ $# -eq 0 ] && return 1
  done
  return 1
}

# portable_timeout SECONDS COMMAND [ARG...]: run the command and stop it after SECONDS.
# timeout (GNU coreutils), gtimeout (Homebrew coreutils on macOS), perl's alarm (perl ships with macOS), and when
# none of them exists the command runs without a time limit. The exit status is the command's own; a timeout gives
# a non-zero status (124 from timeout, a signal status from the perl alarm).
portable_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec @ARGV or exit 127' "$secs" "$@"
  else
    "$@"
  fi
}
