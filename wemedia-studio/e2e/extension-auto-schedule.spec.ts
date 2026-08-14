import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

const extensionRoot = resolve(process.cwd(), '../chrome-extension')
const origin = 'http://extension-auto-schedule.test'
const previousSelection = {
  year: '2026',
  month: '8',
  day: '13',
  hour: '10',
  minute: '47',
}

function harnessHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>述策自动安排测试</title></head>
  <body>
    <main><h1>插件测试页面</h1></main>
    <script type="module">
      import { startScheduleHost } from '/content/schedule-host.js'
      import { mountWorkbench } from '/content/workbench-runtime.js'

      Math.random = () => 0.45
      const previous = ${JSON.stringify(previousSelection)}
      if (!localStorage.getItem('x_schedule_last_selection_v3')) {
        localStorage.setItem('x_schedule_last_selection_v3', JSON.stringify(previous))
      }

      const draft = {
        id: 902,
        title: '自动安排测试草稿',
        content: '测试正文',
        status: 'ready',
        draft_type: 'article',
        updated_at: '2026-08-13T00:00:00Z',
      }
      const listeners = new Set()
      const storage = new Map()
      const chromeApi = {
        runtime: {
          sendMessage: async message => {
            if (message.type === 'SHUCE_DRAFTS_CONFIG_GET') {
              return { type: 'SHUCE_DRAFTS_RESULT', requestId: message.requestId, ok: true, apiBase: 'http://localhost:8000/api' }
            }
            if (message.type === 'SHUCE_DRAFTS_REQUEST') {
              return { type: 'SHUCE_DRAFTS_RESULT', requestId: message.requestId, ok: true, drafts: [draft] }
            }
            let response
            for (const listener of [...listeners]) {
              listener(message, {}, value => { response = value })
            }
            if (message.type === 'SHUCE_SCHEDULE_GET' || message.type === 'SHUCE_SCHEDULE_SET_AUTOFILL') {
              return response ?? {
                type: 'SHUCE_SCHEDULE_RESULT',
                requestId: message.requestId,
                ok: true,
                selection: null,
                autoFillEnabled: false,
                available: false,
              }
            }
            if (message.type === 'SHUCE_SCHEDULE_CHANGED') return
            throw new Error('Unexpected extension message: ' + message.type)
          },
          onMessage: {
            addListener(listener) { listeners.add(listener) },
            removeListener(listener) { listeners.delete(listener) },
          },
        },
        storage: {
          local: {
            async get(key) { return { [key]: storage.get(key) } },
            async set(values) { Object.entries(values).forEach(([key, value]) => storage.set(key, value)) },
          },
        },
      }

      window.__host = startScheduleHost({ document, window, chromeApi })
      window.__workbench = mountWorkbench({ document, window, chromeApi, surface: 'sidepanel' })
      window.__addScheduleDialog = () => {
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        dialog.style.position = 'fixed'
        dialog.style.zIndex = '10000'
        dialog.style.right = '16px'
        dialog.style.bottom = '16px'
        dialog.style.padding = '12px'
        dialog.style.background = '#fff'
        dialog.style.color = '#111'
        const createSelect = (name, values, value) => {
          const select = document.createElement('select')
          select.name = name
          for (const optionValue of values) {
            const option = document.createElement('option')
            option.value = String(optionValue)
            option.textContent = String(optionValue)
            select.appendChild(option)
          }
          select.value = String(value)
          dialog.appendChild(select)
          return select
        }
        const selects = {
          month: createSelect('month', [1, 8], 8),
          day: createSelect('day', [1, 13], 13),
          year: createSelect('year', [2026, 2027], 2026),
          hour: createSelect('hour', [10, 11], 10),
          minute: createSelect('minute', [0, 7, 47], 47),
        }
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.setAttribute('data-testid', 'scheduledConfirmationPrimaryAction')
        confirm.textContent = '确定'
        dialog.appendChild(confirm)
        document.body.appendChild(dialog)
        return selects
      }
    </script>
  </body>
</html>`
}

test('persists the auto-fill switch and fills the next X schedule time', async ({ page }) => {
  const consoleProblems: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text())
  })
  page.on('pageerror', error => consoleProblems.push(error.message))

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/' || url.pathname === '/harness.html') {
      await route.fulfill({ contentType: 'text/html', body: harnessHtml() })
      return
    }

    const filePath = resolve(extensionRoot, `.${url.pathname}`)
    if (!filePath.startsWith(`${extensionRoot}${sep}`)) {
      await route.fulfill({ status: 403, body: 'Forbidden' })
      return
    }
    await route.fulfill({
      contentType: extname(filePath) === '.js' ? 'text/javascript' : 'text/plain',
      body: await readFile(filePath),
    })
  })

  await page.goto(`${origin}/harness.html`)
  await expect(page).toHaveTitle('述策自动安排测试')
  await expect(page.getByRole('button', { name: /发布指挥台/ })).toHaveCount(0)
  const panel = page.getByRole('region', { name: '述策发布指挥台' })
  await expect(panel).toBeVisible()
  const autoFill = panel.getByRole('checkbox', { name: '自动填入发布时间' })
  await expect(autoFill).toBeVisible()
  await expect(autoFill).not.toBeChecked()

  await autoFill.check()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('x_schedule_auto_fill_enabled_v1'))).toBe('true')

  await page.reload()
  const reloadedPanel = page.getByRole('region', { name: '述策发布指挥台' })
  await expect(reloadedPanel).toBeVisible()
  await expect(reloadedPanel.getByRole('checkbox', { name: '自动填入发布时间' })).toBeChecked()

  await page.evaluate(() => (window as Window & { __addScheduleDialog: () => unknown }).__addScheduleDialog())
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect.poll(async () => dialog.locator('select[name="hour"]').inputValue()).toBe('11')
  await expect.poll(async () => dialog.locator('select[name="minute"]').inputValue()).toBe('7')
  expect(await page.evaluate(() => localStorage.getItem('x_schedule_last_selection_v3'))).toBe(JSON.stringify(previousSelection))
  if (process.env.WMS_AUTO_SCHEDULE_SCREENSHOT) {
    await page.screenshot({ path: process.env.WMS_AUTO_SCHEDULE_SCREENSHOT, fullPage: false })
  }

  await dialog.getByRole('button', { name: '确定' }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('x_schedule_last_selection_v3') || 'null'))).toEqual({
    year: '2026', month: '8', day: '13', hour: '11', minute: '7',
  })
  expect(consoleProblems).toEqual([])
})
