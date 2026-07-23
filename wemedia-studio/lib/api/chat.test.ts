import { afterEach, describe, expect, it, vi } from 'vitest'

import { consumeUIMessageStream, createChatSession, deleteChatSession, listChatDrafts, listChatSkills, streamChatReply } from './chat'

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
      onEvent: () => undefined,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sessionId: 7,
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '请参考草稿' }] }],
        skillName: 'baoyu-cover-image',
        draftId: 12,
      }),
    }))
  })

  it('decodes fragmented UI message stream events', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-delta","id":"part-1","delta":"你"}\n'))
        controller.enqueue(encoder.encode('\ndata: {"type":"tool-input-available","toolCallId":"call-1","toolName":"searchInformationSources","input":{"q":"AI"}}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const events: Array<Record<string, unknown>> = []

    await consumeUIMessageStream(stream, event => events.push(event))

    expect(events).toEqual([
      { type: 'text-delta', id: 'part-1', delta: '你' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'searchInformationSources', input: { q: 'AI' } },
    ])
  })
})
