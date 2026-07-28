import { expect, test, type Locator, type Page } from '@playwright/test'

const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const

const THEMES = ['light', 'dark'] as const

type Theme = (typeof THEMES)[number]

async function openCenteredDialog(page: Page, trigger: Locator) {
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  const bounds = await dialog.boundingBox()
  const viewport = page.viewportSize()
  expect(bounds).not.toBeNull()
  expect(viewport).not.toBeNull()
  if (!bounds || !viewport) return

  expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2)
  expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2)
  await expect(page.locator('[data-slot="dialog-overlay"]')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}

async function assertPageFoundation(page: Page, expectedPath: string, identity: Locator) {
  await expect(page).toHaveURL(new RegExp(`${expectedPath === '/' ? '/$' : `${expectedPath}$`}`))
  await expect(page).toHaveTitle(/Ediora/)
  await expect(identity).toBeVisible()
  await expect(page.locator('main')).toHaveCount(1)
  await expect(page.locator('main[data-slot="app-content"]')).toHaveCount(1)
  await expect(page.locator('nextjs-portal, [data-nextjs-error-overlay]')).toBeHidden()

  const documentWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(documentWidth.scrollWidth).toBeLessThanOrEqual(documentWidth.clientWidth)
}

async function waitForStableScreenshot(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('html')).not.toHaveClass(/system/)
}

async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator('html')).toHaveClass(new RegExp(`(^|\\s)${theme}(\\s|$)`))
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return ['--primary', '--data', '--ai'].map(token => style.getPropertyValue(token).trim())
  })
  expect(new Set(colors).size).toBe(3)
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`${viewport.width}x${viewport.height} ${theme} foundations`, async ({ page }) => {
      const runtimeErrors: string[] = []
      page.on('console', message => {
        if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
      })
      page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.message}`))

      await page.setViewportSize(viewport)
      await page.addInitScript(selectedTheme => {
        localStorage.setItem('theme', selectedTheme)
      }, theme)

      await test.step('dashboard foundation and dialog', async () => {
        await page.goto('/')
        await assertPageFoundation(page, '/', page.getByRole('heading', { name: '今日工作台' }))
        await expectTheme(page, theme)

        const sidebarWidth = await page.locator('aside').first().evaluate(element => element.getBoundingClientRect().width)
        expect(sidebarWidth).toBe(viewport.width === 1024 ? 72 : 224)

        await waitForStableScreenshot(page)
        await page.screenshot({
          animations: 'disabled',
          caret: 'hide',
          path: `test-results/ui-foundations/dashboard-${viewport.width}x${viewport.height}-${theme}.png`,
        })

        await openCenteredDialog(page, page.getByRole('button', { name: '发布创作任务' }))
      })

      await test.step('assets list/editor and media preview dialog', async () => {
        await page.goto('/assets')
        await assertPageFoundation(page, '/assets', page.getByRole('heading', { name: '创作资产' }))
        await expectTheme(page, theme)

        const list = page.getByRole('region', { name: '素材列表' })
        const editor = page.getByRole('region', { name: '素材编辑器' })
        await expect(list).toBeVisible()
        await expect(editor).toBeVisible()
        const [listBox, editorBox] = await Promise.all([list.boundingBox(), editor.boundingBox()])
        expect(listBox).not.toBeNull()
        expect(editorBox).not.toBeNull()
        if (listBox && editorBox) {
          expect(listBox.width).toBeGreaterThanOrEqual(280)
          expect(editorBox.x).toBeCloseTo(listBox.x + listBox.width, 0)
          expect(editorBox.width).toBeGreaterThan(listBox.width)
        }

        await waitForStableScreenshot(page)
        await page.screenshot({
          animations: 'disabled',
          caret: 'hide',
          path: `test-results/ui-foundations/assets-${viewport.width}x${viewport.height}-${theme}.png`,
        })

        await page.getByRole('tab', { name: '多媒体' }).click()
        const mediaGrid = page.locator('[data-slot="media-asset-grid"]')
        await expect(mediaGrid).toBeVisible()
        const mediaGridStyle = await mediaGrid.evaluate(element => {
          const style = getComputedStyle(element)
          return { gridAutoRows: style.gridAutoRows, overflowY: style.overflowY }
        })
        expect(mediaGridStyle.overflowY).toBe('auto')
        expect(mediaGridStyle.gridAutoRows).toBe('max-content')
        const [mediaGridBox, appContentBox] = await Promise.all([
          mediaGrid.boundingBox(),
          page.locator('main[data-slot="app-content"]').boundingBox(),
        ])
        expect(mediaGridBox).not.toBeNull()
        expect(appContentBox).not.toBeNull()
        if (mediaGridBox && appContentBox) {
          expect(mediaGridBox.y + mediaGridBox.height).toBeLessThanOrEqual(appContentBox.y + appContentBox.height + 1)
        }
        const mediaItems = mediaGrid.locator(':scope > button')
        const mediaCount = await mediaItems.count()
        if (mediaCount === 0) {
          test.info().annotations.push({
            type: 'skip',
            description: 'Media preview skipped because the live API returned no media assets.',
          })
        } else {
          await mediaItems.first().dblclick()
          const preview = page.getByRole('dialog')
          await expect(preview).toContainText('双击多媒体资产打开预览。')
          const previewBounds = await preview.boundingBox()
          const currentViewport = page.viewportSize()
          expect(previewBounds).not.toBeNull()
          expect(currentViewport).not.toBeNull()
          if (previewBounds && currentViewport) {
            expect(Math.abs(previewBounds.x + previewBounds.width / 2 - currentViewport.width / 2)).toBeLessThanOrEqual(2)
            expect(Math.abs(previewBounds.y + previewBounds.height / 2 - currentViewport.height / 2)).toBeLessThanOrEqual(2)
          }
          await page.keyboard.press('Escape')
          await expect(preview).toBeHidden()
        }
      })

      await test.step('settings dialog and theme persistence', async () => {
        await page.goto('/settings')
        await assertPageFoundation(page, '/settings', page.getByRole('navigation', { name: '设置导航' }))
        await expectTheme(page, theme)

        const settingsNav = page.getByRole('navigation', { name: '设置导航' })
        const settingsContent = page.getByTestId('settings-content')
        await expect(settingsNav).toBeVisible()
        await expect(settingsContent).toBeVisible()
        expect(await settingsNav.evaluate(element => element.getBoundingClientRect().width)).toBe(240)
        expect(await settingsContent.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(760)

        await waitForStableScreenshot(page)
        await page.screenshot({
          animations: 'disabled',
          caret: 'hide',
          path: `test-results/ui-foundations/settings-${viewport.width}x${viewport.height}-${theme}.png`,
        })

        await page.getByRole('button', { name: /^发布账号/ }).click()
        await openCenteredDialog(page, page.getByRole('button', { name: '新增发布账号' }))

        await page.getByRole('button', { name: /^外观/ }).click()
        const themeButton = settingsContent.getByRole('button', { name: theme === 'light' ? '浅色' : '深色', exact: true })
        await expect(themeButton).toHaveAttribute('aria-pressed', 'true')

        await page.getByRole('link', { name: '今日工作台' }).click()
        await expect(page).toHaveURL(/\/$/)
        await expectTheme(page, theme)

        await page.getByRole('link', { name: '设置' }).click()
        await expect(page).toHaveURL(/\/settings$/)
        await page.getByRole('button', { name: /^外观/ }).click()
        await expect(settingsContent.getByRole('button', { name: theme === 'light' ? '浅色' : '深色', exact: true })).toHaveAttribute('aria-pressed', 'true')
        expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(theme)
      })

      expect(runtimeErrors, runtimeErrors.join('\n')).toEqual([])
    })
  }
}
