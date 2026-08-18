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
    vi.stubEnv('WORKER_TOKEN', 'direct-image-worker-token-0123456789012345')
    imageGeneration.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({
          image: { api_key: 'sk-image', model: 'gpt-image-1', base_url: 'https://images.example/v1' },
        }), { status: 200 })
      }
      if (url.includes('/assets/upload')) {
        expect(init?.headers).toMatchObject({
          'X-Worker-Token': 'direct-image-worker-token-0123456789012345',
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
    expect(imageGeneration).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '一张有霓虹灯的未来城市夜景',
      n: 1,
    }))
    expect(imageGeneration.mock.calls[0]?.[0]).not.toHaveProperty('size')
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/jobs/') && String(input).endsWith('/retry'))).toBe(false)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/assets/upload'))).toHaveLength(1)
  })

  it('passes optional reference images without changing the text-only call shape', async () => {
    vi.stubEnv('WORKER_TOKEN', 'direct-image-worker-token-0123456789012345')
    imageGeneration.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([9, 8, 7]), mediaType: 'image/png' }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({
          image: { api_key: 'sk-image', model: 'gpt-image-1', base_url: 'https://images.example/v1' },
        }), { status: 200 })
      }
      if (url.includes('/assets/upload')) {
        return new Response(JSON.stringify({
          id: 91, url: '/api/uploads/look.png', title: '林晓 定妆图',
        }), { status: 201 })
      }
      if (url.includes('/jobs/73/events')) return new Response('{}', { status: 201 })
      throw new Error(`unexpected request: ${url}`)
    }))

    const portrait = new Uint8Array([1, 1, 1])
    const environment = new Uint8Array([2, 2, 2])
    await generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      jobId: 73,
      prompt: '把这个人放进这个环境',
      title: '林晓 定妆图',
      referenceImages: [
        { bytes: portrait, mediaType: 'image/png' },
        { bytes: environment, mediaType: 'image/jpeg' },
      ],
      size: '1536x1024',
    })

    expect(imageGeneration).toHaveBeenCalledWith(expect.objectContaining({
      prompt: {
        text: '把这个人放进这个环境',
        images: [portrait, environment],
      },
      n: 1,
      size: '1536x1024',
    }))
  })

  it('uses 临时文件 when a direct image does not specify a directory', async () => {
    vi.stubEnv('WORKER_TOKEN', 'direct-image-worker-token-0123456789012345')
    imageGeneration.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([4, 5, 6]), mediaType: 'image/png' }],
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({
          image: { api_key: 'sk-image', model: 'gpt-image-1' },
        }), { status: 200 })
      }
      if (url.includes('/assets/upload')) {
        expect(url).toContain('directory=%E4%B8%B4%E6%97%B6%E6%96%87')
        return new Response(JSON.stringify({
          id: 92, url: '/api/uploads/temp.png', title: 'Chat 生图',
        }), { status: 201 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      prompt: '一张雾中的山',
    })).resolves.toMatchObject({
      asset_id: 92,
      directory: '临时文件',
    })
    expect(imageGeneration).toHaveBeenCalledOnce()
  })

  it('rejects an unknown media directory before calling the image provider', async () => {
    vi.stubEnv('WORKER_TOKEN', 'direct-image-worker-token-0123456789012345')
    imageGeneration.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([7, 8, 9]), mediaType: 'image/png' }],
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({ image: { api_key: 'sk-image', model: 'gpt-image-1' } }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      prompt: '一张人像',
      directory: '人像摄影',
    })).rejects.toThrow('多媒体目录不存在：人像摄影')
    expect(imageGeneration).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/assets/upload'))).toBe(false)
  })

  it('retries a failed asset upload with the generated bytes instead of generating again', async () => {
    vi.stubEnv('WORKER_TOKEN', 'direct-image-worker-token-0123456789012345')
    imageGeneration.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([10, 11, 12]), mediaType: 'image/png' }],
    })
    let uploadAttempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({ image: { api_key: 'sk-image', model: 'gpt-image-1' } }), { status: 200 })
      }
      if (url.includes('/assets/upload')) {
        uploadAttempts += 1
        if (uploadAttempts === 1) return new Response('temporary failure', { status: 503 })
        return new Response(JSON.stringify({ id: 93, url: '/api/uploads/retried.png', title: 'Chat 生图' }), { status: 201 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      prompt: '一张海边日落',
    })).resolves.toMatchObject({ asset_id: 93 })
    expect(imageGeneration).toHaveBeenCalledOnce()
    expect(uploadAttempts).toBe(2)
  })
})
