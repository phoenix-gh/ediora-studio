import { describe, expect, it, vi } from 'vitest'

import {
  MODEL_HTTP_AUDIT_BODY_LIMIT,
  createModelHttpAuditFetch,
  sanitizeModelHttpAuditText,
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

  it('removes URL credentials and fragments before auditing an absolute URL', async () => {
    const events: ModelHttpAuditEvent[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-url-credentials', phase: 'plan', step: 4 }, () => auditedFetch(
      'https://username:password@provider.test/v1/responses?api_key=query-secret#access_token=fragment-secret',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0].payload.url).toBe('https://provider.test/v1/responses?api_key=%5BREDACTED%5D')
    expect(JSON.stringify(events[0])).not.toContain('username')
    expect(JSON.stringify(events[0])).not.toContain('password')
    expect(JSON.stringify(events[0])).not.toContain('fragment-secret')
  })

  it('drops userinfo and fragments when an invalid URL uses the sanitization fallback', async () => {
    const events: ModelHttpAuditEvent[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-invalid-url', phase: 'plan', step: 4 }, () => auditedFetch(
      'https://username:password@[invalid-host/v1/responses#fragment-secret',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(JSON.stringify(events[0])).not.toContain('username')
    expect(JSON.stringify(events[0])).not.toContain('password')
    expect(JSON.stringify(events[0])).not.toContain('fragment-secret')
  })

  it('drops userinfo from an invalid protocol-relative URL in the sanitization fallback', async () => {
    const events: ModelHttpAuditEvent[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-invalid-protocol-relative', phase: 'plan', step: 4 }, () => auditedFetch(
      '//username:password@[invalid-host/v1/responses?api_key=query-secret#fragment-secret',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0].payload.url).toBe('//[invalid-host/v1/responses?api_key=[REDACTED]')
    expect(JSON.stringify(events[0])).not.toContain('username')
    expect(JSON.stringify(events[0])).not.toContain('password')
    expect(JSON.stringify(events[0])).not.toContain('query-secret')
    expect(JSON.stringify(events[0])).not.toContain('fragment-secret')
  })

  it('redacts every sensitive alias in malformed URL fallback query pairs', async () => {
    const events: ModelHttpAuditEvent[] = []
    const values = ['credentials-secret', 'client-credentials-secret', 'private-key-secret', 'private-key-camel-secret', 'passphrase-secret', 'api-key-secret']
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-invalid-query-aliases', phase: 'plan', step: 4 }, () => auditedFetch(
      'https://username:password@[invalid-host/v1?credentials=credentials-secret&client_credentials=client-credentials-secret&private_key=private-key-secret&privateKey=private-key-camel-secret&passphrase=passphrase-secret&api_key=api-key-secret&%E0%A4%A=malformed',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    const url = String(events[0].payload.url)
    for (const value of values) {
      expect(url).not.toContain(value)
    }
    expect(url).toContain('credentials=[REDACTED]')
    expect(url).toContain('privateKey=[REDACTED]')
    expect(url).toContain('%E0%A4%A=malformed')
  })

  it('redacts tolerant percent-encoded sensitive aliases in malformed fallback queries', async () => {
    const events: ModelHttpAuditEvent[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-invalid-mixed-percent-query', phase: 'plan', step: 4 }, () => auditedFetch(
      'https://[invalid-host/v1?private%5Fkey%=private-secret&client%5Fcredentials%=client-secret&credential%73%=credentials-secret&unrelated%ZZ=keep',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    const url = String(events[0].payload.url)
    expect(url).not.toContain('private-secret')
    expect(url).not.toContain('client-secret')
    expect(url).not.toContain('credentials-secret')
    expect(url).toContain('private%5Fkey%=[REDACTED]')
    expect(url).toContain('unrelated%ZZ=keep')
  })

  it('omits a truncated nested structured response body instead of persisting a partial prefix', async () => {
    const events: ModelHttpAuditEvent[] = []
    const nestedSecret = 'nested-secret-value'
    const oversizedJson = JSON.stringify({
      credentials: { nested: nestedSecret },
      padding: 'x'.repeat(MODEL_HTTP_AUDIT_BODY_LIMIT),
    })
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response(oversizedJson),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-nested-structured', phase: 'answer', step: 4 }, () => auditedFetch(
      'https://provider.test/v1/responses',
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    const response = events.find(event => event.direction === 'http_response')
    expect(response?.payload).toMatchObject({
      body: '[omitted unsafe structured body]',
      bodyTruncated: true,
    })
    expect(JSON.stringify(response)).not.toContain(nestedSecret)
  })

  it('exports a bounded secret sanitizer for later model diagnostics', () => {
    const result = sanitizeModelHttpAuditText(JSON.stringify({ api_key: 'diagnostic-secret' }), 18)

    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(18)
    expect(result.text).not.toContain('diagnostic-secret')
  })

  it('redacts credential and private-key aliases without redacting benign metrics', () => {
    const secret = 'credential-secret'
    const result = sanitizeModelHttpAuditText(JSON.stringify({
      credentials: secret,
      client_credentials: secret,
      privateKey: secret,
      private_key: secret,
      passphrase: secret,
      credential_count: 3,
    }))

    expect(result.text).not.toContain(secret)
    expect(JSON.parse(result.text)).toMatchObject({
      credentials: '[REDACTED]',
      client_credentials: '[REDACTED]',
      privateKey: '[REDACTED]',
      private_key: '[REDACTED]',
      passphrase: '[REDACTED]',
      credential_count: 3,
    })
  })

  it('structurally sanitizes valid fenced JSON and omits invalid nested fenced JSON', () => {
    const validSecret = 'valid-fenced-secret'
    const valid = sanitizeModelHttpAuditText(`\`\`\`json\n${JSON.stringify({ privateKey: validSecret })}\n\`\`\``)
    const invalidSecret = 'invalid-fenced-secret'
    const invalid = sanitizeModelHttpAuditText(`\`\`\`json\n{"credentials":{"nested":"${invalidSecret}"}\n\`\`\``)

    expect(valid.text).not.toContain(validSecret)
    expect(valid.text).toContain('[REDACTED]')
    expect(invalid.text).toBe('[omitted unsafe structured text]')
    expect(invalid.text).not.toContain(invalidSecret)
  })

  it('bounds oversized structured request bodies before sanitization work', async () => {
    const events: ModelHttpAuditEvent[] = []
    const secret = 'large-request-secret'
    const body = JSON.stringify({ credentials: { nested: secret }, padding: 'x'.repeat(MODEL_HTTP_AUDIT_BODY_LIMIT) })
    let providerCalled = false
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => {
        providerCalled = true
        return new Response('ok')
      },
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-large-request', phase: 'answer', step: 10 }, () => auditedFetch(
      'https://provider.test/v1/responses',
      { method: 'POST', body },
    ))

    expect(providerCalled).toBe(true)
    await vi.waitFor(() => expect(events).toHaveLength(2))
    const request = events.find(event => event.direction === 'http_request')
    expect(request?.payload).toMatchObject({
      body: '[omitted unsafe structured body]',
      bodyTruncated: true,
    })
    expect(JSON.stringify(request)).not.toContain(secret)
  })

  it('bounds URLSearchParams request bodies incrementally without leaking credentials', async () => {
    const events: ModelHttpAuditEvent[] = []
    const params = new URLSearchParams()
    params.set('client_credentials', 'params-secret')
    params.set('padding', 'x'.repeat(MODEL_HTTP_AUDIT_BODY_LIMIT))
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext({ callId: 'call-large-params', phase: 'answer', step: 10 }, () => auditedFetch(
      'https://provider.test/v1/responses',
      { method: 'POST', body: params },
    ))

    await vi.waitFor(() => expect(events).toHaveLength(2))
    const request = events.find(event => event.direction === 'http_request')
    const auditBody = request?.payload.body as string
    expect(request?.payload.bodyTruncated).toBe(true)
    expect(new TextEncoder().encode(auditBody).byteLength).toBeLessThanOrEqual(MODEL_HTTP_AUDIT_BODY_LIMIT)
    expect(auditBody).not.toContain('params-secret')
  })

  it('uses the Request stream marker when init.body is explicitly undefined', async () => {
    const events: ModelHttpAuditEvent[] = []
    const request = new Request('https://provider.test/v1/responses', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({ start: () => {} }),
      duplex: 'half',
    } as RequestInit)
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext(
      { callId: 'call-undefined-init-body', phase: 'answer', step: 11 },
      () => auditedFetch(request, { body: undefined }),
    )

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.find(event => event.direction === 'http_request')?.payload.body).toBe('[unsupported streaming request body]')
  })

  it('emits a response audit event when cloning the response fails', async () => {
    const events: ModelHttpAuditEvent[] = []
    const response = {
      url: 'https://provider.test/v1/responses',
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new ReadableStream<Uint8Array>(),
      clone: () => {
        throw new Error('clone failure private_key=clone-secret')
      },
    } as unknown as Response
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => response,
      onEvent: event => {
        events.push(event)
      },
    })

    expect(await withModelHttpAuditContext(
      { callId: 'call-clone-failure', phase: 'answer', step: 12 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )).toBe(response)

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.find(event => event.direction === 'http_response')?.payload).toMatchObject({
      status: 502,
      body: '[unavailable response body]',
      bodyError: expect.any(String),
    })
    expect(JSON.stringify(events)).not.toContain('clone-secret')
  })

  it('emits a response audit event when the cloned response stream errors', async () => {
    const events: ModelHttpAuditEvent[] = []
    const response = {
      url: 'https://provider.test/v1/responses',
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>(),
      clone: () => ({
        body: new ReadableStream<Uint8Array>({
          start: controller => controller.error(new Error('response credentials=stream-secret')),
        }),
      }),
    } as unknown as Response
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => response,
      onEvent: event => {
        events.push(event)
      },
    })

    await withModelHttpAuditContext(
      { callId: 'call-cloned-stream-error', phase: 'answer', step: 13 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.find(event => event.direction === 'http_response')?.payload).toMatchObject({
      status: 503,
      body: '[unavailable response body]',
      bodyError: expect.any(String),
    })
    expect(JSON.stringify(events)).not.toContain('stream-secret')
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
    const events: ModelHttpAuditEvent[] = []
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
      onEvent: event => {
        events.push(event)
      },
    })

    const response = await withModelHttpAuditContext(
      { callId: 'call-stalled-request', phase: 'answer', step: 6 },
      () => auditedFetch(stalledRequest),
    )

    expect(providerCalled).toBe(true)
    expect(await response.text()).toBe('ok')
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.find(event => event.direction === 'http_request')).toMatchObject({
      callId: 'call-stalled-request',
      payload: { body: '[unsupported streaming request body]' },
    })
  })

  it('registers each detached audit task with the lifecycle registrar', async () => {
    const events: ModelHttpAuditEvent[] = []
    const registeredTasks: Promise<void>[] = []
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: event => {
        events.push(event)
      },
      registerTask: task => {
        registeredTasks.push(task)
      },
    })

    await withModelHttpAuditContext(
      { callId: 'call-registered-tasks', phase: 'answer', step: 7 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(registeredTasks).toHaveLength(2)
    await expect(Promise.all(registeredTasks)).resolves.toEqual([undefined, undefined])
  })

  it('isolates lifecycle registrar failures from the provider result', async () => {
    let registrationAttempts = 0
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => new Response('ok'),
      onEvent: () => {},
      registerTask: () => {
        registrationAttempts += 1
        throw new Error('lifecycle unavailable')
      },
    })

    const response = await withModelHttpAuditContext(
      { callId: 'call-throwing-registrar', phase: 'answer', step: 8 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )

    expect(await response.text()).toBe('ok')
    await vi.waitFor(() => expect(registrationAttempts).toBe(2))
  })

  it('registers request and error audit tasks when the provider fails', async () => {
    const events: ModelHttpAuditEvent[] = []
    const registeredTasks: Promise<void>[] = []
    const providerError = new Error('provider unavailable')
    const auditedFetch = createModelHttpAuditFetch({
      fetch: async () => {
        throw providerError
      },
      onEvent: event => {
        events.push(event)
      },
      registerTask: task => {
        registeredTasks.push(task)
      },
    })

    await expect(withModelHttpAuditContext(
      { callId: 'call-registered-error', phase: 'answer', step: 9 },
      () => auditedFetch('https://provider.test/v1/responses'),
    )).rejects.toBe(providerError)

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(registeredTasks).toHaveLength(2)
    await expect(Promise.all(registeredTasks)).resolves.toEqual([undefined, undefined])
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
