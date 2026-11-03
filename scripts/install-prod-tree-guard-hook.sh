#!/usr/bin/env bash
# Idempotent installer: protect the MAIN checkout (the tree the dashboard
# serves static files from and host updates pull into) against branch-ops.
# Auto-run by scripts/sync-hooks.sh on every update, so a re-clone or a new
# host regains the guard on its first update instead of silently losing it
# (PRODFAAG822 / RESPAWNZAJ822, 2026-08-22: a context-less resumed session
# branch-switched and committed on the live prod tree).
#
# Two git hooks, both scoped to the MAIN worktree only (linked worktrees have
# a different toplevel and pass untouched):
#   pre-commit.d/05-prod-tree-guard -- BLOCKS a commit on the main checkout.
#                    Override: MARVEEN_PROD_COMMIT_OK=1 git commit ...
#                    Installed as a CHAIN ENTRY, not as the pre-commit file:
#                    the secret gate (install-secret-gate-hook.sh) shares the
#                    same pre-commit.d dispatcher, and a monolithic pre-commit
#                    would couple the end state to installer ORDER -- run
#                    second, it would demote the other guard's runner to a
#                    .bak and silently disable it (review finding, msg 14196).
#   post-checkout -- git has no pre-checkout, so a branch switch cannot be
#                    blocked; this ALERTS the main agent and, when the tracked
#                    tree is clean, auto-reverts to the default branch.
#                    Override: MARVEEN_PROD_CHECKOUT_OK=1 git checkout ...
#
# No operator-specific paths are baked in: the guarded root is derived from
# the repository itself (the main worktree of the .git the hook lives in), so
# the same guard ships to every deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# --git-common-dir is relative to the repo ("`.git`"), so resolve it from inside ROOT, not from the caller's cwd.
HOOK_DIR="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-commit"
GUARD="$HOOK_DIR/pre-commit.d/05-prod-tree-guard"
DISPATCH_MARK="marveen-pre-commit-dispatcher"
MARK="marveen-prod-tree-guard"
mkdir -p "$HOOK_DIR/pre-commit.d"

# A hook file is OURS (a superseded hand-install or an earlier version of this
# installer) if it carries the marker OR a full sentence of OUR OWN prose.
# Content matters, not just the marker: the 2026-08-22 hand-installed host
# files PREDATE the marker convention this PR introduced (review, msg 14200).
# But the recognition is deliberately NARROW: never match the override/alert
# TOKENS (MARVEEN_PROD_COMMIT_OK etc.) -- those are published in our own
# error messages, so a foreign hook whose comment merely mentions the bypass
# would match and be deleted without trace (review, msg 14204; measured with
# a foreign lint-hook). On any doubt the default is PRESERVATION: a wrongly
# preserved duplicate is recoverable, a wrongly deleted foreign hook is not.
is_ours_precommit() {
  grep -qF 'marveen-prod-tree-guard' "$1" 2>/dev/null ||
  grep -qF 'BLOCKED: commit on the running prod checkout' "$1" 2>/dev/null
}
is_ours_postcheckout() {
  grep -qF 'marveen-prod-tree-guard' "$1" 2>/dev/null ||
  grep -qF 'Loud (non-blocking) alert when the running prod checkout switches branches' "$1" 2>/dev/null
}

# 0. A superseded MONOLITHIC prod-guard pre-commit is OURS: remove it instead
#    of preserving it, or it would ride along in the chain as a duplicate.
if [ -f "$DISPATCH" ] && is_ours_precommit "$DISPATCH" && ! grep -q "$DISPATCH_MARK" "$DISPATCH" 2>/dev/null; then
  rm "$DISPATCH"
  echo "  (removed superseded monolithic prod-guard pre-commit)"
fi

# 1. The sub-hook: block commits on the main checkout.
cat > "$GUARD" <<'EOF'
#!/usr/bin/env bash
# marveen-prod-tree-guard : block commits on the main (prod) checkout.
# The dashboard serves static files from this tree and host updates pull into
# it; repo work belongs in a worktree. Managed by
# scripts/install-prod-tree-guard-hook.sh -- edit there, not here.
# Deliberate override: MARVEEN_PROD_COMMIT_OK=1 git commit ...
set -euo pipefail
PROD_ROOT="${MARVEEN_PROD_ROOT:-$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")}"
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo)"
if [ "$TOPLEVEL" = "$PROD_ROOT" ] && [ "${MARVEEN_PROD_COMMIT_OK:-0}" != "1" ]; then
  echo "" >&2
  echo "BLOCKED: commit on the running main checkout ($PROD_ROOT)." >&2
  echo "The dashboard serves static files from this tree and host updates pull into it." >&2
  echo "Work in a worktree instead:" >&2
  echo "  git worktree add ../$(basename "$PROD_ROOT")-wt-<topic> -b <branch> origin/develop" >&2
  echo "Deliberate override: MARVEEN_PROD_COMMIT_OK=1 git commit ..." >&2
  exit 1
fi
exit 0
EOF
chmod +x "$GUARD"

# 2. Dispatcher: byte-for-byte the same contract as install-secret-gate-hook.sh
#    (same marker), so whichever installer runs first creates it and the other
#    leaves it alone -- no ordering dependency between the two guards.
if [ -f "$DISPATCH" ] && ! grep -q "$DISPATCH_MARK" "$DISPATCH" 2>/dev/null; then
  mv "$DISPATCH" "$HOOK_DIR/pre-commit.d/00-existing-precommit"
  chmod +x "$HOOK_DIR/pre-commit.d/00-existing-precommit"
  echo "  (preserved existing pre-commit as pre-commit.d/00-existing-precommit)"
fi
cat > "$DISPATCH" <<EOF
#!/usr/bin/env bash
# $DISPATCH_MARK : run every executable in pre-commit.d/.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
status=0
for h in "\$HOOK_DIR"/pre-commit.d/*; do
  [ -x "\$h" ] || continue
  "\$h" "\$@" || status=1
done
exit \$status
EOF
chmod +x "$DISPATCH"

# 3. post-checkout: no chain exists for this hook type; a pre-existing foreign
#    hook is preserved out of the way (a guard must not clobber, and the .bak
#    is inspectable). Our own superseded copy (marker OR content match, see
#    is_ours_postcheckout) is simply replaced -- backing up our own old file
#    would recreate the misleading-.bak class on this hook (review, msg 14200).
if [ -f "$HOOK_DIR/post-checkout" ] && ! is_ours_postcheckout "$HOOK_DIR/post-checkout"; then
  mv "$HOOK_DIR/post-checkout" "$HOOK_DIR/post-checkout.pre-prod-guard.bak"
  echo "  (preserved existing post-checkout as post-checkout.pre-prod-guard.bak)"
fi
cat > "$HOOK_DIR/post-checkout" <<'EOF'
#!/usr/bin/env bash
# marveen-prod-tree-guard : loud (non-blocking) alert + clean-tree auto-revert
# when the main (prod) checkout switches branches. Git has no pre-checkout
# hook, so the switch itself cannot be blocked -- but it must not sit silent
# either (PRODFAAG822: the 10:10 switch was found only on the next manual
# look). Managed by scripts/install-prod-tree-guard-hook.sh -- edit there.
# Deliberate switch: MARVEEN_PROD_CHECKOUT_OK=1 git checkout ...
# Never fails the checkout itself (no set -e; every step is best-effort).
[ "${3:-0}" = "1" ] || exit 0   # flag=1 -> branch switch; file checkouts exit here
PROD_ROOT="${MARVEEN_PROD_ROOT:-$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")}"
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo)"
[ "$TOPLEVEL" = "$PROD_ROOT" ] || exit 0
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ismeretlen)"
case "$BRANCH" in develop|main|master) exit 0 ;; esac
[ "${MARVEEN_PROD_CHECKOUT_OK:-0}" = "1" ] && exit 0
# Revert target: the deployment's default branch, derived, not assumed.
HOME_BRANCH=""
for b in develop main master; do
  if git show-ref --verify --quiet "refs/heads/$b"; then HOME_BRANCH="$b"; break; fi
done
# Auto-revert only when the TRACKED tree is clean: a guard must never lose
# work. Untracked files deliberately do not count (--untracked-files=no): a
# branch switch never touches them, and on a live tree untracked host-local
# files are the steady state -- counting them would make this revert never
# fire (measured 2026-08-22). Recursion is self-limiting: the revert lands on
# the home branch, where this hook exits at the case-guard above.
REVERTED="nem"
if [ -z "$HOME_BRANCH" ]; then
  REVERTED="nem (nincs develop/main/master ag)"
elif [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  if git checkout "$HOME_BRANCH" -q 2>/dev/null; then
    REVERTED="igen ($HOME_BRANCH)"
  else
    REVERTED="nem sikerult (checkout $HOME_BRANCH hibazott)"
  fi
else
  REVERTED="nem (a fa DIRTY, kezi beavatkozas kell)"
fi
# The alert goes out through the API wrapper as WHOEVER RAN THE CHECKOUT (the wrapper's own identity: the session's
# launch identity, else the agent the cwd names, which in the prod tree is the main agent); no wrapper, no alert.
# It is deliberately NOT sent with `--token main`: git runs this hook inside the session that ran the checkout, and a
# sub-agent session asking for the main agent's token is refused with AGENT_API_STRICT=1 (rule E1). So the alert carries
# the caller's own token and the caller's own name. A message from a sub-agent to the main agent is exactly what the
# alert is anyway: it also says WHO switched the prod tree.
# One case still ends in the MAIN token: a session that drops its launch identity (unsets CLAUDE_CONFIG_DIR) is
# resolved by the wrapper from the cwd, and in the prod tree the cwd names the main agent. So nothing else the session
# can set may steer where that token goes: the wrapper runs in a CLEAN environment (`env -i`) with a fixed PATH (no
# look-alike program on it), no proxy variables, and a URL computed below from the .env of this tree. Only the
# variables that name WHO is calling are passed on.
# The sender is not named in the body for a fleet-agent token: the server takes it from the token, and a different one
# is refused (403). Only a token without that pinning (the main agent's) must name it, so a 400 is retried once
# with the main agent as sender.
API_WRAPPER="$PROD_ROOT/scripts/agent-api.sh"
[ -r "$API_WRAPPER" ] || exit 0
# The recipient and the retry sender must be registered fleet agent ids (the API rejects made-up names, measured
# 2026-08-22) -- the source is named in the content prefix instead.
# The alert MUST name the tree it fired in: without it a test alert raised
# from a scratch root is word-for-word identical to a real one, and the
# reader starts an investigation (cost one wasted round on 2026-08-22).
# The dashboard origin is read from the .env of the guarded tree, NEVER from the environment of the session (see
# above); it must be http://localhost or http://127.0.0.1 with an optional port, anything else falls back to the default.
ORIGIN="$(grep -E '^MARVEEN_DASHBOARD_ORIGIN=' "$PROD_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
[[ "$ORIGIN" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$ ]] || ORIGIN="http://localhost:3420"
# The default recipient (and the sender of the retry) is the install's own main agent (MAIN_AGENT_ID in the .env of the
# guarded tree, read here at alert time, never baked in), not a fixed "marveen": on an install whose main agent has
# another id the API rejects an unknown recipient. No .env or no id = the stock "marveen".
MAIN_ID="$(grep -E '^MAIN_AGENT_ID=' "$PROD_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_ID="${MAIN_ID//[^a-zA-Z0-9_-]/}"
MAIN_ID="${MAIN_ID:-marveen}"
# The override comes from the session's environment and goes into hand-built JSON: same filter as MAIN_ID.
ALERT_TO="${MARVEEN_GUARD_ALERT_TO:-$MAIN_ID}"
ALERT_TO="${ALERT_TO//[^a-zA-Z0-9_-]/}"
ALERT_TO="${ALERT_TO:-$MAIN_ID}"
# The body is hand-built JSON. A branch name may hold a double quote (git allows it), which ends the string early:
# the API answers 400 and the alert vanishes into the `|| true` below, so a branch switch with such a name would go
# unreported. Only path-safe characters are kept in the two values that come from the repository.
BRANCH="${BRANCH//[^A-Za-z0-9._\/-]/_}"
TOPLEVEL="${TOPLEVEL//[^A-Za-z0-9._\/ -]/_}"
TEXT="\"to\":\"$ALERT_TO\",\"content\":\"[PROD-FA ORSEG, post-checkout hook] Fa: $TOPLEVEL -- agat valtott a(z) $BRANCH agra. (Ha ez az utvonal nem a telepites fo faja, ez PROBA, nem eles riasztas.) AUTO-VISSZAALLITAS: $REVERTED. Commitot a pre-commit hook blokkol; szandekos valtashoz MARVEEN_PROD_CHECKOUT_OK=1.\"}"
# send_alert <json-body>: the wrapper's stderr is kept (a failed send is reported below, never swallowed)
CALL_ENV=(PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin DASHBOARD_BASE_URL="$ORIGIN")
for v in CLAUDE_CONFIG_DIR MARVEEN_AGENT_ID MARVEEN_AGENT_TOKEN_FILE AGENT_API_STRICT; do
  [ -n "${!v:-}" ] && CALL_ENV+=("$v=${!v}")
done
send_alert() { printf '%s' "$1" | env -i "${CALL_ENV[@]}" /bin/bash "$API_WRAPPER" --max-time 5 POST /api/messages - 2>&1 >/dev/null; }
ALERT_ERR="$(send_alert "{$TEXT")"; ALERT_RC=$?
if [ "$ALERT_RC" -eq 22 ]; then ALERT_ERR="$(send_alert "{\"from\":\"$MAIN_ID\",$TEXT")"; ALERT_RC=$?; fi
if [ "$ALERT_RC" -ne 0 ]; then
  # The checkout itself is never failed, but the missing alert must not be silent: git shows a hook's stderr to the caller.
  echo "marveen-prod-tree-guard: the branch-switch alert was NOT sent (agent-api exit $ALERT_RC): $(printf '%s' "$ALERT_ERR" | head -3 | tr '\n' ' ')" >&2
fi
exit 0
EOF
chmod +x "$HOOK_DIR/post-checkout"

echo "✓ prod-tree-guard: commit block + branch-switch alert/revert installed for the main checkout."
