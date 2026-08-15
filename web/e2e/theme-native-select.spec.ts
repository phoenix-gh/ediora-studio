import { expect, test } from '@playwright/test'

test('native select menus follow the selected color scheme', async ({ page }) => {
  await page.goto('/creation-rules')
  await page.getByRole('button', { name: '新建规则' }).click()
  const selects = page.getByRole('dialog').locator('select')
  await expect(selects).toHaveCount(2)

  await page.evaluate(() => {
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
    document.documentElement.style.removeProperty('color-scheme')
  })
  await expect.poll(() => selects.evaluateAll(elements => elements.map(element => getComputedStyle(element).colorScheme))).toEqual([
    'dark',
    'dark',
  ])

  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  })
  await expect.poll(() => selects.evaluateAll(elements => elements.map(element => getComputedStyle(element).colorScheme))).toEqual([
    'light',
    'light',
  ])
})
