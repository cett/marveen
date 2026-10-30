#!/bin/bash
# Marveen system health check. Run: bash scripts/doctor.sh
# Exit 0 = all OK, 1 = something failed

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

# portable_mtime / portable_age (GNU and BSD stat). A checkout without the file reads as "cannot read", not a crash.
. "$INSTALL_DIR/scripts/lib/portable.sh" 2>/dev/null || true

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; FAIL=1; }

FAIL=0
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
# Dashboard port: env WEB_PORT, else .env, else the 3420 default. A fixed 3420
# made this diagnostic report a RUNNING dashboard as dead on any other port --
# and it is run precisely when something is already wrong.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
WEB_PORT="${WEB_PORT:-3420}"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

# Authenticated GET against the dashboard; prints nothing and fails when the
# token is missing or the dashboard does not answer. The doctor reads database
# facts through the API instead of opening the database file.
api_get() {
  local out
  out="$(DASHBOARD_BASE_URL="http://localhost:${WEB_PORT}" bash scripts/agent-api.sh --token operator --max-time 5 GET "$1" 2>/dev/null)" || return 1
  printf '%s\n' "$out"
}

echo -e "\n${BOLD}Marveen Doctor${RESET}: $(date '+%Y-%m-%d %H:%M:%S')\n"

# --- Services (systemd on Linux, launchd on macOS) ---
echo -e "${BOLD}Services${RESET}"
for component in channels dashboard; do
  if [ "$(uname -s)" = "Darwin" ]; then
    # launchd label convention: com.<MAIN_AGENT_ID>.<component>
    label="com.${MAIN_AGENT_ID}.${component}"
    # `launchctl list` prints "PID Status Label"; a literal "-" PID means loaded
    # but not currently running.
    pid="$(launchctl list 2>/dev/null | awk -v l="$label" '$3 == l {print $1}')"
    if [ -n "$pid" ] && [ "$pid" != "-" ]; then
      ok "$label: running (pid $pid)"
    elif [ -n "$pid" ]; then
      fail "$label: loaded but NOT running"
    else
      fail "$label: not loaded"
    fi
  else
    svc="${MAIN_AGENT_ID}-${component}"
    if systemctl --user is-active "$svc.service" &>/dev/null; then
      ok "$svc: running"
    else
      fail "$svc: NOT running"
    fi
  fi
done

# --- Tmux sessions ---
echo -e "\n${BOLD}Tmux sessions${RESET}"
if tmux has-session -t "${MAIN_AGENT_ID}-channels" 2>/dev/null; then
  ok "${MAIN_AGENT_ID}-channels: alive"
else
  warn "${MAIN_AGENT_ID}-channels: not running"
fi

# The heartbeat SUB-AGENT (session agent-heartbeat) is opt-in and OFF by default
# -- see the HEARTBEAT_AGENT_ENABLED gate in src/index.ts. Warning about a
# missing session on an install that never asked for it is pure noise, so only
# complain when it is actually switched on. The flag can come from the
# stored system config (config-overrides.json was migrated and retired, S8B)
# or from .env -- GET /api/settings already returns the effective value with
# config.ts's db-over-env precedence; .env is the fallback when the dashboard
# does not answer.
HB_AGENT=$(api_get /api/settings | python3 -c "
import sys, json
v = next((s['value'] for s in json.load(sys.stdin)['settings'] if s['key'] == 'HEARTBEAT_AGENT_ENABLED'), None)
print('' if v is None else ('1' if v in (True, 1, '1', 'true') else '0'))
" 2>/dev/null)
if [ -z "$HB_AGENT" ]; then
  HB_AGENT=$(grep -E "^HEARTBEAT_AGENT_ENABLED=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')
fi
if [ "$HB_AGENT" = "1" ]; then
  if tmux has-session -t "agent-heartbeat" 2>/dev/null; then
    ok "agent-heartbeat: alive"
  else
    warn "agent-heartbeat: enabled but NOT running"
  fi
else
  ok "agent-heartbeat: off by design (HEARTBEAT_AGENT_ENABLED not set)"
fi

# --- Channel health ---
echo -e "\n${BOLD}Telegram bridge${RESET}"
bash scripts/verify-channels-health.sh 2>&1 | grep -E '^\s+\(|HEALTHY|UNHEALTHY' | while read line; do
  case "$line" in
    *OK*) echo -e "  ${GREEN}✓${RESET} $line" ;;
    *FAIL*) echo -e "  ${RED}✗${RESET} $line"; FAIL=1 ;;
    *) echo "  $line" ;;
  esac
done
# Re-check exit code separately since subshell can't set FAIL
if ! bash scripts/verify-channels-health.sh &>/dev/null; then
  FAIL=1
fi

# --- Managed-settings channel org-policy gate ---
# claude-code >= 2.1.205 silently drops channel-plugin INBOUND notifications on a
# team/enterprise org unless the system managed-settings has channelsEnabled:true.
# Diagnostic only (warn, not fail): a personal org ignores the flag.
echo -e "\n${BOLD}Managed-settings${RESET}"
case "$(uname -s)" in
  Darwin) MANAGED_FILE="/Library/Application Support/ClaudeCode/managed-settings.json" ;;
  Linux)  MANAGED_FILE="/etc/claude-code/managed-settings.json" ;;
  *)      MANAGED_FILE="" ;;
esac
if [ -z "$MANAGED_FILE" ]; then
  warn "channelsEnabled: nem tamogatott OS -- kihagyva"
elif [ -f "$MANAGED_FILE" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open('$MANAGED_FILE')).get('channelsEnabled') is True else 1)" 2>/dev/null; then
  ok "channelsEnabled: OK ($MANAGED_FILE)"
else
  warn "channelsEnabled: HIANYZIK -- team/enterprise orgnal a bejovo channel-uzenetek eldobodhatnak. Fix: bash scripts/ensure-managed-channels-enabled.sh"
fi

# --- Channel keepalive ---
echo -e "\n${BOLD}Keepalive${RESET}"
KA_FILE="store/.channel-keepalive"
if [ -f "$KA_FILE" ]; then
  # portable_age: GNU and BSD stat, and a future mtime (clock set back) is "unknown", not a negative age
  KA_RC=0
  KA_AGE="$(portable_age "$KA_FILE")" || KA_RC=$?
  if [ "$KA_RC" -eq 2 ]; then
    warn "channel-keepalive: the file's mtime is in the future (clock set back?) -- the watchdog cannot judge its age until the clock catches up"
  elif [ "$KA_RC" -ne 0 ]; then
    warn "channel-keepalive: the file's mtime cannot be read"
  elif [ "$KA_AGE" -lt 600 ]; then
    ok "channel-keepalive: refreshed ${KA_AGE}s ago"
  elif [ "$KA_AGE" -lt 1200 ]; then
    warn "channel-keepalive: ${KA_AGE}s ago (watch out, restart after 18 min)"
  else
    fail "channel-keepalive: STALE (${KA_AGE}s) -- dashboard will likely restart"
  fi
else
  fail "channel-keepalive: file missing"
fi

# The keepalive probe stamps store/.channel-keepalive-probe at the start of every run (180s). Without a fresh stamp
# the probe is not running (on macOS: the launchd agent starts only while the user is logged in at the console), the
# keepalive file ages on a quiet session, and channel-watchdog.sh ignores its age after 600s.
PROBE_STAMP="store/.channel-keepalive-probe"
if [ -f "$PROBE_STAMP" ]; then
  PROBE_RC=0
  PROBE_AGE="$(portable_age "$PROBE_STAMP")" || PROBE_RC=$?
  if [ "$PROBE_RC" -eq 2 ]; then
    warn "channel-keepalive-probe: the stamp's mtime is in the future (clock set back?) -- the watchdog treats the probe as not running until the clock catches up"
  elif [ "$PROBE_RC" -ne 0 ]; then
    warn "channel-keepalive-probe: the stamp's mtime cannot be read"
  elif [ "$PROBE_AGE" -lt 600 ]; then
    ok "channel-keepalive-probe: ran ${PROBE_AGE}s ago"
  else
    warn "channel-keepalive-probe: NOT RUNNING (last run ${PROBE_AGE}s ago) -- the watchdog ignores the keepalive age meanwhile. Fix: bash scripts/install-channel-keepalive-probe.sh --load (macOS: a console login is needed, then launchctl bootstrap gui/\$(id -u) <plist>)"
  fi
else
  warn "channel-keepalive-probe: NOT RUNNING (no store/.channel-keepalive-probe) -- the watchdog ignores the keepalive age meanwhile. Fix: bash scripts/install-channel-keepalive-probe.sh --load (macOS: a console login is needed)"
fi

# --- Prod-tree guard hook (drift against the installer) ---
# The post-checkout hook on the main checkout is generated by scripts/install-prod-tree-guard-hook.sh. An older
# installed copy (the first version called curl with the dashboard token file and a fixed sender) keeps working
# silently until it is replaced, so compare the installed file with the heredoc the installer would write now.
echo -e "\n${BOLD}Prod-tree guard${RESET}"
PTG_INSTALLER="scripts/install-prod-tree-guard-hook.sh"
PTG_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
if [ ! -f "$PTG_INSTALLER" ] || [ -z "$PTG_COMMON" ]; then
  warn "prod-tree guard: no installer or not a git checkout -- skipped"
else
  PTG_HOOK="$PTG_COMMON/hooks/post-checkout"
  PTG_WANT="$(awk '/^cat > "\$HOOK_DIR\/post-checkout" <<.EOF.$/{f=1; next} f && /^EOF$/{exit} f' "$PTG_INSTALLER")"
  if [ ! -f "$PTG_HOOK" ]; then
    warn "prod-tree guard: post-checkout hook NOT installed. Fix: bash scripts/install-prod-tree-guard-hook.sh"
  elif [ -z "$PTG_WANT" ]; then
    warn "prod-tree guard: cannot read the expected hook out of $PTG_INSTALLER -- drift not checked"
  elif [ "$(cat "$PTG_HOOK")" = "$PTG_WANT" ]; then
    ok "prod-tree guard: post-checkout hook matches the installer"
  elif grep -q 'dashboard-token' "$PTG_HOOK" 2>/dev/null; then
    warn "prod-tree guard: the installed post-checkout is the OLD version (curl + store/.dashboard-token, fixed sender). Fix: bash scripts/install-prod-tree-guard-hook.sh"
  else
    warn "prod-tree guard: the installed post-checkout differs from the installer (drift). Fix: bash scripts/install-prod-tree-guard-hook.sh"
  fi
fi

# --- Settings ---
echo -e "\n${BOLD}Configuration${RESET}"
if [ -f ".claude/settings.json" ]; then
  MODEL=$(python3 -c "import json; d=json.load(open('.claude/settings.json')); print(d.get('model','NONE'))" 2>/dev/null)
  ok "Model: $MODEL"
  HOOK_COUNT=$(python3 -c "import json; d=json.load(open('.claude/settings.json')); print(len(d.get('hooks',{})))" 2>/dev/null)
  ok "Hooks: $HOOK_COUNT configured"
else
  fail ".claude/settings.json missing"
fi

# --- .env keys ---
echo -e "\n${BOLD}.env keys${RESET}"
for key in MAIN_AGENT_ID BOT_NAME TELEGRAM_BOT_TOKEN ALLOWED_CHAT_ID; do
  val=$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$val" ]; then ok "$key: present"; else fail "$key: MISSING"; fi
done
# Auth: mirrors claudeAuthPresent() in src/web/routes/onboarding.ts -- there are
# five legs, and only the first two live in .env. Checking .env alone reported a
# perfectly authenticated macOS install (Keychain leg) as broken.
# The Keychain probe is presence-only (no `-w`), so the secret never leaves it.
API_KEY=$(grep -E "^ANTHROPIC_API_KEY=" .env 2>/dev/null | head -1 | cut -d= -f2-)
OAUTH=$(grep -E "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$API_KEY" ]; then
  ok "Claude auth: present (.env API key)"
elif [ -n "$OAUTH" ]; then
  ok "Claude auth: present (.env OAuth token)"
elif [ -s "$HOME/.claude/.credentials.json" ]; then
  ok "Claude auth: present (~/.claude/.credentials.json)"
elif [ -s "store/.claude-oauth-token" ]; then
  ok "Claude auth: present (fleet setup-token in store/)"
elif [ "$(uname -s)" = "Darwin" ] && /usr/bin/security find-generic-password \
     -s "Claude Code-credentials" -a "$(id -un)" >/dev/null 2>&1; then
  ok "Claude auth: present (macOS Keychain)"
else
  fail "Claude auth: no credential found (env, credentials.json, fleet token, Keychain)"
fi

# --- Claude headless auth (official: long-lived setup-token) ---
echo -e "\n${BOLD}Claude headless auth${RESET}"
if grep -qE '^CLAUDE_CODE_OAUTH_TOKEN="?sk-ant-oat01-' .env 2>/dev/null; then
  ok "Headless token: long-lived setup-token configured (CLAUDE_CODE_OAUTH_TOKEN, ~1 year)"
elif grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=' .env 2>/dev/null; then
  warn "CLAUDE_CODE_OAUTH_TOKEN set, but not sk-ant-oat01- format (may be the wrong type)"
elif [ "$(uname -s)" = "Darwin" ] && /usr/bin/security find-generic-password \
     -s "Claude Code-credentials" -a "$(id -un)" >/dev/null 2>&1; then
  ok "Headless token: not set, but the macOS Keychain holds a Claude login (interactive sessions are fine; only add a setup-token if you run agents headless)"
else
  warn "CLAUDE_CODE_OAUTH_TOKEN missing -- run: claude setup-token, then put it in .env"
fi
# .credentials.json is now only a legacy fallback (setup-token takes precedence), not critical if expired.
CREDS="$HOME/.claude/.credentials.json"
if [ -f "$CREDS" ]; then
  HOURS_LEFT=$(python3 -c "import json,time; o=json.load(open('$CREDS')).get('claudeAiOauth',{}); e=o.get('expiresAt',0); print(round((e-time.time()*1000)/3600000,1) if e else -1)" 2>/dev/null)
  [ "$HOURS_LEFT" != "-1" ] && echo "  (legacy .credentials.json: ${HOURS_LEFT}h left -- not critical alongside the setup-token)"
fi

# --- Ledger hook scripts ---
echo -e "\n${BOLD}Hook scripts${RESET}"
for f in scripts/hooks/ledger-capture.py scripts/hooks/ledger-outbound.py scripts/hooks/ledger-replay.py; do
  if [ -f "$f" ]; then ok "$f"; else fail "$f missing"; fi
done

# --- Stale global hook copies ---
# Some hooks are deliberately installed as a synced copy under ~/.claude/hooks/ (the install-*-hook.sh scripts
# refresh these on every deploy, so repo and global copy stay byte-identical -- that is fine). A STALE copy is
# different: it was copy-pasted once, the repo version was later fixed (e.g. the shared-token retirement in
# auto-skillify.py), and the global copy kept running the old code because nothing re-synced it. Flag only a
# same-name file whose CONTENT has drifted from the repo version; an identical synced copy is not a finding.
GLOBAL_HOOKS_DIR="${HOME}/.claude/hooks"
if [ -d "$GLOBAL_HOOKS_DIR" ]; then
  DUP_FOUND=0
  for repo_hook in scripts/hooks/*.py; do
    [ -f "$repo_hook" ] || continue
    base="$(basename "$repo_hook")"
    global_copy="$GLOBAL_HOOKS_DIR/$base"
    if [ -f "$global_copy" ] && ! diff -q "$repo_hook" "$global_copy" >/dev/null 2>&1; then
      fail "stale global copy: $global_copy has drifted from $repo_hook -- point the hook command at the repo path and rename the copy to .stale"
      DUP_FOUND=1
    fi
  done
  [ "$DUP_FOUND" -eq 0 ] && ok "no global hook copy has drifted from its repo counterpart (scripts/hooks/*)"
fi

# --- Agent tokens ---
# Each agent signs its dashboard calls with its own token file (agents/<id>/.agent-token, the main
# agent's in the project root) and the operator scripts use store/.operator-token. They are not in the
# backup, so a restored install lacks them until the issuer runs. There is no shared-token fallback any
# more, so a missing or stale one is a failure, not a warning.
echo -e "\n${BOLD}Agent tokens${RESET}"
# `agent-tokens check` is read-only and compares every token file with the database: a file that is
# present but not (or no longer) an active token for its subject is as useless as a missing one, which
# a presence test cannot see (an older database restored under newer files). Exit 1 = findings; any
# other failure (no node_modules, no tsx) falls back to the presence test below.
TOKEN_CHECK_OUT="$(npm run --silent agent-tokens -- check 2>/dev/null)"
TOKEN_CHECK_RC=$?
if [ "$TOKEN_CHECK_RC" -eq 0 ]; then
  ok "Agent tokens: every token file matches an active token (main agent, agents, operator)"
elif [ "$TOKEN_CHECK_RC" -eq 1 ] && [ -n "$TOKEN_CHECK_OUT" ]; then
  while IFS="$(printf '\t')" read -r t_subject t_status t_role t_path t_detail; do
    [ -n "$t_subject" ] && [ "$t_status" != "ok" ] || continue
    # A stray extra active row is only cleared by a rotation; a plain issue would keep the valid file.
    t_rotate=""
    [ "$t_status" = "multiple_active" ] && t_rotate=" --rotate"
    case "$t_subject" in
      operator) t_fix="npm run agent-tokens -- issue-operator${t_rotate}" ;;
      shared)   t_fix="npm run agent-tokens -- rotate-shared" ;;
      *)        t_fix="npm run agent-tokens -- issue ${t_subject}${t_rotate}" ;;
    esac
    fail "token ${t_subject}: ${t_status}${t_detail:+ (${t_detail})} -- run: ${t_fix}"
  done <<EOF
$TOKEN_CHECK_OUT
EOF
else
  MAIN_ID="$(grep -E '^MAIN_AGENT_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  MISSING_TOKENS=""
  [ -f ".agent-token" ] || MISSING_TOKENS="$MISSING_TOKENS ${MAIN_ID:-main}"
  for d in agents/*/; do
    [ -f "${d}CLAUDE.md" ] || [ -f "${d}agent-config.json" ] || continue
    [ -f "${d}.agent-token" ] || MISSING_TOKENS="$MISSING_TOKENS $(basename "$d")"
  done
  if [ -n "$MISSING_TOKENS" ]; then
    fail "no agent token for:${MISSING_TOKENS} -- run: npm run agent-tokens -- issue"
  else
    ok "Agent tokens: present for the main agent and every agent (agent-tokens check could not run)"
  fi
  if [ -f "store/.operator-token" ]; then ok "Operator token: present"; else fail "store/.operator-token missing -- run: npm run agent-tokens -- issue-operator"; fi
fi

# --- Shared token go-live gate (informational, never a failure) ---
# TOKEN_SHADOW_WINDOW_START=YYYY-MM-DD in .env is the first UTC day of the measurement clock (see
# scripts/token-shadow-gate.py). The line shows where the gate stands; without the operator's
# attestations (--uptime-confirmed, --dry-run-clean) an INCONCLUSIVE here is expected, so it is
# informational only. Each run makes one canary call (caller gate-canary) the gate excuses.
GATE_START="$(grep -E '^TOKEN_SHADOW_WINDOW_START=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
if [ -n "$GATE_START" ] && command -v python3 >/dev/null 2>&1; then
  GATE_STATE="$(python3 scripts/token-shadow-gate.py --window-start "$GATE_START" --json 2>/dev/null | python3 -c 'import sys, json; print(json.load(sys.stdin)["state"])' 2>/dev/null)"
  echo -e "\n${BOLD}Shared token gate${RESET}"
  ok "token-shadow-gate: ${GATE_STATE:-INCONCLUSIVE} (window start ${GATE_START}); details: python3 scripts/token-shadow-gate.py --window-start ${GATE_START}"
fi

# --- Dashboard API ---
echo -e "\n${BOLD}Dashboard${RESET}"
if [ -f "store/.operator-token" ]; then
  HTTP_ERR="$(DASHBOARD_BASE_URL="http://localhost:${WEB_PORT}" bash scripts/agent-api.sh --token operator --max-time 5 GET /api/agents 2>&1 >/dev/null)"
  if [ -z "$HTTP_ERR" ]; then
    ok "Dashboard API: responding (HTTP 200)"
  else
    fail "Dashboard API: ${HTTP_ERR#agent-api: }"
  fi
else
  fail "no operator token (store/.operator-token missing): npm run agent-tokens -- issue-operator"
fi

# --- Database ---
echo -e "\n${BOLD}Database${RESET}"
MEM=$(api_get /api/memories/stats | python3 -c "import sys, json; print(json.load(sys.stdin)['total'])" 2>/dev/null)
if [ -n "$MEM" ]; then
  ok "Database: alive via the dashboard ($MEM memories)"
else
  fail "Database: the dashboard could not read the memory count"
fi

# --- Scheduled tasks ---
echo -e "\n${BOLD}Scheduled tasks${RESET}"
if [ -d ~/.claude/scheduled-tasks ]; then
  ENABLED=0; DISABLED=0
  for d in ~/.claude/scheduled-tasks/*/; do
    enabled=$(python3 -c "import json; c=json.load(open('$d/task-config.json')); print(c.get('enabled', True))" 2>/dev/null)
    name=$(basename "$d")
    if [ "$enabled" = "True" ]; then
      ok "$name: active"
      ENABLED=$((ENABLED+1))
    else
      warn "$name: disabled"
      DISABLED=$((DISABLED+1))
    fi
  done
  [ "$ENABLED" -eq 0 ] && warn "No active scheduled task"
else
  warn "~/.claude/scheduled-tasks does not exist"
fi

# --- Recent failures log ---
echo -e "\n${BOLD}Failures (last 24h)${RESET}"
if [ -f "store/channels-failures.log" ]; then
  RECENT=$(find store/channels-failures.log -mmin -1440 2>/dev/null)
  if [ -n "$RECENT" ]; then
    COUNT=$(wc -l < store/channels-failures.log)
    warn "channels-failures.log: $COUNT entries"
    tail -3 store/channels-failures.log | while read line; do echo "    $line"; done
  else
    ok "No recent failures"
  fi
else
  ok "No failure log"
fi

# --- Summary ---
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All OK.${RESET}\n"
else
  echo -e "${RED}${BOLD}There are failures -- check the ✗ lines above.${RESET}\n"
fi
exit "$FAIL"
