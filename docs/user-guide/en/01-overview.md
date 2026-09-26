# Overview

The Overview is the dashboard home page. It shows the current state of the system at a glance: active agents, today's message traffic, tasks, and API quota usage.

---

## What you see on this page

### Stat cards

A compact panel at the top shows:

- **Active agents** - how many agents are currently running
- **Messages today** - number of messages exchanged between agents today
- **Updates** - number of available version updates (details in the Updates view)

The subtitle next to each number adds context: e.g. "same as yesterday" or "+3 from yesterday".

### Team table

The team table shows the live status of every configured agent. Each row displays:

- The agent's name and current activity
- Time of last activity (relative, e.g. "5 m")
- Blackboard status - what the agent is currently doing (if reported)

Clicking an agent name opens the Agents view for that agent.

### Recent activity

The bottom of the page lists the most recent system events - messages, memory saves, scheduled runs. If there is no recent activity, "No recent activity." is shown.

### Quota strip `[ADMIN]`

Administrators see a quota strip showing API usage over two time windows (5 hours / 7 days). The strip is grey (normal), orange (60-80%) or red (80%+) depending on usage level.

---

## Tenant filter

In multi-tenant setups, a dropdown in the top-right lets you switch between tenants. The overview always shows data for the selected tenant.

---

## Tips

- The Overview refreshes automatically every 30 seconds.
- The Blackboard status (`active` / `done` / `blocked`) next to an agent row shows whether the agent is currently working.
- If an agent is `blocked`, the Blackboard row also shows the reason for the block.
