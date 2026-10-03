/**
 * Role-based nav gating: a viewer does not see, and cannot deep-link into, the admin-only
 * surfaces; an admin sees all of them.
 *
 * Needs a dashboard you can log in to, an isolated instance is the safe choice (never the
 * production port), with one admin and one non-admin (viewer) dashboard user:
 *   DASHBOARD_URL=http://localhost:3431 SMOKE_USER=<admin> SMOKE_PASSWORD=<pass> \
 *   SMOKE_VIEWER=<viewer> SMOKE_VIEWER_PASSWORD=<pass> npm run smoke -- rbac-nav-gating
 * Each describe is skipped when its credentials are not set. RBAC_MODE does not matter here:
 * the gating is a UI layer, the server's 403 is separate.
 */
import { test, expect, type Page } from '@playwright/test'

const ADMIN = process.env.SMOKE_USER || ''
const ADMIN_PW = process.env.SMOKE_PASSWORD || ''
const VIEWER = process.env.SMOKE_VIEWER || ''
const VIEWER_PW = process.env.SMOKE_VIEWER_PASSWORD || ''

const GATED_PAGES = ['messages', 'skills', 'ideas', 'artifacts', 'tokenUsage', 'updates', 'settings', 'backups', 'connectors', 'import', 'federation']

async function open(page: Page, user: string, password: string) {
  const login = await page.request.post('/api/auth/login', { data: { username: user, password } })
  expect(login.ok()).toBeTruthy()
  await page.goto('/')
  await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
  // The gating runs once /api/auth/status is in: wait for the first gated link to settle.
  await page.waitForTimeout(1500)
}

const shownPage = (page: Page) => page.$$eval('.page', (ps) => ps.filter((p) => !(p as HTMLElement).hidden).map((p) => p.id))

test.describe('nav gating: viewer', () => {
  test.skip(!VIEWER || !VIEWER_PW, 'SMOKE_VIEWER / SMOKE_VIEWER_PASSWORD not set')

  test('gated links, the once tab and the status block are hidden; the groups they emptied collapse', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await open(page, VIEWER, VIEWER_PW)
    for (const p of GATED_PAGES) {
      await expect(page.locator(`a.sb-link[data-page="${p}"]`), p).toBeHidden()
    }
    for (const p of ['overview', 'kanban', 'agents', 'tasks', 'memories']) {
      await expect(page.locator(`a.sb-link[data-page="${p}"]`), p).toHaveCount(1)
      expect(await page.locator(`a.sb-link[data-page="${p}"]`).getAttribute('hidden'), p).toBeNull()
    }
    await expect(page.locator('#tasksTabNav [data-tab="once"]')).toBeHidden()
    await expect(page.locator('#statusOverall')).toBeHidden()
    await expect(page.locator('.sb-group[data-group="stats"]')).toBeHidden()
    await expect(page.locator('.sb-group[data-group="connections"]')).toBeHidden()
    expect(pageErrors).toEqual([])
  })

  test('a deep link to a gated page lands on the overview, an open page and the #bgTasks alias keep working', async ({ page }) => {
    await open(page, VIEWER, VIEWER_PW)
    for (const hash of ['settings', 'skills', 'federation', 'migrate', 'updates']) {
      await page.goto(`/#${hash}`)
      await page.waitForTimeout(500)
      expect(await shownPage(page), hash).toEqual(['overviewPage'])
    }
    for (const [hash, id] of [['agents', 'agentsPage'], ['memories', 'memoriesPage'], ['bgTasks', 'tasksPage']]) {
      await page.goto(`/#${hash}`)
      await page.waitForTimeout(500)
      expect(await shownPage(page), hash).toEqual([id])
    }
    // #bgTasks lands on the scheduled tab: the "once" panel stays closed.
    await expect(page.locator('#tasks-panel-once')).toBeHidden()
  })
})

test.describe('nav gating: admin', () => {
  test.skip(!ADMIN || !ADMIN_PW, 'SMOKE_USER / SMOKE_PASSWORD not set')

  test('every gated link, the once tab and the status block are visible, deep links work', async ({ page }) => {
    await open(page, ADMIN, ADMIN_PW)
    for (const p of GATED_PAGES) {
      expect(await page.locator(`a.sb-link[data-page="${p}"]`).getAttribute('hidden'), p).toBeNull()
    }
    expect(await page.locator('#tasksTabNav [data-tab="once"]').getAttribute('hidden')).toBeNull()
    expect(await page.locator('#statusOverall').getAttribute('hidden')).toBeNull()
    for (const [hash, id] of [['settings', 'settingsPage'], ['federation', 'federationPage'], ['migrate', 'importPage']]) {
      await page.goto(`/#${hash}`)
      await page.waitForTimeout(500)
      expect(await shownPage(page), hash).toEqual([id])
    }
  })
})
