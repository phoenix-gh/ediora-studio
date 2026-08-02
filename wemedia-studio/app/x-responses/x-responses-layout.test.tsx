import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


const inbox = readFileSync(new URL('./XResponsesClient.tsx', import.meta.url), 'utf8')
const xSubscriptions = readFileSync(new URL('../x/XClient.tsx', import.meta.url), 'utf8')
const xSubscriptionRow = readFileSync(new URL('../x/XSubscriptionRow.tsx', import.meta.url), 'utf8')
const xSettings = readFileSync(new URL('../settings/sections/XSection.tsx', import.meta.url), 'utf8')
const telegramSettings = readFileSync(new URL('../settings/sections/TelegramSettingsCard.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../components/features/Sidebar.tsx', import.meta.url), 'utf8')
const xResponseApi = readFileSync(new URL('../../lib/api/x-responses.ts', import.meta.url), 'utf8')


describe('X realtime response UI', () => {
  it('shows decision evidence and the surviving manual actions', () => {
    expect(inbox).toContain('评分')
    expect(inbox).toContain('置信度')
    expect(inbox).toContain('核验')
    expect(inbox).toContain('Telegram')
    expect(inbox).toContain('复制')
    expect(inbox).toContain('查看原帖')
    expect(inbox).toContain('已采用')
    expect(inbox).toContain('忽略')
    expect(inbox).not.toContain('转为选题')
    expect(inbox).not.toContain('convertXResponseToTopic')
  })

  it('uses realtime response wording and hides it for search subscriptions', () => {
    expect(xSubscriptionRow).toContain('即时响应')
    expect(xSubscriptionRow).toContain("subscription.kind === 'timeline'")
    expect(xSubscriptions).not.toContain('动态通知')
  })

  it('keeps the Telegram token write-only and exposes target account selection', () => {
    expect(xSettings).toContain('<TelegramSettingsCard settings={settings} onSaved={onSaved} />')
    expect(telegramSettings).toContain('Telegram Bot Token')
    expect(telegramSettings).toContain('telegram_bot_token_set')
    expect(xSettings).toContain('x_response_account_id')
    expect(telegramSettings).not.toContain('settings?.telegram_bot_token ??')
    expect(xSettings).not.toContain('telegram_bot_token:')
    expect(xSettings).not.toContain('telegram_chat_id:')
  })

  it('adds the pending response destination to global navigation', () => {
    expect(sidebar).toContain("href: '/responses'")
    expect(sidebar).toContain("label: '待响应'")
    expect(sidebar).not.toContain('/trend-topics')
    expect(sidebar).not.toContain('热点选题')
  })

  it('removes the converted workflow contract', () => {
    expect(xResponseApi).not.toContain('convert-to-topic')
    expect(xResponseApi).not.toContain("'converted'")
  })
})
