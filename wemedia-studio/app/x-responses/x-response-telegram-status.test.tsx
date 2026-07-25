// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { XResponsesClient } from './XResponsesClient'
import type { XResponseDecision } from '@/lib/api/x-responses'

afterEach(cleanup)

function response(
  telegram_status: XResponseDecision['telegram_status'],
): XResponseDecision {
  return {
    id: 7,
    tweet_id: 't1',
    subscription_id: 1,
    source_label: 'OpenAI',
    username: 'OpenAI',
    display_name: 'OpenAI',
    post_content: 'Release',
    post_url: 'https://x.com/OpenAI/status/t1',
    published_at: '2026-07-26T00:00:00Z',
    action: 'comment',
    score: 90,
    confidence: 0.9,
    reason: '官方更新',
    summary_cn: '发布了新功能。',
    comment_draft: '这个更新值得关注。',
    quote_draft: null,
    claims: [],
    verification_status: 'not_required',
    verified_urls: [],
    notification_tier: 'immediate',
    workflow_status: 'ready',
    telegram_status,
    telegram_message_ids: [701],
    telegram_last_error: '网络超时，需人工核对',
    notified_at: null,
    created_at: '2026-07-26T00:00:00Z',
  }
}


describe('Telegram manual inspection status', () => {
  it('renders sending as in progress', () => {
    render(<XResponsesClient initialItems={[response('sending')]} />)

    expect(screen.getByText('Telegram：推送中')).toBeTruthy()
  })

  it('renders unknown delivery with known IDs and safe error', () => {
    render(<XResponsesClient initialItems={[response('unknown')]} />)

    expect(screen.getByText('Telegram：投递状态待确认')).toBeTruthy()
    expect(screen.getByText('已知消息 ID：701')).toBeTruthy()
    expect(screen.getByText('网络超时，需人工核对')).toBeTruthy()
  })
})
