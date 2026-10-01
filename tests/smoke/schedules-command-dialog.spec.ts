/**
 * Schedules page: the task dialog handles command-type tasks.
 *
 * Needs a dashboard you can log in to (an isolated instance is the safe choice,
 * this test edits a schedule):
 *   DASHBOARD_URL=http://localhost:3421 SMOKE_USER=<user> SMOKE_PASSWORD=<pass> \
 *   SMOKE_COMMAND_TASK=<name of an existing type=command schedule> npm run smoke -- schedules-command-dialog
 * Skipped when SMOKE_USER / SMOKE_PASSWORD / SMOKE_COMMAND_TASK are not set.
 */
import { test, expect } from '@playwright/test'

const USER = process.env.SMOKE_USER || ''
const PASSWORD = process.env.SMOKE_PASSWORD || ''
const TASK = process.env.SMOKE_COMMAND_TASK || ''

test.describe('Schedules: command task dialog', () => {
  test.skip(!USER || !PASSWORD || !TASK, 'SMOKE_USER / SMOKE_PASSWORD / SMOKE_COMMAND_TASK not set')

  test('opens a command task as a command, saves it unchanged, creates a command task without a prompt', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    const login = await page.request.post('/api/auth/login', { data: { username: USER, password: PASSWORD } })
    expect(login.ok()).toBeTruthy()

    await page.goto('/')
    await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
    await page.evaluate(() => (document.querySelector('a.sb-link[data-page="tasks"]') as HTMLElement).click())

    const listed = async () => {
      const res = await page.request.get('/api/schedules')
      const rows = (await res.json()) as Array<Record<string, unknown>>
      return rows.find((r) => r.name === TASK)!
    }
    const before = await listed()
    expect(before.type).toBe('command')

    // Edit dialog: shown as a command task, prompt hidden, fields filled from the row.
    // Rows are titled by description (name only when there is none).
    await page.locator('.schedule-row', { hasText: String(before.description || TASK) }).first().click()
    await expect(page.locator('#scheduleType')).toHaveValue('command')
    await expect(page.locator('#scheduleType')).toBeDisabled()
    await expect(page.locator('#scheduleCommandGroup')).toBeVisible()
    await expect(page.locator('#schedulePromptGroup')).toBeHidden()
    await expect(page.locator('#scheduleCommand')).toHaveValue(String(before.command))
    await expect(page.locator('#scheduleTimeoutMs')).toHaveValue(String(before.timeoutMs))
    await expect(page.locator('#scheduleFailThreshold')).toHaveValue(String(before.failThreshold))

    // Save untouched: no prompt in the payload, the stored row is identical afterwards.
    const [put] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(`/api/schedules/${TASK}`)),
      page.locator('#saveScheduleBtn').click(),
    ])
    const sent = put.postDataJSON() as Record<string, unknown>
    expect(sent.type).toBe('command')
    expect('prompt' in sent).toBe(false)
    expect((await put.response())?.status()).toBe(200)
    expect(await listed()).toEqual(before)

    // New dialog: choosing Command swaps the prompt for the command block; a command task saves without a prompt.
    await page.locator('#addScheduleBtn').click()
    await page.locator('#scheduleType').selectOption('command')
    await expect(page.locator('#scheduleCommandGroup')).toBeVisible()
    await expect(page.locator('#schedulePromptGroup')).toBeHidden()
    const name = `smoke-cmd-${Date.now()}`
    await page.locator('#scheduleName').fill(name)
    await page.locator('#scheduleCommand').fill('echo smoke')
    const [post] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/schedules')),
      page.locator('#saveScheduleBtn').click(),
    ])
    const created = post.postDataJSON() as Record<string, unknown>
    expect(created).toMatchObject({ name, type: 'command', command: 'echo smoke' })
    expect('prompt' in created).toBe(false)
    expect((await post.response())?.status()).toBe(200)

    expect(pageErrors).toEqual([])
  })
})
