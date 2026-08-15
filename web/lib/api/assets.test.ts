// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  importCreativeAssetImages,
  uploadCreativeAsset,
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

  it('uploads media into an encoded creative-asset directory', async () => {
    const asset = {
      id: 91,
      asset_type: 'media',
      media_kind: 'image',
      title: '街拍.png',
      content: '',
      url: '/api/uploads/street.png',
      media_type: 'image/png',
      filename: '街拍.png',
      directory: '人物 参考',
      tags: [],
      source: 'upload',
      created_at: '',
      updated_at: '',
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(asset), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['image'], '街拍.png', { type: 'image/png' })

    await uploadCreativeAsset('image', file, '人物 参考')

    const [requestUrl, init] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('http://localhost:8000/api/assets/upload?media_kind=image&directory=%E4%BA%BA%E7%89%A9+%E5%8F%82%E8%80%83')
    expect((init.body as FormData).get('file')).toBe(file)
    expect(init.headers).toEqual({})
  })
})
