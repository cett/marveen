/**
 * Admin B2B page: the starter-pack panel of a tenant.
 *
 * Needs a dashboard you can log in to as a GLOBAL admin, an isolated instance is the safe choice
 * (the test creates the tenant's starter task), with a tenant that has exactly one usable agent
 * (its main agent, or its only enabled agent) and no starter task yet:
 *   DASHBOARD_URL=http://localhost:3421 SMOKE_USER=<admin> SMOKE_PASSWORD=<pass> \
 *   SMOKE_TENANT=<such a tenant id> npm run smoke -- tenant-starter-pack-ui
 * Skipped when SMOKE_USER / SMOKE_PASSWORD / SMOKE_TENANT are not set.
 *
 * A second test covers a tenant-bound user (no starter control anywhere in the DOM):
 *   SMOKE_TENANT_USER=<user bound to a tenant> SMOKE_TENANT_PASSWORD=<pass>
 */
import { test, expect } from '@playwright/test'

const USER = process.env.SMOKE_USER || ''
const PASSWORD = process.env.SMOKE_PASSWORD || ''
const TENANT = process.env.SMOKE_TENANT || ''
const TENANT_USER = process.env.SMOKE_TENANT_USER || ''
const TENANT_PASSWORD = process.env.SMOKE_TENANT_PASSWORD || ''

async function openAdminPage(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
  await page.evaluate(() => (document.querySelector('a.sb-link[data-page="adminB2b"]') as HTMLElement | null)?.click())
}

test.describe('Admin B2B: starter pack panel', () => {
  test.use({ actionTimeout: 8_000 })
  test.skip(!USER || !PASSWORD || !TENANT, 'SMOKE_USER / SMOKE_PASSWORD / SMOKE_TENANT not set')

  test('global admin: the button is on every tenant row but the default one, the panel creates the task, a second press changes nothing', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    const login = await page.request.post('/api/auth/login', { data: { username: USER, password: PASSWORD } })
    expect(login.ok()).toBeTruthy()

    await openAdminPage(page)
    const row = (id: string) => page.locator(`#tenantList [data-tenant-id="${id}"]`)
    await expect(row(TENANT)).toBeVisible()
    await expect(row(TENANT).locator('[data-action="show-starter"]')).toHaveCount(1)
    await expect(row('default').locator('[data-action="show-starter"]')).toHaveCount(0)

    const panel = page.locator('#starterPackContainer')
    await expect(panel).toBeHidden()
    const [state] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/admin/tenants/${TENANT}/starter-pack`) && r.request().method() === 'GET'),
      row(TENANT).locator('[data-action="show-starter"]').click(),
    ])
    expect(state.ok()).toBeTruthy()
    await expect(panel).toBeVisible()
    await expect(page.locator('#starterPackStatus .admin-b2b-starter-state')).toHaveAttribute('data-state', 'absent')
    // One usable agent: the server picks it, so no picker is offered.
    await expect(page.locator('#starterPackAgent')).toBeHidden()

    const create = page.locator('#starterPackBtn')
    const [first] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/admin/tenants/${TENANT}/starter-pack`)),
      create.click(),
    ])
    expect(first.postDataJSON()).toEqual({})
    expect((await first.response())?.status()).toBe(201)
    await expect(page.locator('#starterPackStatus .admin-b2b-starter-state')).toHaveAttribute('data-state', 'ok')
    // Created draft and disabled: the panel says so.
    await expect(page.locator('#starterPackStatus')).toContainText('draft')
    await expect(page.locator('#starterPackStatus .admin-b2b-starter-hint').first()).toBeVisible()

    const [second] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/admin/tenants/${TENANT}/starter-pack`)),
      create.click(),
    ])
    expect((await second.response())?.status()).toBe(200)
    expect(pageErrors).toEqual([])
  })
})

test.describe('Admin B2B: starter pack panel is absent for a tenant user', () => {
  test.skip(!TENANT_USER || !TENANT_PASSWORD, 'SMOKE_TENANT_USER / SMOKE_TENANT_PASSWORD not set')

  test('no starter control in the DOM, and the admin API refuses the call', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { username: TENANT_USER, password: TENANT_PASSWORD } })
    expect(login.ok()).toBeTruthy()
    await page.goto('/')
    await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
    await expect(page.locator('[data-action="show-starter"]')).toHaveCount(0)
    await expect(page.locator('#starterPackContainer')).toBeHidden()
    await expect(page.locator('#navAdminB2b')).toBeHidden()
    const res = await page.request.get(`/api/admin/tenants/${TENANT || 'x'}/starter-pack`)
    expect(res.status()).toBe(403)
  })
})
