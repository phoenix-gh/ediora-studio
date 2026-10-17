import { expect, test } from '@playwright/test'

for (const variant of ['page', 'floating'] as const) {
  test(`accepts follow-up instructions and stops an active ${variant} chat`, async ({ page }) => {
    const session = { id: 9001, title: '运行控制测试', created_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:00Z' }
    const controls: string[] = []
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    let created = false
    let stopped = false
    let releaseReply!: () => void
    let streamRequests = 0
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve })
    await page.route('**/_ediora-api/chat/sessions', async route => {
      if (route.request().method() === 'POST') {
        created = true
        await route.fulfill({ json: session })
      } else await route.fulfill({ json: created ? [session] : [] })
    })
    await page.route('**/_ediora-api/chat/sessions/9001', route => route.fulfill({ json: {
      ...session, is_running: !stopped,
      messages: stopped ? [
        { id: 1, role: 'user', text: '开始任务', parts: [{ type: 'text', text: '开始任务' }], created_at: session.created_at },
        { id: 2, role: 'user', text: '改成中文', parts: [{ type: 'text', text: '改成中文' }], created_at: session.created_at },
        { id: 3, role: 'assistant', text: '保留的部分回复', parts: [{ type: 'text', text: '保留的部分回复' }], created_at: session.created_at },
      ] : [],
    } }))
    await page.route('**/api/chat', async route => {
      streamRequests += 1
      await replyGate
      const events = [
        { type: 'text-start', id: 'reply' },
        { type: 'text-delta', id: 'reply', delta: '保留的部分回复' },
        { type: 'text-end', id: 'reply' },
      ]
      await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') })
    })
    await page.route('**/api/chat/9001/control', async route => {
      const { action, text } = route.request().postDataJSON()
      controls.push(action)
      if (action === 'steer') expect(text).toBe('改成中文')
      else { stopped = true; releaseReply() }
      await route.fulfill({ json: { accepted: true } })
    })
    await page.goto(variant === 'page' ? '/chat' : '/')
    if (variant === 'floating') await page.getByTestId('global-chat-trigger').click()
    const editor = page.getByRole('textbox', { name: '消息内容' })
    await editor.fill('开始任务')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
    await expect(editor).toHaveAttribute('contenteditable', 'true')
    await editor.fill('改成中文')
    await page.getByRole('button', { name: '追加指令' }).click()
    await expect(page.locator('article').filter({ hasText: '改成中文' })).toBeVisible()
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    await expect(page.getByText('保留的部分回复', { exact: true })).toBeVisible()
    expect(streamRequests).toBe(1)
    expect(controls).toEqual(['steer', 'interrupt'])
    expect(pageErrors).toEqual([])
  })
}
