#!/bin/bash
# Install the skill-sql-sync-hook PostToolUse hook into every fleet agent's
# .claude/settings.json and the root .claude/settings.json (main agent).
#
# The hook fires after Edit, Write, or MultiEdit tool calls and upserts the
# edited SKILL.md content into the SQL skills table, keeping the file system
# and SQL store in sync automatically.
#
# Idempotent: safe to run multiple times. Uses a file-existence guard so the
# entry is harmless if the script is missing (e.g. before the branch is merged).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Allow override so the script works from a worktree (where agents/ is absent).
REPO_DIR="${MARVEEN_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HOOK_SRC="$REPO_DIR/scripts/hooks/skill-sql-sync-hook.py"
HOOK_CMD="bash -c '[ -f $HOOK_SRC ] && exec python3 $HOOK_SRC; exit 0'"

# ---- helper: patch one settings.json idempotently -------------------------
patch_settings() {
  local settings_file="$1"
  if [ ! -f "$settings_file" ]; then
    return 0
  fi
  python3 - "$settings_file" "$HOOK_CMD" <<'PYEOF'
import json, sys, os

settings_path = sys.argv[1]
hook_cmd = sys.argv[2]

with open(settings_path) as f:
    cfg = json.load(f)

hooks = cfg.setdefault('hooks', {})
post = hooks.setdefault('PostToolUse', [])

# Idempotent: skip if Edit|Write|MultiEdit matcher already present.
for entry in post:
    if entry.get('matcher') == 'Edit|Write|MultiEdit':
        print(f"  ⊙ already installed in {os.path.basename(settings_path)}")
        sys.exit(0)

post.append({
    'matcher': 'Edit|Write|MultiEdit',
    'hooks': [{
        'type': 'command',
        'command': hook_cmd,
        'timeout': 5,
    }],
})

with open(settings_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(f"  ✓ patched {settings_path}")
PYEOF
}

# ---- patch root settings (main agent) -------------------------------------
ROOT_SETTINGS="$REPO_DIR/.claude/settings.json"
echo "-> root agent"
patch_settings "$ROOT_SETTINGS"

# ---- patch every sub-agent ------------------------------------------------
AGENTS_DIR="$REPO_DIR/agents"
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    agent_name="$(basename "$agent_dir")"
    agent_settings="$agent_dir.claude/settings.json"
    echo "-> $agent_name"
    patch_settings "$agent_settings"
  done
fi

echo ""
echo "OK skill-sql-sync hook installed."
echo "  SKILL.md edits will now be synced to SQL automatically."
echo "  Note: run after merging feat/716f-skill-sql-sync-hook so the script exists on disk."
