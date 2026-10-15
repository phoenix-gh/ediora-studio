import { expect, test } from '@playwright/test'

test('clicking and selecting draft content does not mark it dirty, but typing does', async ({ page }) => {
  await page.goto('/drafts')
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  const dirty = page.getByText('有未保存修改', { exact: true })
  await expect(dirty).toHaveCount(0)
  await editor.click()
  // Milkdown publishes serialized Markdown after a 200ms debounce.
  await page.waitForTimeout(500)
  await expect(dirty).toHaveCount(0)
  await editor.press('Control+Home')
  await editor.press('Shift+ArrowRight')
  await page.waitForTimeout(500)
  await expect(dirty).toHaveCount(0)
  await editor.press('ArrowRight')
  await editor.pressSequentially('回归检查')
  await expect(dirty).toBeVisible()
  await editor.press('Control+z')
  await expect(dirty).toHaveCount(0)
})
