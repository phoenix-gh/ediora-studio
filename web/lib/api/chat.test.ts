import { afterEach, describe, expect, it, vi } from 'vitest'

import { consumeUIMessageStream, createChatPipeline, createChatSession, deleteChatSession, listChatDrafts, listChatSkills, listPipelineParameterOptions, renameChatSession, streamChatReply } from './chat'

describe('chat API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the requested title when creating a session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 8,
      title: 'AI 趋势研究',
      created_at: '2026-07-23T00:00:00Z',
      updated_at: '2026-07-23T00:00:00Z',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await createChatSession('AI 趋势研究')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/chat/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'AI 趋势研究' }),
      }),
    )
  })

  it('deletes a persisted session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await deleteChatSession(8)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/chat/sessions/8',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('renames a persisted session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 8,
      title: '新的会话名称',
      created_at: '2026-07-23T00:00:00Z',
      updated_at: '2026-07-23T00:00:00Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await renameChatSession(8, '新的会话名称')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/chat/sessions/8',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: '新的会话名称' }) }),
    )
  })

  it('loads selectable skills locally and drafts from the Python API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: 'baoyu-cover-image', description: 'cover', version: '1.0.0' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 5, title: '草稿', status: 'draft', updated_at: '2026-07-23T00:00:00Z' }]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listChatSkills()).resolves.toEqual([{ name: 'baoyu-cover-image', description: 'cover', version: '1.0.0' }])
    await expect(listChatDrafts()).resolves.toEqual([{ id: 5, title: '草稿', status: 'draft', updated_at: '2026-07-23T00:00:00Z' }])

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/chat/skills', { cache: 'no-store' })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8000/api/write/drafts', expect.objectContaining({
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    }))
  })

  it('serializes selected context identifiers without sending their content', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await streamChatReply({
      sessionId: 7,
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '请参考草稿' }] }],
      skillName: 'baoyu-cover-image',
      draftId: 12,
      skillInvocation: {
        invocationId: 'one',
        skillName: 'article-drafting',
        skillDisplayName: '客户端文章写作',
        parameterKind: 'writing_plan',
        parameterId: '12',
        parameterDisplayName: '客户端方案名',
      },
      messageParts: [
        { type: 'text', text: '请参考草稿' },
        {
          type: 'skill-invocation', invocationId: 'one',
          skillName: 'article-drafting', skillDisplayName: '客户端文章写作',
          parameterKind: 'writing_plan', parameterId: '12',
          parameterDisplayName: '客户端方案名',
        },
      ],
      onEvent: () => undefined,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sessionId: 7,
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '请参考草稿' }] }],
        skillName: 'baoyu-cover-image',
        draftId: 12,
        skillInvocation: {
          invocationId: 'one',
          skillName: 'article-drafting',
          skillDisplayName: '客户端文章写作',
          parameterKind: 'writing_plan',
          parameterId: '12',
          parameterDisplayName: '客户端方案名',
        },
        messageParts: [
          { type: 'text', text: '请参考草稿' },
          {
            type: 'skill-invocation', invocationId: 'one',
            skillName: 'article-drafting', skillDisplayName: '客户端文章写作',
            parameterKind: 'writing_plan', parameterId: '12',
            parameterDisplayName: '客户端方案名',
          },
        ],
      }),
    }))
  })

  it('sends a tool approval decision without a new user message', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await streamChatReply({
      sessionId: 7,
      messages: [],
      approval: { messageId: 15, toolCallId: 'call-1', approvalId: 'approval-1', approved: true },
      onEvent: () => undefined,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.objectContaining({
      body: JSON.stringify({
        sessionId: 7,
        messages: [],
        approval: { messageId: 15, toolCallId: 'call-1', approvalId: 'approval-1', approved: true },
      }),
    }))
  })

  it('submits ordered structured Skill invocations through the same-origin pipeline route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { id: 81 } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await createChatPipeline(7, {
      clientMessageId: 'message-1',
      objective: '写一篇文章',
      title: '文章任务',
      invocations: [
        { invocationId: 'one', skillName: 'article-drafting', skillDisplayName: '文章写作' },
        { invocationId: 'two', skillName: 'article-drafting', skillDisplayName: '文章写作', parameterKind: 'writing_plan', parameterId: '12', parameterDisplayName: 'AI 方案' },
      ],
      messageParts: [
        { type: 'text', text: '写一篇文章' },
        { type: 'skill-invocation', invocationId: 'one', skillName: 'article-drafting', skillDisplayName: '文章写作' },
        { type: 'skill-invocation', invocationId: 'two', skillName: 'article-drafting', skillDisplayName: '文章写作', parameterKind: 'writing_plan', parameterId: '12', parameterDisplayName: 'AI 方案' },
      ],
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/7/pipelines', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        clientMessageId: 'message-1',
        objective: '写一篇文章',
        title: '文章任务',
        invocations: [
          { invocationId: 'one', skillName: 'article-drafting', skillDisplayName: '文章写作' },
          { invocationId: 'two', skillName: 'article-drafting', skillDisplayName: '文章写作', parameterKind: 'writing_plan', parameterId: '12', parameterDisplayName: 'AI 方案' },
        ],
        messageParts: [
          { type: 'text', text: '写一篇文章' },
          { type: 'skill-invocation', invocationId: 'one', skillName: 'article-drafting', skillDisplayName: '文章写作' },
          { type: 'skill-invocation', invocationId: 'two', skillName: 'article-drafting', skillDisplayName: '文章写作', parameterKind: 'writing_plan', parameterId: '12', parameterDisplayName: 'AI 方案' },
        ],
      }),
    }))
  })

  it('loads parameter options through the same-origin resolver route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ options: [{ id: '12', displayName: 'AI 方案', kind: 'writing_plan', summary: '策略', metadata: {} }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listPipelineParameterOptions('writing_plan', 'AI')).resolves.toEqual({
      options: [{ id: '12', displayName: 'AI 方案', kind: 'writing_plan', summary: '策略', metadata: {} }],
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/pipeline-options?kind=writing_plan&query=AI', { cache: 'no-store' })
  })

  it('decodes fragmented UI message stream events', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"data-chat-status","id":"chat-activity","data":{"phase":"skill","state":"streaming","label":"正在使用 Skill：去 AI 味"},"transient":true}\n'))
        controller.enqueue(encoder.encode('\ndata: {"type":"text-delta","id":"part-1","delta":"你"}\n\ndata: {"type":"tool-input-available","toolCallId":"call-1","toolName":"searchInformationSources","input":{"q":"AI"}}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const events: Array<Record<string, unknown>> = []

    await consumeUIMessageStream(stream, event => events.push(event))

    expect(events).toEqual([
      {
        type: 'data-chat-status',
        id: 'chat-activity',
        data: { phase: 'skill', state: 'streaming', label: '正在使用 Skill：去 AI 味' },
        transient: true,
      },
      { type: 'text-delta', id: 'part-1', delta: '你' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'searchInformationSources', input: { q: 'AI' } },
    ])
  })
})
