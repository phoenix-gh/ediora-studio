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

  it('requests a provider image URL and downloads it before uploading the asset', async () => {
    vi.stubEnv('WORKER_TOKEN', 'url-image-worker-token-0123456789012345')
    const providerBytes = Uint8Array.from([137, 80, 78, 71, 13, 10])
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({
          image: {
            api_key: 'sk-image',
            model: 'gpt-image-2',
            base_url: 'https://images.example/v1',
            headers: { 'X-Tenant': 'tenant-a' },
            image_response_format: 'url',
          },
        }), { status: 200 })
      }
      if (url === 'https://images.example/v1/images/generations') {
        expect(init?.method).toBe('POST')
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer sk-image',
          'X-Tenant': 'tenant-a',
        })
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'gpt-image-2',
          prompt: '一张湖边日落',
          n: 1,
          response_format: 'url',
        })
        return new Response(JSON.stringify({
          data: [{
            url: 'https://cdn.example/lake.png',
            b64_json: 'ignored-because-url-is-configured',
          }],
        }), { status: 200 })
      }
      if (url === 'https://cdn.example/lake.png') {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false)
        return new Response(providerBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      if (url.includes('/assets/upload')) {
        const form = init?.body as FormData
        const file = form.get('file') as Blob
        expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(providerBytes))
        expect(init?.headers).toMatchObject({
          'X-Worker-Token': 'url-image-worker-token-0123456789012345',
          'X-Content-Job-Id': '74',
        })
        return new Response(JSON.stringify({ id: 94, url: '/api/uploads/lake.png', title: '湖边日落' }), { status: 201 })
      }
      if (url.endsWith('/jobs/74/events')) return new Response('{}', { status: 201 })
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      jobId: 74,
      prompt: '一张湖边日落',
      title: '湖边日落',
      directory: '临时文件',
    })).resolves.toMatchObject({
      asset_id: 94,
      asset_url: '/api/uploads/lake.png',
    })

    expect(imageGeneration).not.toHaveBeenCalled()
  })

  it('rejects a provider image response without a downloadable URL', async () => {
    vi.stubEnv('WORKER_TOKEN', 'url-image-worker-token-0123456789012345')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/assets/directories')) {
        return new Response(JSON.stringify([{ name: '临时文件', asset_type: 'media' }]), { status: 200 })
      }
      if (url.endsWith('/settings/ai-runtime')) {
        return new Response(JSON.stringify({
          image: {
            api_key: 'sk-image',
            model: 'dall-e-3',
            base_url: 'https://images.example/v1',
            image_response_format: 'url',
          },
        }), { status: 200 })
      }
      if (url === 'https://images.example/v1/images/generations') {
        return new Response(JSON.stringify({ data: [{}] }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateAndSaveImage({
      apiBase: 'http://localhost:8000/api',
      prompt: '一张没有返回地址的图片',
    })).rejects.toThrow(/URL/i)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/assets/upload'))).toBe(false)
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
