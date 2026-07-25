import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  nextDigestStep,
  nextResponseStep,
  parseXResponseDecisionText,
  runXResponseDigestJob,
  runXResponseJob,
} from './x-response-job'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('X response worker retryability', () => {
  it('records a permanent immediate notification failure as non-retryable', async () => {
    const job = {
      id: 31,
      flow: 'x_response',
      title: 'response',
      status: 'running',
      input: { tweet_id: 't1' },
      steps: [
        { key: 'qualify', attempt: 1, status: 'succeeded', output: { eligible: true } },
        { key: 'verify_links', attempt: 1, status: 'succeeded', output: { verification_status: 'not_required' } },
        { key: 'decide', attempt: 1, status: 'succeeded', output: { decision: {} } },
        { key: 'persist', attempt: 1, status: 'succeeded', output: { id: 7, notification_tier: 'immediate' } },
      ],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(job))
      .mockResolvedValueOnce(jsonResponse({ id: 41 }))
      .mockResolvedValueOnce(jsonResponse(
        { detail: 'chat not found' },
        503,
        { 'X-WMS-Retryable': 'false' },
      ))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runXResponseJob(31)).rejects.toThrow('chat not found')

    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body)).retryable).toBe(false)
  })

  it('records a definitive digest 429/5xx failure as retryable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 51,
        flow: 'x_response_digest',
        title: 'digest',
        status: 'running',
        input: { date: '2026-07-26' },
        steps: [],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 61 }))
      .mockResolvedValueOnce(jsonResponse(
        { detail: 'Too Many Requests' },
        503,
        { 'X-WMS-Retryable': 'true' },
      ))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runXResponseDigestJob(51)).rejects.toThrow('Too Many Requests')

    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body)).retryable).toBe(true)
  })
})

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}
