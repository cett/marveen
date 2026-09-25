# Approvals

The Approvals view lists requests that agents are waiting on the administrator or owner to act on before proceeding. Agents performing certain operations - such as deleting files, sending external messages, or modifying resources - will only proceed after receiving approval.

---

## Autonomy levels

Each action category has a configured autonomy level:

| Level | Description |
|-------|-------------|
| **1 - Notify only** | The agent notifies the administrator but does not act |
| **2 - Approval required** | The agent waits for a decision before proceeding |
| **3 - Autonomous** | The agent acts and reports afterward |

The Approvals view shows level-2 requests.

---

## Table columns

| Column | Description |
|--------|-------------|
| **Time** | When the request was submitted |
| **Agent** | Which agent sent it |
| **Category** | Type of operation (e.g. `file_write`, `external_message`) |
| **Action** | Short description of what the agent wants to do |
| **Status** | Pending / Approved / Rejected / Timed out |
| **Deadline** | How long the request waits for a decision; after expiry it automatically moves to `Timed out` |
| **Decision** | Approve or Reject button (active only for Pending requests) |

---

## Deciding on a request

1. Find the row with **Pending** status.
2. Read the **Action** column for a short description of the request.
3. If needed, click the row to see the full description.
4. Choose **Approve** or **Reject**.

After the decision, the agent proceeds (if approved) or stops (if rejected).

---

## Filters

- **Status** - All / Pending / Approved / Rejected / Timed out
- **Agent** - filter to a specific agent
- **Category** - filter by operation type

---

## Detail panel

Clicking a row opens the detail panel, which shows:

- The full text description of the request
- The requesting agent's identifier
- Submission time and decision deadline
- The decision and who made it (if already resolved)

---

## Tips

- If a request times out, the agent does not carry out the operation; no separate rejection is needed.
- Urgent requests may also appear on Telegram depending on the autonomy configuration - the dashboard shows the full history.
- Autonomy levels are configured in the Settings view.
