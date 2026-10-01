/**
 * Schedules page: tenant field, tenant badge and tenant move in the task dialog.
 *
 * Needs a dashboard you can log in to as a GLOBAL admin (an isolated instance is the safe
 * choice, this test creates and deletes a schedule) with a second enabled tenant:
 *   DASHBOARD_URL=http://localhost:3421 SMOKE_USER=<admin> SMOKE_PASSWORD=<pass> \
 *   SMOKE_TENANT=<id of a second enabled tenant> [SMOKE_TENANT_AGENT=<agent serving it>] \
 *   npm run smoke -- schedules-tenant-dialog
 * With SMOKE_TENANT_AGENT the test also moves the task to that tenant and checks it lands as a draft.
 * Skipped when SMOKE_USER / SMOKE_PASSWORD / SMOKE_TENANT are not set.
 *
 * A second test covers a tenant-bound user (no tenant filter, field or badge):
 *   SMOKE_TENANT_USER=<user bound to a tenant> SMOKE_TENANT_PASSWORD=<pass>
 */
import { test, expect } from '@playwright/test'

const USER = process.env.SMOKE_USER || ''
const PASSWORD = process.env.SMOKE_PASSWORD || ''
const TENANT = process.env.SMOKE_TENANT || ''
const TENANT_AGENT = process.env.SMOKE_TENANT_AGENT || ''

test.describe('Schedules: tenant field in the task dialog', () => {
  // A stuck step should fail on its own line, not eat the whole test budget.
  test.use({ actionTimeout: 8_000 })
  test.skip(!USER || !PASSWORD || !TENANT, 'SMOKE_USER / SMOKE_PASSWORD / SMOKE_TENANT not set')

  test('global admin sees the tenant field, the agent list follows it, a new task is filed under the picked tenant', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    const name = `smoke-tenant-${Date.now()}`

    const login = await page.request.post('/api/auth/login', { data: { username: USER, password: PASSWORD } })
    expect(login.ok()).toBeTruthy()

    try {
      await page.goto('/')
      await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
      await page.evaluate(() => (document.querySelector('a.sb-link[data-page="tasks"]') as HTMLElement).click())

      // The list filter has no fleet-only scope any more.
      const filter = page.locator('#schedulesTenantSelectorContainer-sel')
      await expect(filter).toBeVisible()
      await expect(filter.locator('option[value="fleet"]')).toHaveCount(0)

      // New dialog: tenant field visible, default tenant preselected.
      await page.locator('#addScheduleBtn').click()
      const tenantSel = page.locator('#scheduleTenant')
      await expect(tenantSel).toBeVisible()
      await expect(tenantSel).toHaveValue('default')
      await expect(tenantSel.locator(`option[value="${TENANT}"]`)).toHaveCount(1)

      // Switching tenant narrows the agent list to what /api/schedules/agents?tenant= returns.
      const [agentsRes] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(`/api/schedules/agents?tenant=${encodeURIComponent(TENANT)}`)),
        tenantSel.selectOption(TENANT),
      ])
      const served = ((await agentsRes.json()) as Array<{ name: string }>).map((a) => a.name)
      await expect(page.locator('#scheduleAgent option')).toHaveCount(served.length)
      if (TENANT_AGENT) expect(served).toContain(TENANT_AGENT)

      // Create under the default tenant (always has a valid agent) and check what is sent and stored.
      await tenantSel.selectOption('default')
      await page.locator('#scheduleName').fill(name)
      await page.locator('#schedulePrompt').fill('smoke: do nothing')
      const [post] = await Promise.all([
        page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/schedules')),
        page.locator('#saveScheduleBtn').click(),
      ])
      expect(post.postDataJSON()).toMatchObject({ name, tenant_id: 'default' })
      expect((await post.response())?.status()).toBe(200)

      const listed = async () => {
        const rows = (await (await page.request.get('/api/schedules')).json()) as Array<Record<string, unknown>>
        return rows.find((r) => r.name === name)!
      }
      expect((await listed()).tenantId).toBe('default')

      // The row carries a tenant badge; opening it shows the stored tenant, and an untouched save sends no tenant_id.
      const row = page.locator('.schedule-row', { hasText: name }).first()
      await expect(row.locator('.badge[title^="Tenant"]')).toBeVisible()
      await row.click()
      // The edit dialog fills asynchronously (tenants, agents) and opens last: wait for it.
      await expect(page.locator('#scheduleName')).toHaveValue(name)
      await expect(tenantSel).toHaveValue('default')
      await expect(page.locator('#scheduleTenantHint')).toBeHidden()
      const [put] = await Promise.all([
        page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(`/api/schedules/${name}`)),
        page.locator('#saveScheduleBtn').click(),
      ])
      expect('tenant_id' in (put.postDataJSON() as object)).toBe(false)
      expect((await put.response())?.status()).toBe(200)
      // Let the saved dialog finish closing before opening the next one.
      await expect(page.locator('#scheduleModalOverlay')).toBeHidden()

      // Picking another tenant on an edit warns that it is a move.
      await row.click()
      await expect(page.locator('#scheduleName')).toHaveValue(name)
      await expect(page.locator('#scheduleName')).toBeVisible()
      await tenantSel.selectOption(TENANT)
      await expect(page.locator('#scheduleTenantHint')).toBeVisible()

      if (TENANT_AGENT) {
        await page.locator('#scheduleAgent').selectOption(TENANT_AGENT)
        const [move] = await Promise.all([
          page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(`/api/schedules/${name}`)),
          page.locator('#saveScheduleBtn').click(),
        ])
        expect(move.postDataJSON()).toMatchObject({ tenant_id: TENANT, agent: TENANT_AGENT })
        expect((await move.response())?.status()).toBe(200)
        const moved = await listed()
        expect(moved.tenantId).toBe(TENANT)
        expect(moved.status).toBe('draft')
      }
    } finally {
      await page.request.delete(`/api/schedules/${name}`)
    }

    expect(pageErrors).toEqual([])
  })
})

const TENANT_USER = process.env.SMOKE_TENANT_USER || ''
const TENANT_PASSWORD = process.env.SMOKE_TENANT_PASSWORD || ''

test.describe('Schedules: tenant-bound user', () => {
  test.skip(!TENANT_USER || !TENANT_PASSWORD, 'SMOKE_TENANT_USER / SMOKE_TENANT_PASSWORD not set')
  test.use({ actionTimeout: 8_000 })

  test('sees no tenant filter, no tenant field and no tenant badge', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    const login = await page.request.post('/api/auth/login', { data: { username: TENANT_USER, password: TENANT_PASSWORD } })
    expect(login.ok()).toBeTruthy()

    await page.goto('/')
    await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
    const [listRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/schedules') && r.request().method() === 'GET'),
      page.evaluate(() => (document.querySelector('a.sb-link[data-page="tasks"]') as HTMLElement).click()),
    ])
    expect(listRes.ok()).toBeTruthy()
    await expect(page.locator('#schedulesTenantSelectorContainer-sel')).toHaveCount(0)
    await expect(page.locator('#scheduleTenantGroup')).toBeHidden()
    await expect(page.locator('.schedule-row .badge[title^="Tenant"]')).toHaveCount(0)

    expect(pageErrors).toEqual([])
  })
})
