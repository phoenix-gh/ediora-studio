export type HeyGenConfig = { apiKey: string; baseUrl: string }
export type HeyGenAsset = { asset_id: string; url?: string }
export type HeyGenAvatar = {
  groupId: string
  avatarId: string
  status: string
  error?: string
}
export type HeyGenVoice = {
  voiceId: string
  status: string
  error?: string
}
export type HeyGenVideo = {
  videoId: string
  status: string
  videoUrl?: string
  thumbnailUrl?: string
  error?: string
}


export class HeyGenError extends Error {
  retryable: boolean
  code: string
  status: number
  retryAfterSeconds?: number

  constructor(input: {
    message: string
    retryable: boolean
    code: string
    status: number
    retryAfterSeconds?: number
  }) {
    super(input.message)
    this.name = 'HeyGenError'
    this.retryable = input.retryable
    this.code = input.code
    this.status = input.status
    this.retryAfterSeconds = input.retryAfterSeconds
  }
}


type JsonRecord = Record<string, unknown>


function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}


function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}


function firstRecord(...values: unknown[]) {
  for (const value of values) {
    const record = asRecord(value)
    if (Object.keys(record).length) return record
  }
  return {}
}


function errorMessage(value: unknown) {
  if (typeof value === 'string') return value
  const error = asRecord(value)
  return text(error.message, text(error.code))
}


function fallbackCode(status: number) {
  if (status === 401) return 'authentication_failed'
  if (status === 403) return 'plan_upgrade_required'
  if (status === 429) return 'rate_limit_exceeded'
  return status >= 500 ? 'provider_error' : 'request_failed'
}


function classifyRetryable(status: number) {
  return status === 408 || status === 409 || status === 425
    || status === 429 || status >= 500
}


export function createHeyGenClient(config: HeyGenConfig) {
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  async function request<T>(
    path: string,
    init: RequestInit = {},
    idempotencyKey = '',
  ): Promise<T> {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      const canonical = key === 'content-type'
        ? 'Content-Type'
        : key === 'content-disposition'
          ? 'Content-Disposition'
          : key
      headers[canonical] = value
    })
    headers['x-api-key'] = config.apiKey
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
    let payload: JsonRecord = {}
    try {
      payload = asRecord(await response.json())
    } catch {
      payload = {}
    }
    if (!response.ok) {
      const providerError = asRecord(payload.error)
      const code = text(providerError.code, fallbackCode(response.status))
      const rawMessage = text(providerError.message, code)
      const safeMessage = rawMessage
        .replaceAll(config.apiKey, '***')
        .replace(/(api[_ -]?key|token|authorization)\s*[:=]\s*\S+/gi, '$1=***')
        .slice(0, 240)
      const retryAfter = Number(response.headers.get('Retry-After'))
      throw new HeyGenError({
        message: `HeyGen ${code}: ${safeMessage}`,
        code,
        status: response.status,
        retryable: classifyRetryable(response.status),
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
      })
    }
    return (payload.data ?? payload) as T
  }

  function parseAvatar(data: unknown): HeyGenAvatar {
    const root = asRecord(data)
    const group = asRecord(root.avatar_group)
    const avatar = firstRecord(
      root.avatar_item,
      root.avatar,
      root.look,
      root,
    )
    return {
      groupId: text(
        avatar.group_id,
        text(root.group_id, text(group.id)),
      ),
      avatarId: text(avatar.id, text(avatar.avatar_id)),
      status: text(avatar.status, text(root.status, 'processing')),
      error: errorMessage(avatar.error) || undefined,
    }
  }

  function parseVoice(data: unknown): HeyGenVoice {
    const root = asRecord(data)
    const voice = firstRecord(root.voice, root)
    return {
      voiceId: text(voice.id, text(voice.voice_id)),
      status: text(voice.status, 'processing'),
      error: text(voice.failure_message, text(voice.error)) || undefined,
    }
  }

  function parseVideo(data: unknown): HeyGenVideo {
    const root = asRecord(data)
    const video = firstRecord(root.video, root)
    return {
      videoId: text(video.id, text(video.video_id)),
      status: text(video.status, 'waiting'),
      videoUrl: text(video.video_url, text(video.url)) || undefined,
      thumbnailUrl: text(video.thumbnail_url) || undefined,
      error: text(
        video.failure_message,
        errorMessage(video.error),
      ) || undefined,
    }
  }

  return {
    async uploadAsset(
      bytes: Uint8Array,
      mediaType: string,
      filename: string,
      idempotencyKey: string,
    ): Promise<HeyGenAsset> {
      const safeFilename = filename.replace(/["\r\n]/g, '_')
      const upload = new Uint8Array(bytes.byteLength)
      upload.set(bytes)
      const body = new FormData()
      body.append('file', new Blob([upload], { type: mediaType }), safeFilename)
      return request<HeyGenAsset>('/v3/assets', {
        method: 'POST',
        body,
      }, idempotencyKey)
    },

    async createPhotoAvatar(input: {
      name: string
      assetId: string
      idempotencyKey: string
    }): Promise<HeyGenAvatar> {
      const data = await request<unknown>('/v3/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'photo',
          name: input.name,
          file: { type: 'asset_id', asset_id: input.assetId },
        }),
      }, input.idempotencyKey)
      return parseAvatar(data)
    },

    async getAvatar(
      groupId: string,
      avatarId: string,
    ): Promise<HeyGenAvatar> {
      const data = await request<unknown>(
        `/v3/avatars/looks/${encodeURIComponent(avatarId)}`,
      )
      const avatar = parseAvatar(data)
      return { ...avatar, groupId: avatar.groupId || groupId }
    },

    async cloneVoice(input: {
      name: string
      assetId: string
    }): Promise<{ voiceId: string }> {
      const data = asRecord(await request<unknown>('/v3/voices/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: { type: 'asset_id', asset_id: input.assetId },
          voice_name: input.name,
          remove_background_noise: true,
        }),
      }))
      return {
        voiceId: text(
          data.voice_clone_id,
          text(data.voice_id, text(data.id)),
        ),
      }
    },

    async getVoice(voiceId: string): Promise<HeyGenVoice> {
      const data = await request<unknown>(
        `/v3/voices/${encodeURIComponent(voiceId)}`,
      )
      const voice = parseVoice(data)
      return { ...voice, voiceId: voice.voiceId || voiceId }
    },

    async createVideo(input: {
      title: string
      avatarId: string
      voiceId: string
      script: string
      backgroundAssetId: string
      idempotencyKey: string
    }): Promise<HeyGenVideo> {
      const data = await request<unknown>('/v3/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'avatar',
          title: input.title,
          avatar_id: input.avatarId,
          script: input.script,
          voice_id: input.voiceId,
          background: { type: 'image', asset_id: input.backgroundAssetId },
          aspect_ratio: '16:9',
          output_format: 'mp4',
        }),
      }, input.idempotencyKey)
      return parseVideo(data)
    },

    async getVideo(videoId: string): Promise<HeyGenVideo> {
      const data = await request<unknown>(
        `/v3/videos/${encodeURIComponent(videoId)}`,
      )
      const video = parseVideo(data)
      return { ...video, videoId: video.videoId || videoId }
    },
  }
}


export type HeyGenClient = ReturnType<typeof createHeyGenClient>
