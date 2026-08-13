import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

const extensionRoot = resolve(process.cwd(), '../chrome-extension')
const origin = 'http://extension.test'
const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow', width: 640, height: 760 },
] as const
const longArticle = Array.from(
  { length: 420 },
  (_, index) => `第 ${index + 1} 行：用于验证插件长文章正文可以独立滚动。`,
).join('\n')

function harnessHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>述策插件布局测试</title></head>
  <body>
    <main><h1>插件测试页面</h1></main>
    <script type="module">
      import { mountWorkbench } from '/content/workbench-runtime.js'

      const draft = ${JSON.stringify({
        id: 901,
        title: '超长文章布局验证',
        content: longArticle,
        status: 'ready',
        draft_type: 'article',
        updated_at: '2026-08-13T00:00:00Z',
      })}
      const chromeApi = {
        runtime: {
          sendMessage: async message => {
            if (message.type === 'SHUCE_DRAFTS_CONFIG_GET') {
              return {
                type: 'SHUCE_DRAFTS_RESULT',
                requestId: message.requestId,
                ok: true,
                apiBase: 'http://localhost:8000/api',
              }
            }
            if (message.type === 'SHUCE_DRAFTS_REQUEST') {
              return {
                type: 'SHUCE_DRAFTS_RESULT',
                requestId: message.requestId,
                ok: true,
                drafts: [draft],
              }
            }
            throw new Error('Unexpected extension message: ' + message.type)
          },
        },
      }

      window.__workbench = mountWorkbench({ document, window, chromeApi })
    </script>
  </body>
</html>`
}

for (const viewport of viewports) test(`keeps preview actions visible while a long article body scrolls at ${viewport.name} width`, async ({ page }) => {
  const consoleProblems: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text())
  })
  page.on('pageerror', error => consoleProblems.push(error.message))

  await page.setViewportSize({ width: viewport.width, height: viewport.height })
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
  await expect(page).toHaveTitle('述策插件布局测试')
  await expect(page.getByRole('heading', { name: '插件测试页面' })).toBeVisible()

  await page.getByRole('button', { name: /发布指挥台/ }).click()
  const panel = page.getByRole('region', { name: '述策发布指挥台' })
  const preview = panel.locator('.sw-preview')
  const content = panel.locator('.sw-preview-content')
  const footer = panel.locator('.sw-preview-footer')

  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: '超长文章布局验证' })).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: '自动填入发布时间' })).toBeVisible()
  await expect(footer.getByRole('button', { name: '复制内容' })).toBeVisible()
  await expect(footer.getByRole('button', { name: '发布并下一条' })).toBeVisible()
  await panel.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
  })

  const metrics = await content.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)

  const previewBox = await preview.boundingBox()
  const footerBoxBefore = await footer.boundingBox()
  expect(previewBox).not.toBeNull()
  expect(footerBoxBefore).not.toBeNull()
  if (!previewBox || !footerBoxBefore) return
  expect(footerBoxBefore.y + footerBoxBefore.height).toBeLessThanOrEqual(
    previewBox.y + previewBox.height,
  )

  await content.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(async () => (await footer.boundingBox())?.y).toBe(footerBoxBefore.y)
  expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  if (viewport.name === 'desktop' && process.env.WMS_EXTENSION_LAYOUT_SCREENSHOT) {
    await page.screenshot({ path: process.env.WMS_EXTENSION_LAYOUT_SCREENSHOT, fullPage: false })
  }
  expect(consoleProblems).toEqual([])
})
