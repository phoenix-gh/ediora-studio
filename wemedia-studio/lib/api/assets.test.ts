// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  importCreativeAssetImages,
  uploadInlineAssetImage,
} from './assets'


describe('creative asset inline image APIs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('imports remote images in one ordered batch with per-item failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [
        {
          source_url: 'https://img.example/a.png',
          url: '/api/uploads/a.png',
          error_code: '',
          error: '',
        },
        {
          source_url: 'https://img.example/b.png',
          url: '',
          error_code: 'timeout',
          error: '图片下载超时',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const items = await importCreativeAssetImages([
      'https://img.example/a.png',
      'https://img.example/b.png',
    ])

    expect(items.map(item => item.source_url)).toEqual([
      'https://img.example/a.png',
      'https://img.example/b.png',
    ])
    expect(items[1]).toMatchObject({
      error_code: 'timeout',
      error: '图片下载超时',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/assets/images/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          urls: [
            'https://img.example/a.png',
            'https://img.example/b.png',
          ],
        }),
      }),
    )
  })

  it('uploads an image file and keeps the persisted URL server-relative', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      url: '/api/uploads/local.png',
      filename: 'local.png',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['image'], 'source.png', { type: 'image/png' })

    const url = await uploadInlineAssetImage(file)

    expect(url).toBe('/api/uploads/local.png')
    const [requestUrl, init] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('http://localhost:8000/api/upload/image')
    expect(init).toMatchObject({ method: 'POST' })
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBe(file)
    expect(init.headers).toEqual({})
  })
})
