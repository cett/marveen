# 18 - Profile

The Profile view manages your own account: display name, email, password, and session management. Settings here apply only to your own account.

---

## Personal details

The top of the page shows an initials-based avatar, your display name, username, and role.

**Edit display name and email:** click the field, make your changes, and save. Email is optional.

---

## Change password

Click **Change password** to open a dialog:

1. Enter your current password.
2. Enter the new password (minimum 12 characters).
3. Confirm the new password.

After saving, existing active sessions remain valid -- the new password only applies to new logins.

---

## Sessions

The **Sessions** section shows how many active browser sessions are open. The **Log out of all devices** button invalidates all active sessions -- including the current browser. You will need to log in again.

---

## Authentication recovery

This section describes recovery paths for situations where you forgot your password, locked yourself out, or a credential may have been compromised. The core principle: whoever can run commands on the host machine is the root authenticator.

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

- [15 - Users](15-users.md) `[ADMIN]` -- user management, device keys
- [13 - Audit Log](13-audit.md) `[ADMIN]` -- searching recovery entries
