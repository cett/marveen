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
| **Deadline** | How long the request waits for a decision; 60 minutes from creation by default, at most 24 hours when the category has no value of its own. After expiry it automatically moves to `Timed out` |
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

## Approving an email

Sending an email is a human-only category (`email_send`): only you, signed in to the dashboard, can approve it. An email approval is not a general permission to send mail. It covers one exact mail and can be used once.

1. **The request.** The main agent asks before it sends. Only the main agent can open an `email_send` request: a sub-agent gets `403`, because a sub-agent's mail goes out through the main agent. The request carries the mail itself (recipients, subject, body, attachment fingerprints).
2. **What you read.** The text in the **Action** column is written by the server from the mail, not by the agent, so it cannot paraphrase the mail in its own favor. It lists, field by field: the sender, the `to`, `cc` and `bcc` recipients (blind copies included, up to 10 per field, with a count of the rest), the subject (up to 120 characters), the start of the body (up to 200 characters, with the total length), the attachments by name, size and the start of their sha256, and the first 12 characters of the mail's fingerprint (its sha256 hash). The complete mail is stored with the request and can be read from `GET /api/approvals/<id>` (`action_payload`). A field-by-field view of it in the dashboard is planned.
3. **Your decision.** Approve or Reject, in a dashboard session. A token, including the main agent's own, cannot decide it while `APPROVAL_HUMAN_ONLY_ENFORCE=1` is on (see the fork guide F02). If the switch is off, a decision made with a token does not count: the approval cannot be used up.
4. **Use within 30 minutes.** After you approve, the agent has 30 minutes to send that mail (`APPROVAL_CONSUME_WINDOW_S`, 1800 seconds by default). Using the approval up and sending the mail are one step on the agent's side; the approval is marked with who used it, when and with which reference.
5. **Once.** The same mail cannot be sent a second time on the same approval. A repeated call with the same reference right after a use (a lost answer, a retry) is recognised and does not burn another approval.
6. **If the window passes.** The row stays `Approved`, but it can no longer be used: the agent has to ask again and you decide again. No message is sent when the window lapses. This is intended: an old approval should not send a mail you no longer remember.
7. **A different mail needs a new approval.** The approval is bound to the exact mail. Change one character of the subject or body, add a recipient or swap an attachment, and the fingerprint is different: the old approval does not apply.

Asking again for a mail whose request is still open does not create a second row and does not send you a second notice. An agent can have 10 open email requests; you get at most 5 new notices per agent and hour, the rest wait on this page.

What this does not do yet: the check that stops the main agent's mail-sending tools until an approval exists (the send gate) is planned and not installed. Until it is, the approval, the fingerprint binding and the single use exist in the API, and a way of sending mail that does not ask for them is not stopped. The security notes in `SECURITY.md` state the limits.

---

## Tips

- If a request times out, the agent does not carry out the operation; no separate rejection is needed. An expired request can no longer be approved or rejected: if the operation is still wanted, the agent has to raise a new request. No Telegram message is sent on expiry, the history shows the `Timed out` status.
- Urgent requests may also appear on Telegram depending on the autonomy configuration - the dashboard shows the full history.
- Autonomy levels are configured in the Settings view.
