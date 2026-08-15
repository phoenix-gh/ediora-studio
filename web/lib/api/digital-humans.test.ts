import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTalkingVideoRender,
  generateTalkingScript,
  listDigitalHumans,
} from './digital-humans'


function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}


describe('digital-human API', () => {
  const fetchMock = vi.fn<typeof fetch>()

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('creates a render through the talking-video API', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse({
      id: 21,
      project_id: 14,
      version: 1,
      status: 'queued',
    }, 201))

    await createTalkingVideoRender(14)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/talking-videos/14/renders'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('lists roles without mutating the response', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse([{ id: 1, name: '林晓' }]))

    const roles = await listDigitalHumans()

    expect(roles[0].name).toBe('林晓')
    expect(fetchMock.mock.calls[0][0]).toContain('/digital-humans')
  })

  it('calls the Next.js script assistant endpoint', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse({ script: '大家好' }))

    await generateTalkingScript({ mode: 'generate', topic: 'AI 工作流' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/digital-human/script',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'generate', topic: 'AI 工作流' }),
      }),
    )
  })
})
