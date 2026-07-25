import { describe, expect, it } from 'vitest'

import { nextDigestStep, nextResponseStep, parseXResponseDecisionText } from './x-response-job'

describe('X response decision contract', () => {
  it('accepts a Chinese quote translation', () => {
    expect(parseXResponseDecisionText(JSON.stringify({
      action: 'translate_quote',
      score: 88,
      confidence: 0.91,
      reason: '官方发布重要 API',
      summary_cn: '官方发布了新的 API',
      comment_draft: null,
      quote_draft: 'OpenAI 发布了新的 Responses API。',
      claims: [],
    })).action).toBe('translate_quote')
  })

  it('rejects an English-only publishable draft', () => {
    expect(() => parseXResponseDecisionText(JSON.stringify({
      action: 'comment',
      score: 80,
      confidence: 0.8,
      reason: '有评论空间',
      summary_cn: '官方发布了新的 API',
      comment_draft: 'This looks useful.',
      quote_draft: null,
      claims: [],
    }))).toThrow(/Chinese/)
  })

  it('rejects a missing primary draft', () => {
    expect(() => parseXResponseDecisionText(JSON.stringify({
      action: 'translate_quote',
      score: 80,
      confidence: 0.8,
      reason: '值得转发',
      summary_cn: '官方发布了新的 API',
      comment_draft: null,
      quote_draft: null,
      claims: [],
    }))).toThrow()
  })
})

describe('resumable X response steps', () => {
  it('continues after the latest succeeded step', () => {
    expect(nextResponseStep([
      { key: 'qualify', attempt: 1, status: 'succeeded', output: { eligible: true } },
      { key: 'verify_links', attempt: 1, status: 'succeeded', output: { verification_status: 'verified' } },
      { key: 'decide', attempt: 1, status: 'failed', output: {} },
      { key: 'decide', attempt: 2, status: 'queued', output: {} },
    ])).toBe('decide')
  })

  it('does not rerun a completed notification', () => {
    expect(nextResponseStep([
      { key: 'qualify', attempt: 1, status: 'succeeded', output: {} },
      { key: 'verify_links', attempt: 1, status: 'succeeded', output: {} },
      { key: 'decide', attempt: 1, status: 'succeeded', output: {} },
      { key: 'persist', attempt: 1, status: 'succeeded', output: {} },
      { key: 'notify', attempt: 1, status: 'succeeded', output: {} },
    ])).toBeNull()
  })

  it('does not resend a completed daily digest', () => {
    expect(nextDigestStep([
      { key: 'notify', attempt: 1, status: 'succeeded', output: { sent: 3 } },
    ])).toBeNull()
  })
})
