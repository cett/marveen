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

### Attention required `[ADMIN]`

When something needs action, an "Attention required" panel appears under the stat cards with the to-dos: pending approvals, undelivered messages, stuck scheduled tasks, agents that are not running. Each row has a link or button to the right view.

Next to **N errors in the last 4 hours**, the **Details** button opens the list of failed runs (the newest 20, newest first): when it happened, what it was (the operation and the scheduled task name, or the HTTP method, route and status) and which agent it belongs to. If there are more errors than that, the number of the rest is shown at the bottom. When the Overview is rebuilt (for example when you return to it from another view or switch tenant), a list you opened stays open.

Two things are not counted as errors: a command-type scheduled task that ends with the `42` "finding" exit code (a check that produced a report, see the Tasks chapter), and a request that arrives with malformed JSON (it gets a 400 answer).

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

- The Blackboard table refreshes automatically every 15 seconds. The rest of the page (counters, the attention panel, recent activity, the quota strip) is loaded when you open the Overview or switch tenant; to see newer numbers, open the page again.
- The Blackboard status (`active` / `done` / `blocked`) next to an agent row shows whether the agent is currently working.
- If an agent is `blocked`, the Blackboard row also shows the reason for the block.
