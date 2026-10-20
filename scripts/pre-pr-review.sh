#!/usr/bin/env bash
# Optional cross-review by ChatGPT and Gemini before pushing a PR.
# Requires OPENAI_API_KEY and/or GEMINI_API_KEY stored in the vault.
# If a key is missing the reviewer is silently skipped.
#
# The diff leaves this machine, so it goes through the secret gate first (scripts/secret-gate.ts --outbound, the same
# detectors as the pre-commit hook and CI): a diff that carries a secret shape, a denied path or channel material is
# NOT sent and the script exits 1. The API keys go to curl on stdin (scripts/lib/curl-tok.sh), never on its command line.
#
# Usage: ./scripts/pre-pr-review.sh [base-ref]
#   base-ref defaults to upstream/main

set -euo pipefail

BASE="${1:-upstream/main}"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$INSTALL_DIR/scripts/lib/curl-tok.sh"

if [ ! -f "$INSTALL_DIR/store/.operator-token" ]; then
  echo "[pre-pr-review] Operator token not found, skipping cross-review." >&2
  exit 0
fi
# Dashboard port: env WEB_PORT, else the install .env, else 3420.
# One line at the start of the line, like doctor.sh: port-chain-no-hardcode.test.ts runs exactly these lines.
# The `|| true` inside: a missing .env (or no WEB_PORT line) makes grep fail, and under pipefail that would end the script.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "' || true)}"
WEB_PORT="${WEB_PORT:-3420}"
# The vault read is admin:all: the operator's token, through the wrapper (never on a command line).

get_secret() {
  local id="$1"
  local val
  val="$(DASHBOARD_BASE_URL="http://localhost:${WEB_PORT}" bash "$INSTALL_DIR/scripts/agent-api.sh" --token operator GET "/api/vault/$id" 2>/dev/null)" || true
  echo "$val" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('value',''))" 2>/dev/null || true
}

DIFF="$(git diff "$BASE"...HEAD)"
if [ -z "$DIFF" ]; then
  echo "[pre-pr-review] No diff found against $BASE, nothing to review."
  exit 0
fi

OPENAI_KEY="$(get_secret OPENAI_API_KEY)"
GEMINI_KEY="$(get_secret GEMINI_API_KEY)"
if [ -z "$OPENAI_KEY" ] && [ -z "$GEMINI_KEY" ]; then
  echo "[pre-pr-review] OPENAI_API_KEY not set in vault: ChatGPT review skipped."
  echo "[pre-pr-review] GEMINI_API_KEY not set in vault: Gemini review skipped."
  exit 0
fi

# Nothing is sent before the gate passes. The runner reads the diff from the repository it is started in.
if [ -x "$INSTALL_DIR/node_modules/.bin/tsx" ]; then TSX=("$INSTALL_DIR/node_modules/.bin/tsx"); else TSX=(npx --no-install tsx); fi
if ! "${TSX[@]}" "$INSTALL_DIR/scripts/secret-gate.ts" --outbound "$BASE...HEAD" >&2; then
  echo "[pre-pr-review] The diff did not pass the secret gate (see above): NOT sent to ChatGPT or Gemini." >&2
  exit 1
fi

# The request bodies are files (a diff can exceed the argument-size limit), kept in a private temp dir.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pre-pr-review.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

PROMPT="You are a senior software engineer reviewing a pull request. Review the following git diff for correctness, security, and code quality. Be concise and specific. List any real issues found.\n\nDiff:\n\`\`\`\n$DIFF\n\`\`\`"

# --- ChatGPT ---
if [ -n "$OPENAI_KEY" ]; then
  echo ""
  echo "=== ChatGPT Review ==="
  python3 -c "
import json, sys
prompt = sys.stdin.read()
print(json.dumps({'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': 1000}))
" <<< "$PROMPT" > "$TMP/openai.json"
  curl_tok "$OPENAI_KEY" -sf https://api.openai.com/v1/chat/completions \
    -H "Content-Type: application/json" \
    --data-binary "@$TMP/openai.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])"
else
  echo "[pre-pr-review] OPENAI_API_KEY not set in vault: ChatGPT review skipped."
fi

# --- Gemini ---
if [ -n "$GEMINI_KEY" ]; then
  echo ""
  echo "=== Gemini Review ==="
  python3 -c "
import json, sys
prompt = sys.stdin.read()
print(json.dumps({'contents': [{'parts': [{'text': prompt}]}]}))
" <<< "$PROMPT" > "$TMP/gemini.json"
  # The key goes in the x-goog-api-key header, not in a ?key= query string (a URL is logged and shown in ps).
  curl_hdr 'x-goog-api-key' "$GEMINI_KEY" -sf "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent" \
    -H "Content-Type: application/json" \
    --data-binary "@$TMP/gemini.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['candidates'][0]['content']['parts'][0]['text'])"
else
  echo "[pre-pr-review] GEMINI_API_KEY not set in vault: Gemini review skipped."
fi
