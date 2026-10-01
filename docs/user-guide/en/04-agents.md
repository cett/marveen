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

## Model fallback on usage limit

The model fallback feature keeps an agent working when its plan usage limit runs out. It is off by default and is switched on, together with the model chain and the revert time, in **Settings > Model fallback** (admin only; see [11 - Settings](11-settings.md)).

While it is enabled, the system checks every running agent (and the main agent) once a minute. An agent is moved down when its live terminal shows:

- an exhausted plan usage limit banner (a generic rate-limit or API overload error and the "approaching usage limit" warning do not count), or
- a "selected model is no longer available" error, confirmed on two consecutive checks.

The agent then steps one model down the chain and its session is restarted so the cheaper model takes over (sub-agents continue their conversation). The switch only happens while the agent is idle; if it is busy, it is deferred to a later check.

### It is an overlay, not a config change

The downgrade never rewrites the agent's configured model. It is stored as a temporary override in `store/model-fallback-state.json` (per agent: the configured model, the fallback model and the time of the downgrade). Every launch of the agent, including the main agent's launch script, uses the override first while it exists and otherwise falls back to the configured model.

Because the override is on disk:

- a dashboard or server restart does not lose it, and the revert timer keeps counting from the stored downgrade time;
- if the restart that should apply the new model fails, the override is rolled back to its previous state.

### Cooldown, chain and revert

- After every switch there is a 10 minute cooldown before another downgrade, so a freshly restarted session that still shows the old banner cannot walk the agent down the whole chain.
- Each agent walks the chain starting from its own configured model, one step at a time. At the bottom of the chain nothing more happens.
- Once the revert time (default 330 minutes) has passed since the downgrade and the limit message is gone, the override is removed and the agent restarts on its configured model. If the limit message is still showing, the agent stays on the fallback model. Like the downgrade, the revert waits for an idle agent.

### Seeing and resetting it

- The model badge on the agent card always shows the configured model. While a downgrade is active, the detail panel header shows the model the live session runs on (the fallback model) with a `fallback active: <model>` marker next to it. The model selector on the Settings tab keeps showing the configured model, with the same marker and a short hint underneath.
- Choosing a different model on the Settings tab and saving it replaces the override: the override is removed and the agent restarts on the model you chose. Saving without changing the selection does nothing: no request is sent, the agent is not restarted and the override stays in place, so the agent returns to its configured model when the revert time is up.
- To send an agent back to its configured model by hand without changing the configuration, remove that agent's entry from `store/model-fallback-state.json` and restart the agent. This is also the way to reset the main agent, whose model cannot be edited from the dashboard.
- Switching the feature off only stops new downgrades. An agent that is already on a fallback model still returns to its configured model: while an override exists the system keeps checking that agent once a minute and, when the revert time has passed since the downgrade, removes the override and restarts the agent exactly as it does with the feature on (an idle agent only; the main agent is relaunched). With the feature off a limit message on the terminal no longer holds the revert back, and agents without an override are not looked at. The saved revert time still applies, so the return can take as long as that time minus what has already passed since the downgrade; use the manual reset above if you do not want to wait.
- If an agent is stopped when its override is due, the override is simply removed without a restart, and the next start of the agent uses its configured model. This applies with the feature on as well.

---

## Federated agents

If the fleet includes a federated (remote-server) peer system, its agents also appear in the grid with a "Federated" badge and their reachability status. These agents can also be messaged from the Messages view.

---

## Tips

- The tmux copy button gives quick terminal access when the web terminal is unavailable.
- The process indicator updates in real time; when an agent stops, the card reflects it immediately.
- Auto-restart and idle-flush are configured independently; a warning appears in the detail panel when scheduled tasks could interfere with idle accumulation.
