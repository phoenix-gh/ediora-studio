import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
  type Route,
} from '@playwright/test'

import {
  allowedHttpFailureReason,
  allowedRequestFailureReason,
  type NetworkRequestDetails,
} from './network-allowlist'

const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const

const THEMES = ['light', 'dark'] as const
const API_BASE = 'http://127.0.0.1:8000/api'
const MEDIA_FIXTURE_PREFIX = '__ediora_e2e_media_fixture__'
const MEDIA_FIXTURE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const LAYOUT_STRESS_CARD_COUNT = 100

type Theme = (typeof THEMES)[number]
type MediaFixture = { id: number; title: string }

let mediaFixture: MediaFixture | null = null

async function deleteStaleMediaFixtures(request: APIRequestContext) {
  const response = await request.get(`${API_BASE}/assets?asset_type=media&q=${encodeURIComponent(MEDIA_FIXTURE_PREFIX)}`)
  expect(response.ok(), `Unable to list stale E2E media fixtures: ${response.status()}`).toBeTruthy()
  const assets = await response.json() as MediaFixture[]
  for (const asset of assets.filter(item => item.title.startsWith(MEDIA_FIXTURE_PREFIX))) {
    const deletion = await request.delete(`${API_BASE}/assets/${asset.id}`)
    expect(deletion.status(), `Unable to delete stale E2E media fixture ${asset.id}`).toBe(204)
  }
}

async function probeAmbientApiMedia(route: Route) {
  const upstream = await route.fetch({
    headers: {
      ...route.request().headers(),
      range: 'bytes=0-0',
    },
  })
  if (upstream.status() >= 400) {
    await route.fulfill({ response: upstream })
    return
  }
  // Chromium intentionally aborts successful preload="metadata" transfers once
  // it has enough bytes. Replace only a proven-successful ambient transfer;
  // upstream 4xx/5xx responses are forwarded and fail the network gate.
  await route.fulfill({
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'x-ediora-e2e-upstream-status': String(upstream.status()),
    },
  })
}

function networkRequestDetails(request: Request): NetworkRequestDetails {
  return {
    failureText: request.failure()?.errorText ?? '',
    isNavigationRequest: request.isNavigationRequest(),
    method: request.method(),
    resourceType: request.resourceType(),
    url: request.url(),
  }
}

test.beforeAll(async ({ request }) => {
  await deleteStaleMediaFixtures(request)
  const title = `${MEDIA_FIXTURE_PREFIX}${Date.now()}-${process.pid}`
  const response = await request.post(`${API_BASE}/assets`, {
    data: {
      asset_type: 'media',
      media_kind: 'image',
      title,
      content: '',
      url: MEDIA_FIXTURE_DATA_URI,
      media_type: 'image/png',
      filename: 'ediora-e2e-fixture.png',
      directory: '',
      tags: ['e2e-fixture'],
    },
  })
  expect(response.status(), 'Unable to create deterministic E2E media fixture').toBe(201)
  mediaFixture = await response.json() as MediaFixture
  expect(mediaFixture.title).toBe(title)
})

test.afterAll(async ({ request }) => {
  if (!mediaFixture) return
  const response = await request.delete(`${API_BASE}/assets/${mediaFixture.id}`)
  expect(response.status(), `Unable to delete E2E media fixture ${mediaFixture.id}`).toBe(204)
})

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
      const consoleErrors: { text: string; url: string }[] = []
      const networkAllowlistReasons = new Set<string>()
      const networkAllowlistedUrls = new Set<string>()
      page.on('console', message => {
        if (message.type() === 'error') {
          consoleErrors.push({ text: message.text(), url: message.location().url })
        }
      })
      page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.message}`))
      page.on('requestfailed', request => {
        const reason = allowedRequestFailureReason(networkRequestDetails(request))
        if (reason) {
          networkAllowlistReasons.add(reason)
          networkAllowlistedUrls.add(request.url())
          return
        }
        runtimeErrors.push(`requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`)
      })
      page.on('response', response => {
        if (response.status() < 400) return
        const reason = allowedHttpFailureReason(networkRequestDetails(response.request()), response.status())
        if (reason) {
          networkAllowlistReasons.add(reason)
          networkAllowlistedUrls.add(response.url())
          return
        }
        runtimeErrors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`)
      })
      await page.route(/^http:\/\/(?:127\.0\.0\.1|localhost):8000\/api\/uploads\//, probeAmbientApiMedia)

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
        if (viewport.width === 1024) {
          const sidebar = page.locator('aside').first()
          const sidebarBox = await sidebar.boundingBox()
          const iconCenters = await sidebar.locator('img, a svg').evaluateAll(elements =>
            elements.map(element => {
              const bounds = element.getBoundingClientRect()
              return bounds.x + bounds.width / 2
            }),
          )
          expect(sidebarBox).not.toBeNull()
          expect(iconCenters.length).toBeGreaterThan(0)
          if (sidebarBox) {
            const sidebarCenter = sidebarBox.x + sidebarBox.width / 2
            for (const iconCenter of iconCenters) {
              expect(Math.abs(iconCenter - sidebarCenter)).toBeLessThanOrEqual(1)
            }
          }
        }

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
          expect(listBox.width).toBeLessThanOrEqual(360)
          expect(editorBox.x).toBeCloseTo(listBox.x + listBox.width, 0)
          expect(editorBox.width).toBeGreaterThan(listBox.width)
          if (viewport.width === 1440) {
            const listRatio = listBox.width / (listBox.width + editorBox.width)
            expect(listRatio).toBeGreaterThanOrEqual(0.25)
            expect(listRatio).toBeLessThanOrEqual(0.30)
          }
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
        await page.waitForLoadState('networkidle')
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
        if (!mediaFixture) throw new Error('Deterministic media fixture was not created')
        const fixtureMedia = mediaGrid.getByRole('button').filter({ hasText: mediaFixture.title })
        await expect(fixtureMedia).toBeVisible()
        await fixtureMedia.dblclick()
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

        await fixtureMedia.evaluate((button, desiredCount) => {
          const grid = button.parentElement
          if (!grid) throw new Error('Fixture media button has no grid parent')
          while (grid.querySelectorAll(':scope > button').length < desiredCount) {
            const clone = button.cloneNode(true) as HTMLButtonElement
            clone.dataset.e2eLayoutClone = 'true'
            clone.setAttribute('aria-hidden', 'true')
            clone.tabIndex = -1
            grid.appendChild(clone)
          }
        }, LAYOUT_STRESS_CARD_COUNT)

        const stressMetrics = await mediaGrid.evaluate(element => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        }))
        expect(stressMetrics.scrollHeight).toBeGreaterThan(stressMetrics.clientHeight)

        const lastStressCard = mediaGrid.locator(':scope > button').last()
        await lastStressCard.scrollIntoViewIfNeeded()
        const [scrolledMetrics, scrolledGridBox, lastStressCardBox] = await Promise.all([
          mediaGrid.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          })),
          mediaGrid.boundingBox(),
          lastStressCard.boundingBox(),
        ])
        expect(scrolledMetrics.scrollTop).toBeGreaterThan(0)
        expect(scrolledGridBox).not.toBeNull()
        expect(lastStressCardBox).not.toBeNull()
        if (scrolledGridBox && lastStressCardBox) {
          expect(lastStressCardBox.y).toBeGreaterThanOrEqual(scrolledGridBox.y)
          expect(lastStressCardBox.y + lastStressCardBox.height).toBeLessThanOrEqual(
            scrolledGridBox.y + scrolledGridBox.height + 1,
          )
        }
        const stressedDocumentWidth = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }))
        expect(stressedDocumentWidth.scrollWidth).toBeLessThanOrEqual(stressedDocumentWidth.clientWidth)
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
        const selectedThemeButton = settingsContent.getByRole('button', { name: theme === 'light' ? '浅色' : '深色', exact: true })
        const oppositeTheme: Theme = theme === 'light' ? 'dark' : 'light'
        const oppositeThemeButton = settingsContent.getByRole('button', { name: oppositeTheme === 'light' ? '浅色' : '深色', exact: true })
        await expect(selectedThemeButton).toHaveAttribute('aria-pressed', 'true')
        await oppositeThemeButton.click()
        await expectTheme(page, oppositeTheme)
        await expect(selectedThemeButton).toHaveAttribute('aria-pressed', 'false')
        await expect(oppositeThemeButton).toHaveAttribute('aria-pressed', 'true')
        expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(oppositeTheme)

        await page.getByRole('link', { name: '今日工作台' }).click()
        await expect(page).toHaveURL(/\/$/)
        await expectTheme(page, oppositeTheme)

        await page.getByRole('link', { name: '设置' }).click()
        await expect(page).toHaveURL(/\/settings$/)
        await page.getByRole('button', { name: /^外观/ }).click()
        await expect(settingsContent.getByRole('button', { name: oppositeTheme === 'light' ? '浅色' : '深色', exact: true })).toHaveAttribute('aria-pressed', 'true')
        expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(oppositeTheme)
      })

      await page.waitForLoadState('networkidle')
      for (const error of consoleErrors) {
        const isAllowlistedResourceFailure = error.text.includes('Failed to load resource')
          && networkAllowlistedUrls.has(error.url)
        if (!isAllowlistedResourceFailure) runtimeErrors.push(`console: ${error.text}`)
      }
      for (const description of networkAllowlistReasons) {
        test.info().annotations.push({ type: 'network-allowlist', description })
      }
      expect(runtimeErrors, runtimeErrors.join('\n')).toEqual([])
    })
  }
}
