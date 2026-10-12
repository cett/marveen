/**
 * Browser enrollment smoke: a one-time ?enroll= code is traded for the browser's own token.
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be an admin API token
 * (the same variable the other smoke specs use).
 *   DASHBOARD_TOKEN=<an admin API token> npx playwright test tests/smoke/browser-enroll.spec.ts
 *
 * The specs mint a few `browser <date> <tag>` tokens on the instance they run against.
 */

import { test, expect, type APIRequestContext } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''
const KEY = 'marveen-dashboard-token'

async function issueCode(request: APIRequestContext): Promise<string> {
  const r = await request.post('/api/admin/browser-enroll-codes', { headers: { Authorization: `Bearer ${TOKEN}` } })
  expect(r.status()).toBe(201)
  return (await r.json()).code as string
}

test.describe('Browser enrollment', () => {
  test('?enroll= becomes the browser own token and leaves the address bar', async ({ page, request }) => {
    const code = await issueCode(request)
    await page.goto(`/?enroll=${code}`)

    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY)).toBeTruthy()
    const own = (await page.evaluate((k) => localStorage.getItem(k), KEY)) as string
    expect(own).not.toBe(TOKEN)
    expect(page.url()).not.toContain('enroll=')

    // The page works on that token: the sidebar renders, and the status probe knows the caller.
    await expect(page.locator('.sb-link[data-page]').first()).toBeVisible()
    const status = await page.evaluate(async () => (await fetch('/api/auth/status')).json())
    expect(status.authenticated).toBe(true)

    // The code is spent: a replay is refused.
    const replay = await request.post('/api/auth/enroll-browser', { data: { code } })
    expect(replay.status()).toBe(401)
  })

  test('a spent code leaves a token the browser already holds alone', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(TOKEN)

    await page.goto('/?enroll=not-a-code')
    await expect(page.locator('.sb-link[data-page]').first()).toBeVisible()
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(TOKEN)
    expect(page.url()).not.toContain('enroll=')
  })
})
