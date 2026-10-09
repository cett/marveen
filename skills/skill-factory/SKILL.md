---
name: skill-factory
description: Turn any workflow, conversation, or demonstrated process into a reusable SKILL.md. Use when the user says "turn this into a skill", "make a skill from this", "save this workflow", "remember how to do this", or after completing a complex multi-step task that should be repeatable. Also triggers on "tanítsd meg magad", "jegyezd meg ezt a folyamatot", "csinálj ebből skill-t".
---

# Skill Factory

Convert demonstrated workflows into reusable skills. This is a meta-skill: it creates other skills.

## When to Use

- User explicitly asks to create a skill from a workflow
- User says "remember how to do this" or "save this process"
- After a complex task (5+ tool calls) that could be reusable
- When user corrects your approach and the correction is generalizable
- Hungarian triggers: "tanítsd meg magad", "csinálj skill-t", "jegyezd meg"

## Procedure

### Step 1: Extract the Workflow

Analyze the current conversation (or specified workflow) and identify:

1. **Trigger conditions**: When should this skill activate?
2. **Input**: What does the skill need to start?
3. **Steps**: What are the concrete steps (in order)?
4. **Tools used**: Which tools/commands were involved?
5. **Decision points**: Where did you need to make choices?
6. **Error handling**: What went wrong and how was it fixed?
7. **Output**: What's the expected result?

### Step 2: Generalize

Don't just copy the specific instance. Abstract it:

- Replace specific file names with `[input-file]` patterns
- Replace specific URLs with `[target-url]` patterns
- Identify which parts are constant vs. variable
- Note any prerequisites or dependencies
- Think about edge cases the original workflow didn't cover

**Agent name abstraction (required):**

Never hardcode fleet-specific agent names or IDs in a skill. Use these placeholders instead:

| Placeholder | Meaning |
|-------------|---------|
| `<AGENT>` | This agent's own agent_id (self-reference) |
| `<MAIN_AGENT>` | The fleet's main orchestrator agent |
| `<YOUR_MANAGER>` | This agent's `team.reportsTo` value |
| `<BACKEND_AGENT>` | Agent with `backend` capability |
| `<TESTER_AGENT>` | Agent with `testing`/`qa` capability |
| `<DESIGN_AGENT>` | Agent with `design`/`visual` capability |
| `<ARCHITECT_AGENT>` | Agent with `architecture`/`it` capability |
| `<FINANCE_AGENT>` | Agent with `finance`/`accounting` capability |
| `<IT_MANAGER_AGENT>` | Agent with `it-management` capability |
| `<HEALTH_AGENT>` | Agent with `garmin`/`health-data` capability |
| `<MARKETING_AGENT>` | Agent with `marketing`/`social` capability |
| `<AGENT_A>`, `<AGENT_B>` | Generic agents in Pitfalls illustrations |

**How to resolve at skill-use time:** read the fleet roster in your own CLAUDE.md (the "A flotta többi agense" section, auto-generated at agent start). Each line lists an agent_id with its capability tags. Match the placeholder's capability to the agent that has that tag.

**In Pitfalls/incident entries:** incident dates and descriptions stay as-is. Concrete agent names in examples become `<AGENT_A>`/`<AGENT_B>`; self-references become `<AGENT>`; orchestrator references become `<MAIN_AGENT>`.

**Placeholders in prose only, never in commands (CRITICAL):** A placeholder inside an executable command is a literal string that never matches. The command runs, finds nothing, and gives no error -- silent failure. Example: `tmux ls | grep agent-<DESIGN_AGENT>` will always return empty. Rule: if a line is inside a code fence (` ``` `), use the real agent ID, not the placeholder. Placeholders go in prose descriptions, table cells, and narrative text only. The migration script enforces this by skipping code fences.

### Step 3: Save the skill through the API

The skills DB is the source of truth; `SKILL.md` on disk is a generated cache. Create and update are the same call: `PUT /api/skills/sql/<url-encoded id>` (`global/<name>` for a fleet-wide skill, `agent/<AGENT>/<name>` for one agent's own; the `/` in the id must be `%2F`). Build the JSON with a script, never by hand-escaping.

```bash
SKILL_NAME="[kebab-case-name]"
python3 - <<'PY' | bash scripts/agent-api.sh --token admin PUT "/api/skills/sql/global%2F$SKILL_NAME" -
import json
content = """---
name: [skill-name]
description: [What it does + when to trigger. Be specific and "pushy" -- include multiple trigger phrases so the skill activates when needed.]
---

# [Skill Name]

## When to Use
[List concrete trigger conditions and contexts]

## Prerequisites
[Dependencies, tools, access needed -- skip if none]

## Procedure
1. [First step -- be specific, include commands]
2. [Second step]
...

## Pitfalls
- **[Problem]**: [How to solve it]

## Verification
- [How to confirm the result is correct]

## Examples
**Example 1:**
Input: [what the user said]
Output: [what was produced]
"""
print(json.dumps({"content": content}))
PY
```

The response is `201` with the new row (`200` when it already existed and was updated). The server writes `~/.claude/skills/$SKILL_NAME/SKILL.md` from the row right away. Do not create that file yourself; if you edit it with Edit/Write anyway, the file-to-DB hook syncs it back, but the API is the primary path.

### Step 4: Add Supporting Files (if needed)

If the workflow involves scripts or templates, they are stored in the DB too (`skill_files`), one call per file; the relative path is ONE url-encoded segment:

```bash
python3 -c 'import json,sys; print(json.dumps({"content": open(sys.argv[1]).read()}))' ./run.sh \
  | bash scripts/agent-api.sh --token admin PUT "/api/skills/sql/global%2F$SKILL_NAME/files/scripts%2Frun.sh" -
```

- `scripts/`: Executable code for deterministic/repetitive tasks (add `"mode": 493` for an executable file; `content_base64` for binary)
- `references/`: Documentation loaded into context as needed
- `assets/`: Templates, icons, or other static files

### Step 5: Update Skill Index

```bash
bash scripts/skill-index.sh
```

### Step 6: Validate

Test the skill mentally:
- Would the description trigger on a realistic user message?
- Are the steps clear enough to follow without the original context?
- Are edge cases covered in Pitfalls?
- Is the SKILL.md under 500 lines?

## Pitfalls

- **Overfitting to one example**: Don't just save the exact steps you did. Generalize so it works for similar but different inputs.
- **Too vague descriptions**: The description field is the primary trigger. Be specific and include multiple phrasings.
- **Missing error handling**: If you hit errors during the original workflow, document them in Pitfalls.
- **Too long**: Keep SKILL.md under 500 lines. Move large content to `references/` subdirectory.
- **Duplicate skills**: Before creating, check `~/.claude/skills/.skill-index.md` for existing similar skills. Patch instead of creating a new one (`GET /api/skills/sql/<id>`, change the text, `PUT` it back).
- **Hand-writing the file**: a `SKILL.md` you write with `cat >` is only a cache the hook may or may not sync; the DB row is what survives a restore and what the regen writes back. Use the API.

## Skill Quality Checklist

Before finalizing, verify:
- [ ] Description includes multiple trigger phrases
- [ ] Steps are numbered and concrete
- [ ] Commands are copy-pasteable (no pseudocode)
- [ ] Variables are clearly marked with `[brackets]`
- [ ] Pitfalls section has at least one entry
- [ ] Verification section explains how to confirm success
- [ ] Under 500 lines
- [ ] No hardcoded agent names -- placeholders used (`<AGENT>`, `<MAIN_AGENT>`, role-based)
