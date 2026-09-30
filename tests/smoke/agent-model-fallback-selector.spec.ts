/**
 * Agent detail: the model selector while a model-fallback overlay is active.
 *
 * The single-agent GET is stubbed to report configured model X with an overlay
 * to Y, so no real downgrade is needed. Needs a dashboard you can log in to (an
 * isolated instance is the safe choice):
 *   DASHBOARD_URL=http://localhost:3421 SMOKE_USER=<user> SMOKE_PASSWORD=<pass> \
 *   SMOKE_AGENT=<name of an existing sub-agent> npm run smoke -- agent-model-fallback-selector
 * Skipped when SMOKE_USER / SMOKE_PASSWORD / SMOKE_AGENT are not set.
 */
import { test, expect } from '@playwright/test'

const USER = process.env.SMOKE_USER || ''
const PASSWORD = process.env.SMOKE_PASSWORD || ''
const AGENT = process.env.SMOKE_AGENT || ''
const X = 'claude-opus-5-5'
const Y = 'claude-sonnet-5'
const OTHER = 'claude-haiku-4-5-20251001'

test.describe('Agent detail: model selector under a fallback', () => {
  test.skip(!USER || !PASSWORD || !AGENT, 'SMOKE_USER / SMOKE_PASSWORD / SMOKE_AGENT not set')

  test('shows X with a fallback marker, an unchanged Save is a no-op, another model goes through', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    const login = await page.request.post('/api/auth/login', { data: { username: USER, password: PASSWORD } })
    expect(login.ok()).toBeTruthy()

    // Stub the single-agent GET: keep the real payload, overlay the model
    // fields the way the API reports them while the agent is downgraded.
    await page.route(new RegExp(`/api/agents/${AGENT}$`), async (route) => {
      const method = route.request().method()
      if (method === 'GET') {
        const real = await route.fetch()
        const body = await real.json()
        return route.fulfill({
          response: real,
          json: { ...body, model: X, activeModel: Y, effectiveModel: Y, fallback: { primary: X, current: Y, downgradedAt: Date.now() } },
        })
      }
      return route.fallback()
    })
    // Never let the test change the instance: PUT / restart are answered here.
    const writes: string[] = []
    await page.route(new RegExp(`/api/agents/${AGENT}(/restart)?$`), async (route) => {
      const method = route.request().method()
      if (method === 'PUT' || method === 'POST') {
        writes.push(`${method} ${new URL(route.request().url()).pathname}`)
        return route.fulfill({ status: 200, json: { ok: true } })
      }
      return route.fallback()
    })

    await page.goto('/')
    await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
    await page.evaluate(() => (document.querySelector('a.sb-link[data-page="agents"]') as HTMLElement).click())
    await page.locator(`.agent-card[data-name="${AGENT}"]`).click()

    // Overview: the running model Y, plus the marker.
    await expect(page.locator('#agentDetailModel')).toHaveText(Y)
    await expect(page.locator('#agentDetailModelFallback')).toBeVisible()
    await expect(page.locator('#agentDetailModelFallback')).toContainText(Y)

    // Settings: the selector holds the configured X, with the hint.
    await page.locator('#agentTabNav .tab-btn[data-tab="settings"]').click()
    await expect(page.locator('#editAgentModel')).toHaveValue(X)
    await expect(page.locator('#agentModelFallbackHint')).toBeVisible()
    await expect(page.locator('#agentModelFallbackHint')).toContainText(Y)

    // Untouched Save: nothing is sent, no restart.
    await page.locator('#saveModelBtn').click()
    await page.waitForTimeout(500)
    expect(writes).toEqual([])

    // A different model is a real change: PUT with that model.
    await page.locator('#editAgentModel').selectOption(OTHER)
    const [put] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/agents/${AGENT}`)),
      page.locator('#saveModelBtn').click(),
    ])
    expect((put.postDataJSON() as { model: string }).model).toBe(OTHER)
    await expect(page.locator('#agentDetailModelFallback')).toBeHidden()

    expect(pageErrors).toEqual([])
  })
})
