# Agents

The Agents view displays all running and stopped agents in a card grid. From here you can open any agent's detail panel, start a terminal session, and create new agents.

---

## The card grid

Each agent appears on a card showing:

| Element | Description |
|---------|-------------|
| **Avatar / monogram** | The agent's image or the first letter of its name |
| **Name** | The agent's display name |
| **Description** | A short one-line description |
| **Model badge** | The configured AI model |
| **Process indicator** | Running / Stopped - the tmux session state |
| **Channel indicator** | Online / Offline - the channel connection state |
| **Tenant chip** | Which tenant the agent belongs to (admin view only) |

The main agent's card always appears first, with a dedicated "Main" badge.

---

## View toggle

Switch between the card grid and the org chart (hierarchy tree) using the buttons in the top-right corner.

---

## Agent detail panel

Clicking a card opens the detail panel with six tabs:

### Overview

- Whether the agent is running and since when
- Channel connection status
- Context token usage
- Auto-restart settings (daily time or interval)
- Idle-flush (context guard) configuration

### Settings

- AI model selection
- CLAUDE.md editor (the agent's instruction file)
- Persona file (soul.md) editor
- MCP configuration JSON editor
- Auth mode and MCP scope

The main agent's settings are read-only from the dashboard; edit them via the filesystem or by asking the main agent on Telegram.

### Channel

The agent's Telegram / Discord / Slack connection status, bot username, and pairing management.

### Skills

The list of skill files available to this agent.

### Team

The agent's place in the fleet hierarchy: role (leader / member), manager, and delegated agents. This tab is hidden for the main agent.

### Activity

A log of the agent's most recent tool calls (trace / waterfall view).

---

## Creating a new agent

1. Click the **+ Agent** button (top right).
2. Enter a name, description, and model.
3. Pick an avatar from the gallery or upload a custom image.
4. Click **Create**.

The system creates the agent's configuration directory; the agent activates on the next restart.

---

## Terminal and Conversation buttons

Two quick-action buttons appear on every running agent's card:

- **Terminal** - opens the agent's tmux session in the web terminal; the button turns green when the agent is actively working
- **Conversation** - opens a readable transcript of the agent's past messages

The `⧉ tmux` button copies the agent's tmux attach command to the clipboard.

---

## Federated agents

If the fleet includes a federated (remote-server) peer system, its agents also appear in the grid with a "Federated" badge and their reachability status. These agents can also be messaged from the Messages view.

---

## Tips

- The tmux copy button gives quick terminal access when the web terminal is unavailable.
- The process indicator updates in real time; when an agent stops, the card reflects it immediately.
- Auto-restart and idle-flush are configured independently; a warning appears in the detail panel when scheduled tasks could interfere with idle accumulation.
