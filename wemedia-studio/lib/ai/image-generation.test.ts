import { afterEach, describe, expect, it, vi } from 'vitest'

const imageGeneration = vi.hoisted(() => vi.fn())

vi.mock('ai', async importOriginal => ({
  ...await importOriginal<typeof import('ai')>(),
  generateImage: imageGeneration,
}))

import { generateAndSaveImage } from './image-generation'

describe('direct Agent image generation', () => {
  afterEach(() => {
    imageGeneration.mockReset()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('generates and saves an asset directly without creating a content job', async () => {
    vi.stubEnv('WMS_WORKER_TOKEN', 'direct-image-worker-token-0123456789012345')
    imageGeneration.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({
          image: { api_key: 'sk-image', model: 'gpt-image-1', base_url: 'https://images.example/v1' },
        }), { status: 200 })
      }
      if (url.includes('/assets/upload')) {
        expect(init?.headers).toMatchObject({
          'X-WMS-Worker-Token': 'direct-image-worker-token-0123456789012345',
          'X-Content-Job-Id': '72',
        })
        return new Response(JSON.stringify({
          id: 88, url: '/api/uploads/direct.png', title: '城市夜景',
        }), { status: 201 })
      }
      if (url.endsWith('/jobs/72/events')) return new Response('{}', { status: 201 })
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      jobId: 72,
      prompt: '一张有霓虹灯的未来城市夜景',
      title: '城市夜景',
      directory: '临时文件',
    })).resolves.toEqual({
      asset_id: 88,
      asset_url: '/api/uploads/direct.png',
      title: '城市夜景',
      directory: '临时文件',
      model: 'gpt-image-1',
    })

    expect(imageGeneration).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/jobs/') && String(input).endsWith('/retry'))).toBe(false)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/assets/upload'))).toHaveLength(1)
  })
})
