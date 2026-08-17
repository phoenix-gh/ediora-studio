import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { expect, test } from '@playwright/test'

const extensionRoot = resolve(process.cwd(), '../chrome-extension')
const origin = 'http://extension.test'
const viewports = [
  { name: 'narrow', width: 360, height: 800 },
  { name: 'wide', width: 720, height: 800 },
] as const
const longArticle = [
  '# Markdown 文章预览',
  '',
  '正文中的图片应该被插件渲染出来。',
  '',
  '![预览图](/api/uploads/test.png)',
  '',
  ...Array.from(
    { length: 420 },
    (_, index) => `第 ${index + 1} 行：用于验证插件长文章正文可以独立滚动。`,
  ),
].join('\n')
const testPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function harnessHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>述策发布指挥台</title></head>
  <body>
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
            if (message.type === 'SHUCE_DRAFT_IMAGE_REQUEST') {
              return { type: 'SHUCE_DRAFTS_RESULT', requestId: message.requestId, ok: true, dataUrl: 'data:image/png;base64,' + ${JSON.stringify(testPng.toString('base64'))} }
            }
            if (message.type === 'SHUCE_SCHEDULE_GET' || message.type === 'SHUCE_SCHEDULE_SET_AUTOFILL') {
              return { type: 'SHUCE_SCHEDULE_RESULT', requestId: message.requestId, ok: true, selection: null, autoFillEnabled: false, available: false }
            }
            throw new Error('Unexpected extension message: ' + message.type)
          },
          onMessage: { addListener() {}, removeListener() {} },
        },
        storage: {
          local: {
            async get(key) { return { [key]: storage.get(key) } },
            async set(values) { Object.entries(values).forEach(([key, value]) => storage.set(key, value)) },
          },
        },
      }
      window.__workbench = mountWorkbench({ document, window, chromeApi, surface: 'sidepanel' })
    </script>
  </body>
</html>`
}

for (const viewport of viewports) test(`keeps preview actions visible while a long article body scrolls in the side panel at ${viewport.name} width`, async ({ page }) => {
  const consoleProblems: string[] = []
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text())
  })
  page.on('pageerror', error => consoleProblems.push(error.message))

  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await page.route('http://localhost:8000/api/uploads/test.png', async route => {
    await route.fulfill({ contentType: 'image/png', body: testPng })
  })
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/' || url.pathname === '/harness.html') {
      await route.fulfill({
        contentType: 'text/html',
        headers: {
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:",
        },
        body: harnessHtml(),
      })
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
  const panel = page.getByRole('region', { name: '述策发布指挥台' })
  await expect(panel).toBeVisible()
  await expect(page.getByRole('button', { name: /发布指挥台/ })).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: '超长文章布局验证' })).toBeVisible()
  await expect(panel.locator('.sw-markdown-image')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(panel.locator('.sw-markdown-image')).not.toHaveAttribute('data-sw-image-src')
  await expect(panel.getByRole('button', { name: '复制 Markdown' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '发布并下一条' })).toBeVisible()
  await expect(panel.locator('.sw-sidebar')).toBeVisible()
  await expect(panel.locator('.sw-preview')).toBeVisible()

  const body = panel.locator('[data-role="body"]')
  await expect(body).toHaveAttribute('data-layout', 'stack')
  await panel.getByRole('button', { name: '左右布局' }).click()
  await expect(body).toHaveAttribute('data-layout', 'split')
  await expect(panel.getByRole('button', { name: '上下布局' })).toBeVisible()
  await expect(panel.locator('.sw-sidebar')).toBeVisible()
  await expect(panel.locator('.sw-preview')).toBeVisible()
  await expect(panel.locator('.sw-draft-row')).toBeVisible()
  await expect(panel.getByRole('button', { name: '复制 Markdown' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '发布并下一条' })).toBeVisible()

  const preview = panel.locator('.sw-preview')
  const content = panel.locator('.sw-preview-content')
  const footer = panel.locator('.sw-preview-footer')

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
  if (viewport.name === 'wide' && process.env.EXTENSION_LAYOUT_SCREENSHOT) {
    await page.screenshot({ path: process.env.EXTENSION_LAYOUT_SCREENSHOT, fullPage: false })
  }
  expect(consoleProblems).toEqual([])
})
