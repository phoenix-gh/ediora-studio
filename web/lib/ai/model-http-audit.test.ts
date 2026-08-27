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
        statusText: 'Bearer secret',
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
        statusText: 'Bearer [REDACTED]',
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

  it('redacts sensitive JSON fields before recording a truncated body', async () => {
    const events: ModelHttpAuditEvent[] = []
    const secret = 'secret-before-the-truncation-boundary'
    const oversizedJson = JSON.stringify({
      api_key: secret,
      padding: 'x'.repeat(MODEL_HTTP_AUDIT_BODY_LIMIT),
    })
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response(oversizedJson),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-2b', phase: 'answer', step: 3 }, () => auditedFetch(
      'https://provider.test/v1/responses',
      { method: 'POST', body: oversizedJson },
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.map(event => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ bodyTruncated: true }),
    ]))
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('redacts sensitive query values in relative URLs', async () => {
    const events: ModelHttpAuditEvent[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-relative', phase: 'plan', step: 3 }, () => auditedFetch(
      '/v1/responses?authorization=authorization-secret&cookie=cookie-secret&api_key=api-key-secret',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(JSON.stringify(events[0])).not.toContain('authorization-secret')
    expect(JSON.stringify(events[0])).not.toContain('cookie-secret')
    expect(JSON.stringify(events[0])).not.toContain('api-key-secret')
  })

  it('does not wait for a stalled audit callback before returning the provider response', async () => {
    let providerCalled = false
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => {
        providerCalled = true
        return new Response('ok')
      },
      onEvent: () => new Promise<void>(() => {}),
    })

    const response = await withModelHttpAuditContext(
      { callId: 'call-stalled-audit', phase: 'answer', step: 5 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )

    expect(providerCalled).toBe(true)
    expect(await response.text()).toBe('ok')
  })

  it('does not wait for a stalled Request body capture before returning the provider response', async () => {
    let providerCalled = false
    const stalledRequest = new Request('https://provider.test/v1/responses', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start: () => {},
      }),
      duplex: 'half',
    } as RequestInit)
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => {
        providerCalled = true
        return new Response('ok')
      },
      onEvent: () => {},
    })

    const response = await withModelHttpAuditContext(
      { callId: 'call-stalled-request', phase: 'answer', step: 6 },
      () => auditedFetch(stalledRequest),
    )

    expect(providerCalled).toBe(true)
    expect(await response.text()).toBe('ok')
  })

  it('does not change a provider response when an audit callback rejects', async () => {
    const auditError = new Error('audit unavailable')
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: async () => {
        throw auditError
      },
    })

    const response = await withModelHttpAuditContext(
      { callId: 'call-rejected-audit', phase: 'answer', step: 6 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )

    expect(await response.text()).toBe('ok')
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
