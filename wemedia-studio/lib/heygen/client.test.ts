import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHeyGenClient } from './client'


function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}


describe('HeyGen V3 client', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const client = createHeyGenClient({
    apiKey: 'secret',
    baseUrl: 'https://api.heygen.com',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('creates a photo avatar with an uploaded asset', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: {
        avatar_item: {
          id: 'look-1',
          group_id: 'group-1',
          status: 'processing',
        },
      },
    }))

    const result = await client.createPhotoAvatar({
      name: '林晓',
      assetId: 'asset-1',
      idempotencyKey: 'role:1:avatar',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.heygen.com/v3/avatars',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'secret',
          'Idempotency-Key': 'role:1:avatar',
        }),
        body: JSON.stringify({
          type: 'photo',
          name: '林晓',
          file: { type: 'asset_id', asset_id: 'asset-1' },
        }),
      }),
    )
    expect(result).toMatchObject({
      groupId: 'group-1',
      avatarId: 'look-1',
      status: 'processing',
    })
  })

  it('uploads binary assets without putting the key in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: { asset_id: 'asset-1', url: 'https://files.example/asset-1' },
    }))

    const result = await client.uploadAsset(
      new Uint8Array([1, 2, 3]),
      'image/png',
      'portrait.png',
      'role:1:portrait',
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.heygen.com/v3/assets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'image/png',
          'Content-Disposition': 'attachment; filename="portrait.png"',
          'Idempotency-Key': 'role:1:portrait',
        }),
      }),
    )
    expect(result.asset_id).toBe('asset-1')
  })

  it('creates a 16:9 mp4 avatar video with an image background', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: { id: 'video-1', status: 'waiting' },
    }))

    const result = await client.createVideo({
      title: '新品介绍',
      avatarId: 'avatar-1',
      voiceId: 'voice-1',
      script: '大家好',
      backgroundAssetId: 'background-1',
      idempotencyKey: 'render:1',
    })

    const request = fetchMock.mock.calls[0][1]
    expect(JSON.parse(String(request?.body))).toEqual({
      type: 'avatar',
      title: '新品介绍',
      avatar_id: 'avatar-1',
      script: '大家好',
      voice_id: 'voice-1',
      background: { type: 'image', asset_id: 'background-1' },
      aspect_ratio: '16:9',
      output_format: 'mp4',
    })
    expect(result).toMatchObject({ videoId: 'video-1', status: 'waiting' })
  })

  it.each([
    [401, 'authentication_failed', false],
    [403, 'plan_upgrade_required', false],
    [429, 'rate_limit_exceeded', true],
    [500, 'provider_error', true],
  ])(
    'classifies status %s',
    async (status, code, retryable) => {
      fetchMock.mockResolvedValue(jsonResponse({
        error: { code, message: 'provider detail secret' },
      }, status))

      await expect(client.getVideo('video-1')).rejects.toMatchObject({
        code,
        retryable,
        status,
      })
      await expect(client.getVideo('video-1')).rejects.not.toThrow('secret')
    },
  )
})
