import { describe, expect, it, vi } from 'vitest'

import { chatReasoningModel } from './chat-reasoning-model'

describe('Chat reasoning model boundary', () => {
  it('separates tagged provider reasoning from visible model text', async () => {
    const rawModel = {
      specificationVersion: 'v4' as const,
      provider: 'test',
      modelId: 'tagged-reasoning',
      supportedUrls: {},
      doGenerate: vi.fn(async () => ({
        content: [{
          type: 'text' as const,
          text: '<think>private reasoning</think>\n\nVisible answer',
        }],
        finishReason: 'stop' as const,
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 1, reasoning: 1 },
        },
        warnings: [],
      })),
      doStream: vi.fn(),
    }

    const model = chatReasoningModel(
      rawModel as unknown as Parameters<typeof chatReasoningModel>[0],
    )
    const result = await model.doGenerate({ prompt: [] } as never)

    expect(result.content).toEqual([
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: '\n\nVisible answer' },
    ])
  })

  it('keeps tagged reasoning out of streamed text deltas', async () => {
    const rawModel = {
      specificationVersion: 'v4' as const,
      provider: 'test',
      modelId: 'tagged-reasoning-stream',
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'answer' })
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: '<think>private reasoning</think>Visible answer',
            })
            controller.enqueue({ type: 'text-end', id: 'answer' })
            controller.close()
          },
        }),
      })),
    }

    const model = chatReasoningModel(
      rawModel as unknown as Parameters<typeof chatReasoningModel>[0],
    )
    const result = await model.doStream({ prompt: [] } as never)
    const chunks = []
    const reader = result.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toContainEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'private reasoning' })
    expect(chunks).toContainEqual({ type: 'text-delta', id: 'answer', delta: 'Visible answer' })
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).not.toContainEqual(
      expect.objectContaining({ delta: expect.stringContaining('<think>') }),
    )
  })
})
