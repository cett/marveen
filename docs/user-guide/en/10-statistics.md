# Statistics

The Statistics view shows real-time token usage and estimated costs for Claude API calls made by agents. Data is available as per-agent summaries, a timeline chart, and a model distribution breakdown.

---

## Period and filters

Two selectors at the top of the view control what data is displayed:

- **Period** - 1h / 24h / 7d / 30d (default: 7d)
- **Agent** - filter to a single agent by clicking a summary card or using the dropdown

The **Collect data** button triggers a manual collection run that reads the latest token statistics from currently running agents; the system also collects automatically at regular intervals.

---

## Summary cards

One card appears per agent in the upper-left area. Each card shows:

- Agent name with its unique color
- Total input tokens (input + cache reads + cache writes)
- Call count and output tokens
- Estimated USD cost
- Session count, tokens per session, and cost per session

Clicking a card filters the entire view to that agent; clicking again clears the filter.

### Pricing reference table

| Model | Input ($/M) | Output ($/M) | Cache-write ($/M) | Cache-read ($/M) |
|-------|-------------|--------------|-------------------|-----------------|
| claude-sonnet-4-x / sonnet-5 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-opus-4-x | $15.00 | $75.00 | $18.75 | $1.50 |
| claude-haiku-4-5 | $0.80 | $4.00 | $1.00 | $0.08 |
| claude-fable-5 | $3.00 | $15.00 | $3.75 | $0.30 |

---

## Claude quota windows

The Claude API enforces token limits using two rolling windows:

| Card | Description |
|------|-------------|
| **5-hour window** | Cumulative input over the last 5-hour session window |
| **Weekly window** | Cumulative input from midnight Monday over the past 7 days |

Clicking a card highlights the corresponding cumulative curve in the timeline chart.

---

## Timeline chart

The chart shows each agent's token usage over time. Controls:

- Click an agent to show only that agent's line in the chart
- Vertical markers in the timeline indicate Claude API rollover points:
  - **5h** - 5-hour window boundary
  - **Day** - midnight daily reset
  - **Week** - Monday midnight weekly reset
- Hover over the chart to see a tooltip with per-agent details at that point

---

## Model distribution

A pie chart and table show which Claude models were used and in what proportion across all API calls during the period. Table columns:

| Column | Description |
|--------|-------------|
| Model | Model identifier |
| Calls | Number of API calls made with that model |
| % | Share of total calls |
| Est. USD | Estimated total cost for that model in the period |

---

## Tool statistics

The tool stats table lists the most frequently called tools during the period, up to 50 rows. MCP tools are grouped by server.

| Column | Description |
|--------|-------------|
| Tool | Tool name (`mcp__server__name` or built-in tool name) |
| Calls | Number of times called in the period |
| Bar | Visual proportion relative to the most-called tool |
| Server | MCP server name, or "built-in" for native tools |
| Est. USD | Estimated cost attributed to calls using this tool |

Enabling the **Agent breakdown** checkbox adds an extra column showing which agents used each tool.

---

## Detailed call log

A searchable, sortable table at the bottom shows individual API calls.

### Filters

- **Min. tokens** - only show calls with more input tokens than this threshold (default: 50,000)
- **Search** - text search within call content (activates after a 400 ms pause)

### Table columns

| Column | Description |
|--------|-------------|
| Time | Call timestamp in local time |
| Agent | Agent identifier with its color |
| Input | Total input tokens (input + cache) |
| Output | Output token count |
| Content | First tool name and a content preview (up to 80 characters) |

Click a column header to sort by that column; click again to reverse the order.

---

## Costops budget status

If the administrator has configured a costops budget, a **Budgets** panel appears at the top of the view (visible to administrators only).

| Field | Description |
|-------|-------------|
| Budget name | The configured budget identifier |
| Spent / Limit | Current token spend against the limit |
| Scope | Global, agent-specific, or tenant-level budget |
| Percentage | How full the limit is |
| Blocked | Whether agent calls are halted because a hard limit was reached |

The status bar is green below the warning threshold, yellow at warning, and red at the hard limit.

---

## Tips

- The cost/session metric on summary cards helps estimate what an average session for a given agent costs.
- The 7-day view is the most common starting point; the 1-hour view is useful for diagnosing an active run.
- Tool statistics highlight when an MCP server generates a disproportionate number of calls, which may be worth optimizing.
