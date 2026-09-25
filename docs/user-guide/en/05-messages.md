# Messages

The Messages view shows inter-agent communication and agent-owner conversations in a chat-style interface. From here you can send a message to any agent and review past message threads.

---

## Page layout

The page is divided into two sections:

- **Left sidebar** - the agent list with a preview of the last message and its timestamp
- **Right panel** - the message thread for the selected agent and the compose box

---

## Sidebar

The sidebar lists all agents in the following order:

1. The owner's own thread (pinned at the top, labeled "(you)")
2. Active threads, sorted by most recent message
3. Other agents, alphabetically

A blue dot next to an agent's name indicates an unread message.

---

## Message thread

The thread for the selected agent shows messages as chat bubbles:

| Element | Description |
|---------|-------------|
| **Avatar** | Sender's image or monogram |
| **Content** | The message text |
| **Timestamp** | When the agent or owner sent it |
| **Status** | Pending / Delivered / Done / Failed |

Scroll up in the thread to load older messages (pagination).

---

## Trace panel

Below the message thread, a collapsible panel shows the tool-call trace waterfall for a given message. This helps you understand what the agent did while processing the message.

---

## Sending a message

1. Click an agent in the sidebar.
2. Type your message in the text area.
3. Click **Send** or press Ctrl+Enter.

The message is placed in the agent's incoming message queue and appears in its designated session.

---

## Tenant filter

A tenant selector at the top of the view lets you filter messages to a specific tenant's agents.

---

## Federated agents

If the fleet includes federated agents, they also appear in the sidebar (in `peer/agentname` format). Sending messages works the same way as for local agents.

---

## Tips

- A thread is automatically marked as read when you open it; the blue dot disappears.
- The Trace panel is especially useful for long multi-step tasks, where you can see exactly which tools the agent called.
- The message thread is also accessible from the Agents view via the **Conversation** button on each card.
