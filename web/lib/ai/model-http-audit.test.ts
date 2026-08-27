import { describe, expect, it, vi } from 'vitest'

import {
  MODEL_HTTP_AUDIT_BODY_LIMIT,
  createModelHttpAuditFetch,
  type ModelHttpAuditEvent,
  withModelHttpAuditContext,
} from './model-http-audit'

describe('model HTTP audit', () => {
  it('correlates sanitized request and response events with the active model call', async () => {
    const events: ModelHttpAuditEvent[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'secret',
        },
      }),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-1', phase: 'plan', step: 2 }, () => auditedFetch(
      'https://provider.test/v1/chat/completions?api_key=secret',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'test',
          api_key: 'secret',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events.map(event => event.direction)).toEqual(['http_request', 'http_response'])
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(events[0]).toMatchObject({
      callId: 'call-1',
      phase: 'plan',
      step: 2,
      direction: 'http_request',
      payload: {
        url: 'https://provider.test/v1/chat/completions?api_key=%5BREDACTED%5D',
        method: 'POST',
        headers: { authorization: '[REDACTED]' },
      },
    })
    expect(events[1]).toMatchObject({
      callId: 'call-1',
      phase: 'plan',
      step: 2,
      direction: 'http_response',
      payload: {
        status: 200,
        statusText: '',
        headers: { 'content-type': 'application/json' },
      },
    })
  })

  it('bounds captured bodies and records truncation', async () => {
    const events: ModelHttpAuditEvent[] = []
    const oversizedBody = 'x'.repeat(MODEL_HTTP_AUDIT_BODY_LIMIT + 1)
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response(oversizedBody, {
        headers: { 'content-type': 'text/plain' },
      }),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-2', phase: 'answer', step: 3 }, () => auditedFetch(
      'https://provider.test/v1/responses',
      { method: 'POST', body: oversizedBody },
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        direction: 'http_request',
        payload: expect.objectContaining({
          bodyTruncated: true,
          body: expect.any(String),
        }),
      }),
      expect.objectContaining({
        direction: 'http_response',
        payload: expect.objectContaining({
          bodyTruncated: true,
          body: expect.any(String),
        }),
      }),
    ]))
    expect(events.every(event => (event.payload.body as string | undefined)?.length === MODEL_HTTP_AUDIT_BODY_LIMIT)).toBe(true)
  })

  it('records network errors without changing the provider failure', async () => {
    const events: ModelHttpAuditEvent[] = []
    const providerError = new Error('provider unavailable')
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => {
        throw providerError
      },
      onEvent: event => {
        events.push(event)
      },
    })

    await expect(withModelHttpAuditContext(
      { callId: 'call-3', phase: 'answer', step: 4 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )).rejects.toBe(providerError)

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toMatchObject({
      callId: 'call-3',
      phase: 'answer',
      step: 4,
      direction: 'http_error',
      payload: { url: 'https://provider.test/v1/responses', error: 'provider unavailable' },
    })
  })
})
