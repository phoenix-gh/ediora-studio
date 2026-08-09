import { expect, test, type Route } from '@playwright/test'

const onceRule = {
  id: 9,
  name: '一次任务',
  prompt: '在指定时间检查一次发布状态。',
  asset_type: 'article',
  directory: '', directories: [],
  output_type: 'x_short_post', target_count: 1,
  execution_mode: 'once', scheduled_date: '2026-08-12',
  scheduled_time: '09:00', timezone: 'Asia/Shanghai',
  lookback_days: 7, delivery_mode: 'drafts',
  account_id: null, instructions: '',
  skill_mode: 'auto', skill_name: null, enabled: true,
  last_run_at: null, next_run_at: '2026-08-12T01:00:00Z',
  created_at: '2026-08-09T00:00:00Z',
  updated_at: '2026-08-09T00:00:00Z',
}

const dashboard = {
  date: '2026-08-09',
  summary: {
    enabled_rules: 1, scheduled_runs: 1,
    queued: 0, running: 0, succeeded: 0,
    partial: 0, failed: 1, cancelled: 0,
    next_run_at: onceRule.next_run_at,
  },
  rules: [onceRule],
  runs: [],
  scheduler_logs: [],
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

test('edits a one-time Agent task into a recurring task without legacy metrics', async ({ page }) => {
  let saved: Record<string, unknown> | undefined
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/creation-rules/dashboard') {
      return json(route, dashboard)
    }
    if (url.pathname === '/api/assets/directories') return json(route, [])
    if (url.pathname === '/api/chat/skills') return json(route, [])
    if (url.pathname === '/api/jobs') {
      return json(route, { jobs: [], next_cursor: null, has_more: false })
    }
    if (url.pathname === '/api/creation-rules/9' && request.method() === 'PATCH') {
      saved = request.postDataJSON() as Record<string, unknown>
      return json(route, { ...onceRule, ...saved })
    }
    return json(route, { detail: `Unhandled test route: ${request.method()} ${url.pathname}` }, 404)
  })

  await page.goto('/creation-rules')
  await expect(page.getByRole('heading', { name: '任务看板' })).toBeVisible()
  await expect(page.getByText('今日运行')).toBeVisible()
  await expect(page.getByText('部分完成 / 已取消')).toBeVisible()
  await expect(page.getByText('今日计划')).toHaveCount(0)
  await expect(page.getByText('今日产出')).toHaveCount(0)
  await expect(page.getByText(/共计划|目标 \d+ 条/)).toHaveCount(0)

  await page.getByRole('button', { name: '编辑' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('执行日期')).toHaveValue('2026-08-12')
  await dialog.getByLabel('执行方式').selectOption('recurring')
  await expect(dialog.getByLabel('执行日期')).toHaveCount(0)
  await dialog.getByLabel('时区').fill('Asia/Tokyo')
  await dialog.getByRole('button', { name: '保存规则' }).click()

  await expect.poll(() => saved).toMatchObject({
    execution_mode: 'recurring',
    scheduled_date: null,
    timezone: 'Asia/Tokyo',
  })
})
