import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


const inbox = readFileSync(new URL('./XResponsesClient.tsx', import.meta.url), 'utf8')
const xSubscriptions = readFileSync(new URL('../x/XClient.tsx', import.meta.url), 'utf8')
const xSettings = readFileSync(new URL('../settings/sections/XSection.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../components/features/Sidebar.tsx', import.meta.url), 'utf8')


describe('X realtime response UI', () => {
  it('shows the decision evidence and all manual actions', () => {
    expect(inbox).toContain('评分')
    expect(inbox).toContain('置信度')
    expect(inbox).toContain('核验')
    expect(inbox).toContain('Telegram')
    expect(inbox).toContain('复制')
    expect(inbox).toContain('查看原帖')
    expect(inbox).toContain('已采用')
    expect(inbox).toContain('忽略')
    expect(inbox).toContain('转为选题')
  })

  it('uses realtime response wording and hides it for search subscriptions', () => {
    expect(xSubscriptions).toContain('即时响应')
    expect(xSubscriptions).toContain("s.kind === 'timeline'")
    expect(xSubscriptions).not.toContain('动态通知')
  })

  it('keeps the Telegram token write-only and exposes target account selection', () => {
    expect(xSettings).toContain('Telegram Bot Token')
    expect(xSettings).toContain('telegram_bot_token_set')
    expect(xSettings).toContain('x_response_account_id')
    expect(xSettings).not.toContain('settings?.telegram_bot_token ??')
  })

  it('adds the pending response destination to global navigation', () => {
    expect(sidebar).toContain("href: '/x-responses'")
    expect(sidebar).toContain("label: '待响应'")
  })
})
