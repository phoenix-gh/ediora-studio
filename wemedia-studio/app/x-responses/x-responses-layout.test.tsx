import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


const legacyPage = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const xSubscriptions = readFileSync(new URL('../x/XClient.tsx', import.meta.url), 'utf8')
const xSubscriptionRow = readFileSync(new URL('../x/XSubscriptionRow.tsx', import.meta.url), 'utf8')
const xSettings = readFileSync(new URL('../settings/sections/XSection.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../components/features/Sidebar.tsx', import.meta.url), 'utf8')


describe('情报分析 subscription integration', () => {
  it('keeps old X response links as a redirect to the unified station', () => {
    expect(legacyPage).toContain("redirect('/responses?source_type=x_post')")
  })

  it('uses the intelligence-analysis wording for both subscription kinds', () => {
    expect(xSubscriptionRow).toContain('intelligence_enabled')
    expect(xSubscriptionRow).toContain('开启情报分析')
    expect(xSubscriptionRow).not.toContain('即时响应')
    expect(xSubscriptions).toContain('intelligence_enabled')
    expect(xSubscriptions).not.toContain('notify_new_posts')
  })

  it('keeps X settings focused on collection and the intelligence station in navigation', () => {
    expect(xSettings).toContain('已有订阅可在订阅管理中单独设置')
    expect(xSettings).not.toContain('即时响应')
    expect(sidebar).toContain("href: '/responses'")
    expect(sidebar).toContain("label: '情报中心'")
    expect(sidebar).not.toContain("label: '待响应'")
  })
})
