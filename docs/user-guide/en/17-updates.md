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

## Related sections

- [18 - Profile](18-profile.md) -- password reset, break-glass, security:reset
- [13 - Audit Log](13-audit.md) -- system event tracking
