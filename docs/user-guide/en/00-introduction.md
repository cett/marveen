# Introduction

This guide covers the use of the Marveen dashboard. Marveen is the web interface for an AI agent system: from here you can configure agents, track tasks, manage memory, and monitor system operation.

---

## Dashboard layout

The left navigation sidebar contains all views, grouped into six sections:

| Group | Contents |
|-------|----------|
| **Team** | Overview, Agents, Messages, Tasks |
| **Knowledge** | Memories, Skills, Ideas, Workspace Docs |
| **Stats** | Token Usage, Updates |
| **System** | Settings, Backups |
| **Connections** | Connectors, Federation, Import |
| **User** | Profile, User Management `[ADMIN]` |

**Kanban** and **Approvals** appear at the top of the sidebar independently because they are the most frequently used views.

---

## Navigating

- Click any sidebar entry to open that view.
- The current view name also appears in the browser window title.
- Most views refresh automatically; manual reloads are generally not needed.

---

## Language

The language switcher in the top-right corner toggles between the Hungarian and English interface. This guide is available in both languages (in the `hu/` and `en/` directories).

---

## Access levels

Some views and features are only visible to administrators (e.g. Vault, Audit Log, User Management). These are marked `[ADMIN]` throughout this guide.

If a view is not visible in the sidebar, you likely do not have the required permissions. For administrator access, see: [User Management](19-users.md).

---

## Multi-tenant setup

When the system runs with multiple tenants, some views (e.g. Overview, Memories, Kanban) show a tenant selector in the top-right corner. This lets you manage multiple isolated datasets within the same dashboard.
