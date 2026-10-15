# 17 - Updates

The Updates view covers system version tracking and the changelog.

---

## Version status

On page load, the system checks the relationship between the installed version and the latest available release.

- **Up to date** -- no update available.
- **Update available** -- the number and identifier of available new versions is shown. The **Install update** button applies the update.
- **Error** -- if the version check fails (e.g. no network), the error message and current version are shown.

---

## Changelog -- version grouping

Available changes are displayed grouped by version. Each version group contains a human-language summary and an expandable detail list of individual commit messages.

Unreleased commits (no version tag yet) appear under an "Upcoming" heading.

---

## Branch drift warning

If the installed system is not on the `main` branch, a warning banner appears at the top of the page. The banner suggests a command to return to the main branch:

```bash
git checkout main && bash update.sh
```

The banner can be dismissed; the dismissal is stored in the browser per branch. The branch status on the Updates page is always visible regardless of banner dismissal.

---

## Claude Code update

Below the version status, a **Claude Code** card shows how the `claude` binary itself is kept up to date. It is separate from the Marveen update above. The card is visible to admins only.

- **Installed / latest published** -- the version running on this machine and the newest one published.
- **Last check** -- when the weekly update task last ran and how it ended: updated, already current, held back (pinned) or failed.
- **Warnings** (the card gets an amber edge):
  - the last update run failed (nothing was restarted, and the task alerts on Telegram after the first failure);
  - the last check is more than 10 days old, so the weekly task is not running -- check the Tasks page;
  - a newer version is published than the installed one;
  - **restart pending** -- sessions that started before the update still run the old build;
  - sessions that could not be restarted automatically (restart them by hand).

How it works: the built-in auto-update is off in every session. Once a week (Monday 06:00) the `claude-update` task updates Claude Code a single time. Afterwards the dashboard restarts the running sessions that predate the update -- only idle ones, one at a time, with the main agent last. Sub-agents resume their conversation; the main agent comes back with a fresh one (its memory persists).

To update right away, open the **Tasks** page and run `claude-update` now. To hold a version or switch the automatic restart off, see the operations guide ("Claude Code updates").

---

## Related sections

- [18 - Profile](18-profile.md) -- password reset, break-glass, security:reset
- [13 - Audit Log](13-audit.md) -- system event tracking
