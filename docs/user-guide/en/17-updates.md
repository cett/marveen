# 17 - Updates

The Updates view covers system version tracking, the changelog, and authentication recovery tools.

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

## Authentication recovery

This section describes recovery paths for locked-out or compromised access. The core principle: whoever can run commands on the host machine is the root authenticator -- all recovery paths build on this.

### `npm run dashboard-user` -- the break-glass tool

The CLI writes directly to the database (no HTTP, no auth gate), so it works even when the web login is misconfigured or unreachable:

```bash
npm run dashboard-user -- list                           # list existing users
npm run dashboard-user -- reset-password <user>          # reset a forgotten password
npm run dashboard-user -- remove <user>                  # delete a user
npm run dashboard-user -- sessions:clear [<user>]        # clear browser sessions
npm run dashboard-user -- security:reset                 # emergency reset (see below)
```

`reset-password` does not require the old password -- every run produces an audit entry and a channel notification.

### `security:reset` -- the panic button

In one step:

- **revokes all device keys** (Bridge, phone -- re-pairing required),
- **clears all browser sessions** (everyone must log in again).

What it does not touch: passwords and user accounts remain, and the dashboard-token continues to work. This is the "some issued credential has gone rogue, cut them all now" lever -- not a factory reset.

The running server enforces the reset within 60 seconds; no restart is needed.

### HTTP break-glass (with token)

The holder of the dashboard-token can change a password via `POST /api/auth/password` without `current_password` by supplying a `username`. Only accessible with `token` authentication -- session, device key, or federation principal receives a 403.

### Audit trail

All recovery operations write to the `config_change_log` table (with `security.*` keys, metadata only: username and counts, never credentials). Events are searchable in the Audit Log view under the `config` source.

---

## Related sections

- [13 - Audit Log](13-audit.md) -- searching recovery entries
- [15 - Users](15-users.md) -- dashboard users and device keys
