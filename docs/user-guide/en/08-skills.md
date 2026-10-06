# Skills

Skills are agents' reusable instruction files. A skill is a SKILL.md file that describes when and how to perform a particular type of task. On the dashboard, they are accessible from the agent detail panel in the Agents view.

The skills database is the source of truth: the SKILL.md files (and their `scripts/`, `references/` companions) on disk are a cache generated from it, marked with a `GENERATED from the skills DB` line after the frontmatter. Agents create and change skills with `PUT /api/skills/sql/<url-encoded id>` (`global/<name>` or `agent/<agent>/<name>`, `/` written as `%2F`); a direct file edit is still synced back to the database by a hook, but the database wins when the two differ.

---

## Usage figures

On the Skills page each skill shows a 30-day and a 90-day usage count and the time of its last use, and the list can be sorted by last use or by 30-day traffic. The count measures how many times an agent used the skill:

- through the Skill tool or a slash call (`/skill-name`), when the input starts with the skill's name;
- by reading the skill's files (SKILL.md, `references/`, `scripts/`), with the Read tool or from the shell (`cat`, `head`, `grep` and the like);
- by running a script from the skill's `scripts/` directory;
- by fetching the skill from the skills database API.

Listing, copying, editing and saving a skill, the built-in commands (`/clear`, `/help` and so on), and a reference that names the skills root, a pattern or a path built at run time instead of one concrete skill do not count as use. A repeat of the same agent, skill, session and kind of use within one minute counts once. The newer ways of measuring count from the day they were introduced and do not recover earlier use, so a skill that is only run from the shell shows a count below the real one at first.

---

## Skill types

| Type | Description |
|------|-------------|
| **Global** | Loaded from `~/.claude/skills/`; inherited by every agent |
| **Local** | Stored in the agent's own `.claude/skills/` directory; only that agent sees it |

Global skills appear with a "Global" badge in the list and cannot be deleted from the dashboard (an agent cannot delete shared files).

---

## The skill list

On the **Skills** tab of the agent detail panel, all skills available to that agent are listed:

- Skill name
- Short description (if provided in the SKILL.md frontmatter)
- Source badge (Global, if inherited)
- Delete button (active only for local skills)

---

## Adding a skill

1. On the **Skills** tab of the agent detail panel, click the **+ Skill** button.
2. Choose one of two methods:

### Create (manual)

- Enter the skill name (unique; no spaces recommended)
- Enter a description (optional, but recommended)
- Click **Save**

This creates the skill; the agent then fills in the content through the skills API (`PUT /api/skills/sql/<id>`).

### Import (file upload)

- Drag a SKILL.md file onto the upload area, or click to browse
- Click **Upload**

Useful when you want to transfer a ready-made skill file from another system or previous work.

---

## Deleting a skill

Local (non-global) skills show a delete button in the list row. The system asks for confirmation before deleting. Global skills can only be removed from the filesystem.

---

## Tips

- Global skills are available to all agents; put project-specific skills in a local location instead.
- The `name` and `description` fields in the SKILL.md frontmatter determine what appears in the list; fill them in for clarity.
- Skills are file-based; the dashboard only handles upload and deletion. To edit content, use the filesystem or ask an agent directly.
