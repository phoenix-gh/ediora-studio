import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listCodexModels: vi.fn(),
}))

vi.mock('@/lib/ai/codex-app-server-client', () => ({
  listCodexModels: api.listCodexModels,
}))

import { FALLBACK_CHAT_MODELS } from '@/lib/ai/chat-model-catalog'
import { GET, resetChatModelCatalogCache } from './route'

const listed = [{
  id: 'gpt-deep',
  model: 'gpt-deep',
  displayName: 'Deep',
  description: 'deep',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'high',
  supportedReasoningEfforts: [
    { reasoningEffort: 'high', description: 'deeper' },
  ],
}]

describe('GET /api/chat/models', () => {
  beforeEach(() => {
    resetChatModelCatalogCache()
    api.listCodexModels.mockReset()
  })

  it('returns the Codex catalog and reuses it for the next request', async () => {
    api.listCodexModels.mockResolvedValue(listed)

    const first = await (await GET()).json()
    const second = await (await GET()).json()

    expect(first.models.map((model: { model: string }) => model.model)).toEqual([
      FALLBACK_CHAT_MODELS[0].model,
      'gpt-deep',
    ])
    expect(first.models[1]).toEqual(expect.objectContaining({
      model: 'gpt-deep',
      defaultReasoningEffort: 'high',
    }))
    expect(second).toEqual(first)
    expect(api.listCodexModels).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default assistant model when Codex cannot list models', async () => {
    api.listCodexModels.mockRejectedValue(new Error('codex unavailable'))

    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: FALLBACK_CHAT_MODELS })
  })
})
