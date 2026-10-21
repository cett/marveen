#!/usr/bin/env bash
# scripts/lib/curl-tok.sh: a secret must not reach curl's argv, where `ps` shows it to every local user.
# 1) ratchet: no shell script builds an argv-form secret (Bearer header, bot token in a URL, ?key= query) beyond the
#    legacy table below; the table may only shrink, and the three scripts converted with the helper are at zero
# 2) run: each helper delivers the secret to a server, and while curl runs the secret is NOT in the process list
# 3) control: the same call with the secret in argv IS visible (the probe discriminates, it is not blind)
# 4) the helpers refuse a value that cannot sit in a quoted config string (rc 2) and send nothing
# Test secrets only: the server writes what it received to a file and holds the request for 3 seconds.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILS=0
ok() { echo "  OK   $1"; }
bad() { echo "  FAIL $1"; FAILS=$((FAILS + 1)); }

echo "1) ratchet: argv-form secrets in shell scripts"
# file and the number of lines that may still carry the form. Lower a number (or delete the row) when a script is fixed.
# The table is empty: every script that called the Telegram API with the bot token in the URL now uses curl_tok_url.
LEGACY="
"
hits() {
  # comment lines and the config-header form (`header = "..."`, what the helpers print) do not count
  grep -v -E '^[[:space:]]*#' "$1" | grep -v 'header = "' \
    | grep -c -i -E 'authorization: *bearer|api\.telegram\.org/bot\$|[?&]key=\$' || true
}
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  FILES="$(git -C "$ROOT" ls-files '*.sh' | grep -v '^scripts/__tests__/')"
else
  FILES="$(cd "$ROOT" && find . -name '*.sh' -not -path './node_modules/*' -not -path './scripts/__tests__/*' | sed 's|^\./||')"
fi
SEEN=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  SEEN=$((SEEN + 1))
  n="$(hits "$ROOT/$f")"
  allowed="$(printf '%s\n' "$LEGACY" | awk -v f="$f" '$1 == f { print $2 }')"
  allowed="${allowed:-0}"
  if [ "$n" -gt "$allowed" ]; then
    bad "$f: $n argv-form secret line(s), allowed $allowed -- pass the secret with curl_tok / curl_hdr / curl_tok_url"
  elif [ "$n" -lt "$allowed" ]; then
    bad "$f: $n line(s), the table allows $allowed -- lower the number in LEGACY (the ratchet only tightens)"
  fi
done <<EOF
$FILES
EOF
[ "$SEEN" -gt 20 ] && ok "scanned $SEEN shell scripts" || bad "scanned only $SEEN shell scripts -- the file listing is broken, the ratchet saw nothing"
for f in scripts/set-bot-menu.sh scripts/smoke-test-slack-channel.sh scripts/pre-pr-review.sh; do
  if [ "$(hits "$ROOT/$f")" = 0 ] && grep -q 'lib/curl-tok.sh' "$ROOT/$f"; then ok "$f: no argv-form secret, uses the helper"; else bad "$f: argv-form secret or the helper is not sourced"; fi
done

SEC="probe-$(date +%s)-$$"
PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
REC="$(mktemp)"
python3 - "$PORT" "$REC" >/dev/null 2>&1 <<'PY' &
import http.server, sys, time
port, rec = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(rec, 'w') as f:
            f.write('path=%s\nauth=%s\ngoog=%s\n' % (self.path, self.headers.get('Authorization', ''), self.headers.get('x-goog-api-key', '')))
        time.sleep(3)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PY
SRV=$!
sleep 1

# shellcheck source=../lib/curl-tok.sh
. "$ROOT/scripts/lib/curl-tok.sh"

in_ps() { ps -A -ww -o args= | grep -F -- "$SEC" | grep -v grep >/dev/null; }
curl_running() { ps -A -ww -o args= | grep -v grep | grep -q -F 'curl -K -'; }
field() { sed -n "s/^$1=//p" "$REC"; }

echo "2) run: the secret reaches the server and is not in the process list"
probe() { # label, then a command string to run in the background
  local label="$1"; shift
  : > "$REC"
  ( "$@" >/dev/null ) &
  local pid=$!
  sleep 1.5
  if curl_running; then ok "$label: curl runs during the probe"; else bad "$label: curl did not run -- the ps check is not valid"; fi
  if in_ps; then bad "$label: the secret APPEARED in the process list"; else ok "$label: the secret is not in the process list"; fi
  wait "$pid"
}
probe "curl_tok" curl_tok "$SEC" -s "http://127.0.0.1:$PORT/x"
[ "$(field auth)" = "Bearer $SEC" ] && ok "curl_tok: the server got the Authorization header" || bad "curl_tok: server header is '$(field auth)'"
probe "curl_hdr" curl_hdr 'x-goog-api-key' "$SEC" -s "http://127.0.0.1:$PORT/x"
[ "$(field goog)" = "$SEC" ] && ok "curl_hdr: the server got the custom header" || bad "curl_hdr: server header is '$(field goog)'"
probe "curl_tok_url" curl_tok_url "$SEC" "http://127.0.0.1:$PORT/bot@TOKEN@/getMe" -s
[ "$(field path)" = "/bot$SEC/getMe" ] && ok "curl_tok_url: the server got the secret in the path" || bad "curl_tok_url: server path is '$(field path)'"

echo "3) control: the argv form is visible in ps (the probe is not blind)"
( curl -s -H "Authorization: Bearer $SEC" "http://127.0.0.1:$PORT/x" >/dev/null ) &
CK=$!
sleep 1.5
if in_ps; then ok "control: the secret is visible in argv"; else bad "control: the probe does NOT see an argv secret -- it is blind"; fi
wait "$CK"

echo "4) refusals: rc 2 and nothing sent"
: > "$REC"
curl_tok 'a"b' -s "http://127.0.0.1:$PORT/x" >/dev/null 2>&1; [ $? = 2 ] && ok "curl_tok: quote in the token" || bad "curl_tok: quote not refused"
curl_tok 'a\b' -s "http://127.0.0.1:$PORT/x" >/dev/null 2>&1; [ $? = 2 ] && ok "curl_tok: backslash in the token" || bad "curl_tok: backslash not refused"
curl_tok $'a\nb' -s "http://127.0.0.1:$PORT/x" >/dev/null 2>&1; [ $? = 2 ] && ok "curl_tok: newline in the token" || bad "curl_tok: newline not refused"
curl_hdr 'X-A' $'a\rb' -s "http://127.0.0.1:$PORT/x" >/dev/null 2>&1; [ $? = 2 ] && ok "curl_hdr: carriage return in the value" || bad "curl_hdr: CR not refused"
curl_tok_url 'a"b' "http://127.0.0.1:$PORT/bot@TOKEN@/x" -s >/dev/null 2>&1; [ $? = 2 ] && ok "curl_tok_url: quote in the token" || bad "curl_tok_url: quote not refused"
curl_tok_url "$SEC" "http://127.0.0.1:$PORT/no-placeholder" -s >/dev/null 2>&1; [ $? = 2 ] && ok "curl_tok_url: template without @TOKEN@" || bad "curl_tok_url: missing placeholder not refused"
[ ! -s "$REC" ] && ok "nothing reached the server" || bad "a refused call reached the server: $(cat "$REC")"

kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
rm -f "$REC"
echo "TOTAL: $FAILS failure(s)"
exit "$FAILS"
