import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  chat: vi.fn().mockReturnValue('configured-model'),
}))

vi.mock('ai', () => ({ generateText: mocks.generateText }))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ chat: mocks.chat })),
}))

import { POST } from './route'


describe('POST /api/digital-human/script', () => {
  beforeEach(() => {
    process.env.WMS_WORKER_TOKEN = 'test-worker-token-at-least-32-chars'
  })

  afterEach(() => {
    delete process.env.WMS_WORKER_TOKEN
    vi.unstubAllGlobals()
    mocks.generateText.mockReset()
    mocks.chat.mockClear()
  })

  it('converts a draft into an editable script without mutating it', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        api_key: 'text-key',
        model: 'gpt-4o-mini',
        base_url: 'https://api.openai.com/v1',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 7,
        title: 'AI 工作流',
        content: '# 标题\n事实正文',
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    mocks.generateText.mockResolvedValue({
      text: '```markdown\n大家好，今天聊聊事实正文。\n```',
    })

    const response = await POST(new Request(
      'http://localhost/api/digital-human/script',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'convert_draft', draftId: 7 }),
      },
    ))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      script: '大家好，今天聊聊事实正文。',
    })
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'configured-model',
      prompt: expect.stringContaining('事实正文'),
    }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/settings/ai-runtime'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-WMS-Worker-Token': 'test-worker-token-at-least-32-chars',
        }),
      }),
    )
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('rejects oversized draft source before calling the model', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        api_key: 'text-key',
        model: 'gpt-4o-mini',
        base_url: '',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 7,
        title: 'too large',
        content: 'x'.repeat(60_001),
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(new Request('http://localhost/api/digital-human/script', {
      method: 'POST',
      body: JSON.stringify({ mode: 'convert_draft', draftId: 7 }),
    }))

    expect(response.status).toBe(413)
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
})
