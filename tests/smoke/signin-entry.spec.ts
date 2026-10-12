/**
 * Sign in entry smoke: a browser on a token offers the password login, and once it holds a login
 * session an enrollment link does not replace that session with a token.
 *
 * Prerequisites: a running dashboard (point the run at an isolated instance, not the live one), an
 * admin API token, and a dashboard login the spec may sign in with:
 *   DASHBOARD_TOKEN=<admin API token> DASHBOARD_TEST_USER=<user> DASHBOARD_TEST_PASSWORD=<password> \
 *     npx playwright test tests/smoke/signin-entry.spec.ts
 * Without the login the spec is skipped. It mints one `browser <date> <tag>` token on the instance.
 */

import { test, expect, type APIRequestContext } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''
const USER = process.env.DASHBOARD_TEST_USER || ''
const PASSWORD = process.env.DASHBOARD_TEST_PASSWORD || ''
const KEY = 'marveen-dashboard-token'

async function issueCode(request: APIRequestContext): Promise<string> {
  const r = await request.post('/api/admin/browser-enroll-codes', { headers: { Authorization: `Bearer ${TOKEN}` } })
  expect(r.status()).toBe(201)
  return (await r.json()).code as string
}

test.describe('Sign in entry', () => {
  test.skip(!USER || !PASSWORD, 'DASHBOARD_TEST_USER / DASHBOARD_TEST_PASSWORD not set')

  test('shows on a token, goes after login, and an enroll link keeps the session', async ({ page, request }) => {
    // The first-run wizard of a fresh instance covers the sidebar and blocks clicks; it is not under test.
    // Removed after each load, like the other smoke specs (the wizard sets `hidden` as well as `active`,
    // so toggling a class is not enough).
    const dismissWizard = () => page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())

    // 1. An enrollment link makes the browser a token holder, and the entry offers the login.
    await page.goto(`/?enroll=${await issueCode(request)}`)
    await dismissWizard()
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY)).toBeTruthy()
    await expect(page.locator('#navSignIn')).toBeVisible()

    // 2. The entry opens the login; after it the token is gone and the session answers.
    await dismissWizard()
    await page.click('#navSignIn')
    await page.fill('#mv-login-user', USER)
    await page.fill('#mv-login-pass', PASSWORD)
    await Promise.all([page.waitForNavigation(), page.click('#mv-login-submit')])
    await expect(page.locator('.sb-link[data-page]').first()).toBeVisible()
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()
    expect((await page.evaluate(async () => (await fetch('/api/auth/status')).json())).method).toBe('session')
    await expect(page.locator('#navSignIn')).toBeHidden()

    // 3. An enrollment link in this signed-in browser is not traded: no exchange, still the session.
    let exchanges = 0
    await page.route('**/api/auth/enroll-browser', (route) => { exchanges++; route.continue() })
    await page.goto(`/?enroll=${await issueCode(request)}`)
    await dismissWizard()
    await expect(page.locator('.sb-link[data-page]').first()).toBeVisible()
    await page.waitForTimeout(1000)
    expect(exchanges).toBe(0)
    expect(page.url()).not.toContain('enroll=')
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull()
    expect((await page.evaluate(async () => (await fetch('/api/auth/status')).json())).method).toBe('session')
  })
})
