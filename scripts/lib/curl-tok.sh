# curl calls that carry a secret without putting it on curl's command line.
#
# A secret in curl's argv is readable by every local user in `ps -ww` (and /proc/<pid>/cmdline on Linux) for as long
# as the call runs. These helpers hand it to curl as a config on stdin (`curl -K -`) instead. printf is a shell
# builtin, so the secret is not in the argv of a helper process either. Bash 3.2 safe (macOS /bin/bash).
#
# Usage (source it, then call):
#   . "$INSTALL_DIR/scripts/lib/curl-tok.sh"
#   curl_tok "$TOKEN" -s --max-time 10 "$URL"                        # Authorization: Bearer <token>
#   curl_hdr 'x-goog-api-key' "$KEY" -s "$URL"                        # any single secret header
#   curl_tok_url "$BOT" 'https://api.telegram.org/bot@TOKEN@/getMe' -s   # the secret is part of the URL
#
# Every extra argument is passed to curl as given. The config owns stdin, so a body must come from `-d "$text"`
# (not secret) or `--data-binary @file`, never `-d @-`.
#
# A value goes into a double-quoted config string, so it cannot hold a double quote, a backslash, a newline or a
# carriage return: the helper returns 2 and sends nothing (a bearer token, a bot token and an API key never do).

_curl_tok_clean() {
  case "$1" in
    *\"*|*\\*|*$'\n'*|*$'\r'*) return 1 ;;
  esac
  return 0
}

# curl_hdr <header-name> <header-value> [curl args...]
curl_hdr() {
  local name="$1" value="$2"
  shift 2
  if ! _curl_tok_clean "$name" || ! _curl_tok_clean "$value"; then
    echo "curl_hdr: the header holds a quote, a backslash or a line break -- not sent" >&2
    return 2
  fi
  printf 'header = "%s: %s"\n' "$name" "$value" | curl -K - "$@"
}

# curl_tok <token> [curl args...]
curl_tok() {
  local tok="$1"
  shift
  curl_hdr Authorization "Bearer $tok" "$@"
}

# curl_tok_url <token> <url-template with @TOKEN@> [curl args...]
curl_tok_url() {
  local tok="$1" template="$2"
  shift 2
  if ! _curl_tok_clean "$tok" || ! _curl_tok_clean "$template"; then
    echo "curl_tok_url: the token or the URL holds a quote, a backslash or a line break -- not sent" >&2
    return 2
  fi
  case "$template" in
    *@TOKEN@*) ;;
    *) echo "curl_tok_url: the URL template has no @TOKEN@" >&2; return 2 ;;
  esac
  # Split instead of ${template//@TOKEN@/$tok}: bash 5.2 treats an `&` in that replacement as the matched text.
  printf 'url = "%s%s%s"\n' "${template%%@TOKEN@*}" "$tok" "${template#*@TOKEN@}" | curl -K - "$@"
}
