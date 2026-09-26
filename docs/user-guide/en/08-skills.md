# Skills

Skills are agents' reusable instruction files. A skill is a SKILL.md file that describes when and how to perform a particular type of task. On the dashboard, they are accessible from the agent detail panel in the Agents view.

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

This creates an empty SKILL.md file; the agent then fills in the content via the filesystem.

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
