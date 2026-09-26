# F06 MCP connectors

MCP (Model Context Protocol) connectors extend agent capabilities: filesystem access, web search, Google Workspace, GitHub, communication tools, and other external systems. Marveen ships with a built-in MCP catalog, manageable from the dashboard Settings > MCP page.

## MCP configuration files

MCP servers are defined in Claude Code `.mcp.json` files:

| File | Scope |
|------|-------|
| `.mcp.json` (project root) | Base configuration inherited by all agents |
| `agents/<name>/.mcp.json` | Configuration for a specific agent only |

On startup each agent loads all servers defined in the project-level and its own `.mcp.json`.

### .mcp.json structure

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@org/mcp-server-package"],
      "env": {
        "API_KEY": "vault:the-api-key-id"
      }
    }
  }
}
```

For a remote (HTTP) MCP server:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer vault:token-id"
      }
    }
  }
}
```

## Built-in catalog

Marveen ships with 14 pre-configured MCP connectors:

### Productivity

| Connector | Type | Auth |
|-----------|------|------|
| Google Drive | local | OAuth |
| Gmail | local | OAuth |
| Google Calendar | remote | OAuth |
| Notion | remote | OAuth |
| Fireflies | local | OAuth |

### Communication

| Connector | Type | Auth |
|-----------|------|------|
| Slack | remote | OAuth |

### Development and system

| Connector | Type | Auth |
|-----------|------|------|
| GitHub | local | API key |
| Filesystem | local | none |
| Playwright (browser) | local | none |

### Search and AI

| Connector | Type | Auth |
|-----------|------|------|
| Brave Search | local | API key |
| ElevenLabs | local | API key |
| fal.ai | remote | OAuth |

### Finance

| Connector | Type | Auth |
|-----------|------|------|
| Billingo | remote | OAuth |
| Wise | remote | OAuth |

## Adding an MCP connector (dashboard)

1. Open dashboard Settings > MCP
2. Select the connector from the catalog
3. Enter the required credentials (API key or OAuth)
4. Choose scope: project-level or a specific agent
5. Save -- the agent picks up the server on next startup

### OAuth connectors

For OAuth-based connectors (Google Drive, Gmail, Slack, etc.), the first activation opens a browser login page. After login the token is stored in the Vault.

### API key connectors

For API-key connectors (Brave Search, GitHub, ElevenLabs), the key is stored in the Vault. The `.mcp.json` references it as `vault:<id>`, never in plain text.

Brave Search example:

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "vault:brave-api-key"
      }
    }
  }
}
```

## Vault integration

Secret values (API keys, tokens) in MCP configurations are stored as `vault:<id>` references. Marveen provides three wrapper scripts for injecting Vault secrets (full details in [F02 Configuration](F02-configuration.md)):

| Script | When to use |
|--------|------------|
| `vault-env-wrapper.sh` | The MCP server expects the secret as an env variable |
| `vault-file-materializer.sh` | The MCP server expects the secret as a file path (e.g. a credential JSON) |
| `vault-inject-http-mcp.sh` | Vault references in HTTP MCP server `headers` fields |

`vault-inject-http-mcp.sh` runs only before Claude Code starts, reads `~/.claude.json` `mcpServers.*.headers` fields, and never writes secrets to disk.

## Adding a custom MCP server

MCP servers not in the catalog can be added directly to `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/my-mcp-server/index.js"],
      "env": {
        "SECRET_KEY": "vault:my-api-key"
      }
    }
  }
}
```

The project-root `.mcp.json` is not touched by `update.sh` -- custom entries are preserved across updates.

## Assigning connectors to specific agents

By default all agents inherit the project-root `.mcp.json` servers. If a connector is only needed by one agent, put it in `agents/<name>/.mcp.json`:

```bash
# Only this agent sees the connector
agents/
  <name>/
    .mcp.json   # agent-scoped
```

Conversely, a connector needed by all agents belongs in the project-root `.mcp.json`.

## Troubleshooting

### MCP server fails to start

Connector startup logs appear in the channels session pane (`tmux attach -t <agent-id>`). Common causes:

- `npx` not on PATH: confirm `node_modules/.bin` is in the environment
- Wrong API key: check the Vault entry in dashboard Settings > Vault
- Expired OAuth token: re-authenticate the connector from the dashboard MCP page

### "vault:<id> not found" error

The referenced Vault entry does not exist. Create it in dashboard Settings > Vault; the entry ID must match the `vault:<id>` reference in `.mcp.json`.

### Playwright / browser connector

The Playwright connector requires Chrome or Chromium. If not installed:

```bash
npx playwright install chromium
```

---

*Previous: [F05 Channel configuration](F05-channels.md)*
*Next: F07 Fleet and tenant management (coming soon)*
