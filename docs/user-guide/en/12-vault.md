# 12 - Vault `[ADMIN]`

> This section is visible to administrators only.

The Vault stores secrets, passwords, and SSH credentials in encrypted form. Stored values never appear in plaintext in logs or the UI -- values are encrypted one-way and cannot be retrieved after saving.

---

## What does the Vault hold?

The Vault manages three storage types:

**Secrets (general)** -- text-based secret values such as API keys and passwords. Each has an identifier and a human-readable label; the value cannot be read back after saving.

**SSH key pairs** -- generated or imported SSH private keys. The public key can be downloaded and copied; the private key is never shown in the UI.

**SSH servers** -- connection endpoints assigned to an SSH key pair. Agents use these for server access.

---

## Adding a secret

1. Click **+ Add**.
2. Enter an identifier (e.g. `openai-api-key`) and the value.
3. Global admins can choose which tenant the entry belongs to.
4. After saving, the value is encrypted -- it cannot be read back.

To delete an entry, click the **×** button at the end of the row.

---

## Generating an SSH key

The **Generate SSH key** button creates a new ED25519 key pair on the server:

1. Provide an identifier and an optional comment.
2. Global admins can set the tenant scope.
3. After generation, the **public key** is shown and can be copied (e.g. for appending to `~/.ssh/authorized_keys`).

The public half of an existing key is accessible by clicking its row in the list.

---

## Registering an SSH server

Use **Add SSH server** to record where an agent should connect:

- **Host** -- IP address or domain
- **Port** -- default: 22
- **Username** -- the connecting user
- **SSH key** -- the identifier of a key pair created or imported above

The tenant scope cannot be changed after the entry is created.

---

## Tenant view (global admin)

As a global admin, a tenant selector appears at the top of the page. You see and manage Vault entries for the selected tenant; the default is the `default` tenant.

---

## Related sections

- [15 - Users](15-users.md) -- token and tenant management
- [04 - Agents](04-agents.md) -- agent SSH configuration
