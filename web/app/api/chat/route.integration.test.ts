import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  after: vi.fn(),
  appendAgentLogEvent: vi.fn(),
  appendAgentSessionEvent: vi.fn(),
  capturedFetch: undefined as typeof fetch | undefined,
  generateText: vi.fn(),
  openAgentRuntime: vi.fn(),
  pending: [] as Promise<unknown>[],
  providerFails: false,
  providerFailureAfter: undefined as number | undefined,
  providerRequestCount: 0,
  responseText: '',
  streamText: vi.fn(),
}))

vi.mock('next/server', async importOriginal => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: api.after,
}))

vi.mock('ai', () => ({
  convertToModelMessages: vi.fn(async messages => messages),
  createUIMessageStream: vi.fn(({ execute }) => {
    const writer = {
      merge: (stream: { run?: () => Promise<void> }) => {
        if (stream.run) api.pending.push(stream.run())
      },
      write: vi.fn(),
    }
    api.pending.push(Promise.resolve(execute({ writer })))
    return { kind: 'test-chat-stream' }
  }),
  createUIMessageStreamResponse: vi.fn(() => new Response('ok')),
  generateText: api.generateText,
  safeValidateUIMessages: vi.fn(async ({ messages }) => ({ success: true, data: messages })),
  stepCountIs: vi.fn(() => undefined),
  streamText: api.streamText,
}))

vi.mock('@/lib/ai/agent-log-client', () => ({
  appendAgentLogEvent: api.appendAgentLogEvent,
  appendAgentSessionEvent: api.appendAgentSessionEvent,
}))

vi.mock('@/lib/ai/agent-runtime', () => ({
  agentSkillRunAudit: vi.fn(() => ({})),
  openAgentRuntime: api.openAgentRuntime,
}))

vi.mock('@/lib/ai/chat-reasoning-model', () => ({
  chatReasoningModel: <T,>(model: T) => model,
}))

vi.mock('@/lib/ai/global-chat-tools', () => ({
  createDirectImageGenerator: vi.fn(() => vi.fn()),
  mcpUrl: vi.fn(() => 'http://mcp.example'),
}))

vi.mock('@/lib/ai/runtime-config', () => ({
  openaiProviderFromConfig: vi.fn((_config, options) => {
    api.capturedFetch = options?.fetch
    const model = {
      doGenerate: () => api.capturedFetch!('https://provider.example/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer provider-secret' },
        body: JSON.stringify({ api_key: 'provider-secret', prompt: 'hello' }),
      }),
      doStream: () => api.capturedFetch!('https://provider.example/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer provider-secret' },
        body: JSON.stringify({ api_key: 'provider-secret', prompt: 'hello' }),
      }),
    }
    return { chat: () => model, responses: () => model }
  }),
  textModelConfigFromSettings: vi.fn(() => ({
    apiKey: 'configured-key',
    baseURL: 'https://provider.example/v1',
    headers: {},
    modelName: 'configured-model',
    protocol: 'openai',
  })),
  textModelForProvider: vi.fn((provider, modelName, protocol) => (
    protocol === 'openai-responses' ? provider.responses(modelName) : provider.chat(modelName)
  )),
}))

vi.mock('@/lib/skills/bindings', () => ({
  resolveSkillBinding: vi.fn(() => ({ displayName: 'Alpha' })),
}))

vi.mock('@/lib/skills/registry', () => ({
  getEnabledSkill: vi.fn(async () => ({ name: 'alpha', instructions: 'Use the Skill.' })),
  listSkillReferences: vi.fn(async () => []),
  loadSkillPreloadContext: vi.fn(async () => ({ references: [] })),
}))

import { withModelHttpAuditContext } from '@/lib/ai/model-http-audit'
import { POST } from './route'

type LoggedEvent = { event_type: string; phase?: string; step_id?: string; payload?: Record<string, unknown> }

function aiSdkError(cause: unknown) {
  return Object.assign(new Error('token=provider-secret model message'), {
    name: 'AI_NoObjectGeneratedError',
    cause,
    text: 'token=provider-secret model text',
    finishReason: 'length',
    usage: { api_key: 'provider-secret', inputTokens: 10, outputTokens: 20 },
    response: {
      credentials: { accessToken: 'provider-secret' },
      url: 'https://provider.example/v1/responses?token=provider-secret',
    },
  })
}

function expectSanitizedModelErrorEvidence(payload: Record<string, unknown> | undefined) {
  expect(payload).toMatchObject({
    name: 'AI_NoObjectGeneratedError',
    message: expect.stringContaining('[REDACTED]'),
    error: expect.stringContaining('[REDACTED]'),
    cause: { name: 'Error', message: expect.stringContaining('[REDACTED]') },
    text: expect.stringContaining('[REDACTED]'),
    finishReason: 'length',
    usage: { api_key: '[REDACTED]', inputTokens: 10, outputTokens: 20 },
    response: {
      credentials: '[REDACTED]',
      url: expect.stringContaining('[REDACTED]'),
    },
  })
  expect(JSON.stringify(payload)).not.toContain('provider-secret')
}

function runtimeFor({ shared }: { shared: boolean }) {
  return async (options: Record<string, unknown>) => ({
    capabilitySnapshot: () => ({}),
    catalogContext: '',
    close: vi.fn(),
    prepare: vi.fn(async () => shared
      ? { skill: { name: 'alpha' }, activation: 'automatic' }
      : undefined),
    run: async () => {
      const onMessage = options.onMessage as (event: Record<string, unknown>) => Promise<void>
      const callId = 'shared-call-1'
      await onMessage({
        callId,
        phase: 'execute',
        step: 1,
        direction: 'model_request',
        occurredAt: '2026-08-27T00:00:00.000Z',
        payload: { prompt: 'hello' },
      })
      await withModelHttpAuditContext({ callId, phase: 'execute', step: 1 }, () => api.capturedFetch!(
        'https://provider.example/v1/chat/completions?api_key=provider-secret',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer provider-secret' },
          body: JSON.stringify({ api_key: 'provider-secret', prompt: 'hello' }),
        },
      ))
      await onMessage({
        callId,
        phase: 'execute',
        step: 1,
        direction: 'model_response',
        occurredAt: '2026-08-27T00:00:01.000Z',
        payload: { text: 'shared answer' },
      })
      return {
        kind: 'completed',
        text: 'shared answer',
        parts: [{ type: 'text', text: 'shared answer' }],
        revisionCount: 0,
      }
    },
    selectedSkill: undefined,
    snapshot: () => ({ source: 'automatic', referenceCount: 0, readReferenceCount: 0 }),
    tools: {},
  })
}

async function flushRouteWork() {
  for (let index = 0; index < 5; index += 1) {
    const pending = api.pending.splice(0)
    if (pending.length === 0) break
    await Promise.all(pending)
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function postChat() {
  const response = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 12,
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    }),
  }) as never)
  await flushRouteWork()
  if (response.status !== 200) throw new Error(await response.text())
  return response
}

function modelEvents() {
  return api.appendAgentLogEvent.mock.calls
    .map(([event]) => event as LoggedEvent)
    .filter(event => event.event_type.startsWith('llm/'))
}

describe('POST /api/chat model HTTP audit integration', () => {
  beforeEach(() => {
    process.env.WORKER_TOKEN = 'test-worker-token-at-least-32-characters'
    process.env.DURABLE_CHAT_RUNS = '0'
    api.after.mockImplementation(callback => callback())
    api.appendAgentLogEvent.mockResolvedValue({})
    api.appendAgentSessionEvent.mockResolvedValue({})
    api.capturedFetch = undefined
    api.generateText.mockImplementation(async ({ model }) => {
      try {
        await model.doGenerate()
      } catch (error) {
        throw aiSdkError(error)
      }
      return { text: 'recovered answer' }
    })
    api.openAgentRuntime.mockImplementation(runtimeFor({ shared: false }))
    api.pending = []
    api.providerFails = false
    api.providerFailureAfter = undefined
    api.providerRequestCount = 0
    api.responseText = ''
    api.streamText.mockImplementation((options: Record<string, unknown>) => {
      const work = (async () => {
        try {
          await (options.prepareStep as (input: { stepNumber: number }) => Promise<unknown>)({ stepNumber: 0 })
          await (options.model as { doStream: () => Promise<Response> }).doStream()
          await (options.onStepFinish as (result: Record<string, unknown>) => Promise<void>)({
            text: api.responseText, toolCalls: [], toolResults: [], finishReason: 'stop', usage: {},
          })
        } catch (error) {
          await (options.onError as (event: { error: unknown }) => Promise<void>)({
            error: aiSdkError(error),
          })
        }
      })()
      return {
        toUIMessageStream: ({ onFinish }: { onFinish: (result: Record<string, unknown>) => Promise<void> }) => ({
          run: async () => {
            await work
            await onFinish({
              responseMessage: {
                parts: api.responseText ? [{ type: 'text', text: api.responseText }] : [],
              },
              isAborted: false,
            })
          },
        }),
      }
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('provider.example')) {
        api.providerRequestCount += 1
        if (api.providerFails || api.providerFailureAfter === api.providerRequestCount) {
          throw new Error('token=provider-secret network failure')
        }
        return new Response(JSON.stringify({ api_key: 'provider-secret', ok: true }), { status: 200 })
      }
      if (url.includes('/settings/ai-runtime')) return new Response(JSON.stringify({}), { status: 200 })
      if (url.includes('/chat/sessions/12') && !url.includes('/messages')) {
        return new Response(JSON.stringify({
          messages: [{ id: 1, role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }))
    delete process.env.GENERIC_SKILL_RUNTIME
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete process.env.GENERIC_SKILL_RUNTIME
    delete process.env.WORKER_TOKEN
  })

  it('correlates shared runtime normalized and sanitized HTTP events when after registration fails', async () => {
    api.after.mockImplementation(() => { throw new Error('after unavailable') })
    api.openAgentRuntime.mockImplementation(runtimeFor({ shared: true }))

    expect((await postChat()).status).toBe(200)

    const events = modelEvents()
    const normalized = events.filter(event => event.event_type === 'llm/request' || event.event_type === 'llm/response')
    const http = events.filter(event => event.event_type === 'llm/http-request' || event.event_type === 'llm/http-response')
    expect(normalized).toHaveLength(2)
    expect(http).toHaveLength(2)
    expect(api.after).toHaveBeenCalled()
    expect(normalized.every(event => event.payload?.callId === 'shared-call-1')).toBe(true)
    expect(http.every(event => event.payload?.callId === 'shared-call-1')).toBe(true)
    expect(http).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'llm/http-request', phase: 'execute', step_id: '1' }),
      expect.objectContaining({ event_type: 'llm/http-response', phase: 'execute', step_id: '1' }),
    ]))
    expect(JSON.stringify(http)).not.toContain('provider-secret')
  })

  it('correlates legacy streaming and distinct final-answer recovery calls', async () => {
    process.env.GENERIC_SKILL_RUNTIME = '0'

    expect((await postChat()).status).toBe(200)

    const events = modelEvents()
    const executeRequest = events.find(event => event.event_type === 'llm/request' && event.phase === 'execute')!
    const executeHttp = events.find(event => event.event_type === 'llm/http-request' && event.phase === 'execute')!
    const finalizeRequest = events.find(event => event.event_type === 'llm/request' && event.phase === 'finalize')!
    const finalizeHttp = events.find(event => event.event_type === 'llm/http-request' && event.phase === 'finalize')!
    expect(executeRequest.payload?.callId).toBeTruthy()
    expect(executeHttp.payload?.callId).toBe(executeRequest.payload?.callId)
    expect(finalizeRequest.payload?.callId).toBeTruthy()
    expect(finalizeHttp.payload?.callId).toBe(finalizeRequest.payload?.callId)
    expect(finalizeRequest.payload?.callId).not.toBe(executeRequest.payload?.callId)
    expect(executeRequest.step_id).toBe('1')
    expect(finalizeRequest.step_id).toBe('2')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'llm/response', phase: 'execute', step_id: '1',
        payload: expect.objectContaining({ callId: executeRequest.payload?.callId }),
      }),
      expect.objectContaining({
        event_type: 'llm/http-response', phase: 'finalize', step_id: '2',
        payload: expect.objectContaining({ callId: finalizeRequest.payload?.callId }),
      }),
    ]))
  })

  it('correlates sanitized legacy provider errors without attempting recovery', async () => {
    process.env.GENERIC_SKILL_RUNTIME = '0'
    api.providerFails = true
    api.responseText = 'keep the existing answer'

    expect((await postChat()).status).toBe(200)

    const events = modelEvents()
    const request = events.find(event => event.event_type === 'llm/request' && event.phase === 'execute')!
    const modelError = events.find(event => event.event_type === 'llm/error' && event.phase === 'execute')!
    const httpError = events.find(event => event.event_type === 'llm/http-error' && event.phase === 'execute')!
    const canonicalTurnEnd = api.appendAgentSessionEvent.mock.calls
      .map(([event]) => event as { type: string; data: { reason?: Record<string, unknown> } })
      .find(event => event.type === 'turn/end' && event.data.reason?.kind === 'error')!
    expect(modelError.step_id).toBe('1')
    expect(httpError.step_id).toBe('1')
    expect(modelError.payload?.callId).toBe(request.payload?.callId)
    expect(httpError.payload?.callId).toBe(request.payload?.callId)
    expectSanitizedModelErrorEvidence(modelError.payload)
    expect(canonicalTurnEnd.data.reason).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('[REDACTED]'),
    })
    expectSanitizedModelErrorEvidence(canonicalTurnEnd.data.reason?.modelError as Record<string, unknown>)
    expect(JSON.stringify(httpError.payload)).not.toContain('provider-secret')
  })

  it('sanitizes normalized final-answer recovery errors', async () => {
    process.env.GENERIC_SKILL_RUNTIME = '0'
    api.providerFailureAfter = 2

    expect((await postChat()).status).toBe(200)

    const recoveryError = modelEvents().find(event => (
      event.event_type === 'llm/error' && event.phase === 'finalize'
    ))!
    expect(recoveryError.payload?.callId).toBeTruthy()
    expectSanitizedModelErrorEvidence(recoveryError.payload)
  })
})
