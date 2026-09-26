# 16 - Connections

The Connections view manages all external integrations in one place: MCP connectors, federated peer connections, and memory import sources.

---

## MCP connectors

MCP (Model Context Protocol) connectors expose external tools to agents -- e.g. filesystem, GitHub, Hetzner, Gmail, Google Drive. The view has two tabs.

### Installed connectors

The **Installed** tab lists the MCP servers registered on the system. Each card shows:

- The connector name and icon
- Current status (active / error / unknown)
- The command and arguments assigned to the agent (if configured)

The **Refresh** button runs the server-side health check and updates statuses. Refresh is manual because each run starts the configured servers -- avoid frequent refreshes when many stdio-type connectors are installed.

### Connector catalog (Gallery)

The **Gallery** tab shows a browsable catalog of installable MCP connectors. Filter by category. Selecting a card opens the installation dialog where you provide the required configuration (e.g. API keys, paths).

---

## Federation

Federation lets you connect to agents running in separate, independent systems. Through federated peer connections, agents can see each other's status and exchange messages.

### Master configuration

The top of the page shows the local system's federation configuration: the system name, the federated access URL, and the current number of connected peers.

### Peer list

Peers are shown in a table. Each row shows:

- The peer name and URL
- Current connection state (ok / error / unknown)
- Time of the last successful ping

**Add a peer:** click **+ Add peer**, enter the name and URL. The system attempts to connect automatically.

**Edit / delete a peer:** use the buttons at the end of the row.

---

## Import

Import sources load content into the memory database on a regular schedule. Supported source types:

- **Local file** -- a directory accessible on the server
- **Google Drive** -- sync Drive files
- **SharePoint** -- SharePoint document libraries
- **Confluence** -- Confluence pages

### Managing import sources

Sources are listed in a table. Each row shows the type, name, sync interval, last sync time, and status (active / inactive).

**Add a source:** click **+ Add source**.

**Manual sync:** the **Sync** button triggers an immediate sync.

**Sync log:** the **Log** button shows the sync history for that source.

**Disable / enable:** pause a source without deleting its data.

**Delete:** **Wipe source** removes all memories loaded from this source; **Delete** also removes the source entry itself.

As a global admin, a tenant selector appears on the page to manage import sources for the selected tenant.

---

## Related sections

- [12 - Vault](12-vault.md) -- storing connector credentials
- [04 - Agents](04-agents.md) -- MCP connectors assigned to agents
- [07 - Memories](07-memories.md) -- searching imported content
