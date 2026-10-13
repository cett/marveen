/**
 * Approvals detail of an email request in a real browser: the mail is listed field by field, an
 * agent-written body is text and never markup (nothing runs), the fingerprint, the markers and the
 * event timeline are there, and a long body scrolls inside its own box.
 *
 * The API is mocked in the browser (page.route), so no login and no data are needed; the dashboard only
 * has to serve the static files. Point the run at an isolated instance, not the live one:
 *   DASHBOARD_URL=http://localhost:3431 npm run smoke -- approvals-email-detail
 */
import { test, expect, type Page } from '@playwright/test'

const HASH = 'ab12cd34ef56' + '0'.repeat(52)
const ENVELOPE = {
  v: 1,
  agent: 'main-agent',
  to: ['bob@example.test', 'worker"><img src=x onerror="window.__pwned=1">@example.test'],
  cc: [],
  bcc: ['audit@example.test'],
  subject: 'Quarterly <b>numbers</b>',
  body: '<script>window.__pwned = 2</script><img src=x onerror="window.__pwned=3">\n' + 'a long line of body text\n'.repeat(60),
  attachments: [{ name: '<report>.pdf', size: 2048, sha256: '2'.repeat(64) }],
}
const ROW = {
  id: 'm1', agent_id: 'main-agent', category: 'email_send', status: 'approved', human_only: 1,
  action_description: 'Email from main-agent | to: bob@example.test | subject: "Quarterly <b>numbers</b>" | body (1500 chars): "a long line of body text a long line of body text"',
  action_payload: JSON.stringify(ENVELOPE), content_hash: HASH,
  requested_at: 1_800_000_000, timeout_at: null, resolved_by: 'human:session:person-a', resolved_at: 1_800_000_100,
  resolved_via: 'dashboard_session', consumed_at: 1_800_000_200, consumed_by: 'main-agent', consumed_ref: 'run-1', tenant_id: 'default',
}
const EVENTS = {
  approval_id: 'm1',
  items: [
    { id: 2, approval_id: 'm1', event: 'consumed', reason: 'main-agent', actor: 'main-agent', ref: 'run-1', created_at: 1_800_000_200 },
    { id: 1, approval_id: 'm1', event: 'consume_refused', reason: 'hash_mismatch', actor: 'main-agent', ref: 'run-0', created_at: 1_800_000_150 },
  ],
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function mockApi(page: Page) {
  await page.route('**/api/**', (r) => r.fulfill(json({})))
  await page.route('**/api/auth/status', (r) => r.fulfill(json({ authenticated: true, method: 'session', role: 'admin', tenant_id: null, human_only_enforced: true })))
  await page.route('**/api/approvals?**', (r) => r.fulfill(json({ items: [ROW], total: 1, counts: { pending: 0, approved: 1, rejected: 0, timeout: 0 }, oldest_pending: null })))
  await page.route('**/api/approvals/m1/events', (r) => r.fulfill(json(EVENTS)))
}

test.describe('approvals detail: email request', () => {
  test('lists the mail by field, keeps the agent text inert, and shows the markers and the timeline', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await mockApi(page)
    await page.goto('/')
    await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
    await page.click('a.sb-link[data-page="approvals"]')
    const row = page.locator('#approvalsTbody tr[data-approval-id="m1"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Quarterly')
    await row.click()

    const body = page.locator('#approvalsDetailBody')
    await expect(body).toContainText('bob@example.test')
    await expect(body).toContainText('audit@example.test')
    await expect(body.locator('.approvals-email-body')).toContainText('<script>window.__pwned = 2</script>')
    await expect(body).toContainText('Quarterly <b>numbers</b>')
    await expect(body).toContainText('<report>.pdf')
    await expect(body.locator('code.approvals-hash').first()).toHaveText('ab12cd34ef56')
    await expect(body.locator('.approvals-state-consumed')).toBeVisible()
    await expect(body.locator('.approvals-state-human')).toBeVisible()

    // The timeline is oldest first.
    const events = body.locator('.approvals-event')
    await expect(events).toHaveCount(2)
    await expect(events.nth(0)).toHaveAttribute('data-event', 'consume_refused')
    await expect(events.nth(1)).toHaveAttribute('data-event', 'consumed')

    // Nothing the agent wrote ran or became an element.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    expect(await body.locator('img, script, b').count()).toBe(0)

    // A long body scrolls in its own box, and the box is bounded.
    const box = await body.locator('.approvals-email-body').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
    expect(box.scroll).toBeGreaterThan(box.client)
    expect(box.client).toBeLessThanOrEqual(260)
    expect(pageErrors).toEqual([])
  })
})
