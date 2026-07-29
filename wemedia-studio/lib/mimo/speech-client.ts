import type { WordTiming } from '@/lib/api/text-videos'


const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const MAX_RESPONSE_BYTES = Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429])

export type MiMoSpeechConfig = {
  apiKey: string
  baseUrl: string
  model: string
  defaultVoice: string
  styleInstruction?: string
}

export type SpeechRequest = {
  text: string
  voiceId: string
  speed: number
  volume: number
  pitch: number
  audio: {
    sampleRate: 44100
    bitrate: 128000
    format: 'mp3'
    channels: 1
  }
}

export type SpeechProviderResult = {
  bytes: Uint8Array
  mediaType: 'audio/wav' | 'audio/mpeg'
  wordTimings?: WordTiming[]
  providerRequestId?: string
}

export interface SpeechProvider {
  generate(request: SpeechRequest): Promise<SpeechProviderResult>
}

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'SpeechProviderError'
  }
}

function normalizeMiMoBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new SpeechProviderError(
      'MiMo Base URL 无效',
      undefined,
      false,
    )
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'api.xiaomimimo.com'
    || parsed.pathname !== '/v1'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || parsed.search
    || parsed.hash
  ) {
    throw new SpeechProviderError(
      'MiMo Base URL 必须使用官方 HTTPS 地址',
      undefined,
      false,
    )
  }
  return normalized
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = payload.error
    if (
      error
      && typeof error === 'object'
      && 'message' in error
      && typeof error.message === 'string'
    ) {
      return error.message.slice(0, 500)
    }
    if (typeof error === 'string') return error.slice(0, 500)
  }
  return `MiMo 语音请求失败（HTTP ${status}）`
}

function responseTooLarge(status: number): SpeechProviderError {
  return new SpeechProviderError(
    'MiMo 响应超过允许的大小限制',
    status,
    isRetryableStatus(status),
  )
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_RESPONSE_BYTES
  ) {
    try {
      await response.body?.cancel()
    } catch {
      // The bounded failure remains authoritative if cancellation races.
    }
    throw responseTooLarge(response.status)
  }

  if (!response.body) {
    return JSON.parse(await response.text())
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytesRead += value.byteLength
    if (bytesRead > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw responseTooLarge(response.status)
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return JSON.parse(text)
}

function decodeBase64Audio(value: string): Uint8Array {
  if (!value) {
    throw new SpeechProviderError('MiMo 返回的音频为空', undefined, false)
  }
  const estimatedBytes = Math.floor(value.length * 3 / 4)
  if (estimatedBytes > MAX_AUDIO_BYTES) {
    throw new SpeechProviderError(
      'MiMo 返回的音频超过 100 MB 限制',
      undefined,
      false,
    )
  }
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new SpeechProviderError(
      'MiMo 返回了无效的 Base64 音频',
      undefined,
      false,
    )
  }

  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new SpeechProviderError(
      'MiMo 返回了无效的 Base64 音频',
      undefined,
      false,
    )
  }
  if (!binary.length) {
    throw new SpeechProviderError('MiMo 返回的音频为空', undefined, false)
  }
  if (binary.length > MAX_AUDIO_BYTES) {
    throw new SpeechProviderError(
      'MiMo 返回的音频超过 100 MB 限制',
      undefined,
      false,
    )
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function audioData(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || !('choices' in payload)) {
    throw new SpeechProviderError('MiMo 没有返回音频', undefined, false)
  }
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new SpeechProviderError('MiMo 没有返回音频', undefined, false)
  }
  const first = choices[0]
  if (!first || typeof first !== 'object' || !('message' in first)) {
    throw new SpeechProviderError('MiMo 没有返回音频', undefined, false)
  }
  const message = first.message
  if (!message || typeof message !== 'object' || !('audio' in message)) {
    throw new SpeechProviderError('MiMo 没有返回音频', undefined, false)
  }
  const audio = message.audio
  if (
    !audio
    || typeof audio !== 'object'
    || !('data' in audio)
    || typeof audio.data !== 'string'
  ) {
    throw new SpeechProviderError('MiMo 没有返回音频', undefined, false)
  }
  return audio.data
}

function requestId(payload: unknown): string | undefined {
  if (
    payload
    && typeof payload === 'object'
    && 'id' in payload
    && typeof payload.id === 'string'
  ) {
    return payload.id
  }
  return undefined
}

export function createMiMoSpeechProvider(
  config: MiMoSpeechConfig,
  fetcher: typeof fetch = fetch,
): SpeechProvider {
  return {
    async generate(request) {
      const apiKey = config.apiKey.trim()
      const baseUrl = normalizeMiMoBaseUrl(config.baseUrl)
      const model = config.model.trim()
      if (!apiKey || !baseUrl || !model) {
        throw new SpeechProviderError(
          'MiMo 语音配置不完整',
          undefined,
          false,
        )
      }
      if (!request.text.trim()) {
        throw new SpeechProviderError(
          '口播文本不能为空',
          undefined,
          false,
        )
      }

      const messages: Array<{
        role: 'user' | 'assistant'
        content: string
      }> = []
      const styleInstruction = config.styleInstruction?.trim()
      if (styleInstruction) {
        messages.push({ role: 'user', content: styleInstruction })
      }
      messages.push({ role: 'assistant', content: request.text })

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      )
      try {
        let response: Response
        try {
          response = await fetcher(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages,
              audio: {
                voice: request.voiceId.trim() || config.defaultVoice.trim(),
                format: 'wav',
              },
            }),
            signal: controller.signal,
          })
        } catch (error) {
          if (controller.signal.aborted) {
            throw new SpeechProviderError(
              'MiMo 语音请求超时',
              undefined,
              true,
            )
          }
          if (error instanceof SpeechProviderError) throw error
          throw new SpeechProviderError(
            error instanceof Error ? error.message : 'MiMo 网络请求失败',
            undefined,
            true,
          )
        }

        let payload: unknown
        try {
          payload = await readBoundedJson(response)
        } catch (error) {
          if (controller.signal.aborted) {
            throw new SpeechProviderError(
              'MiMo 语音请求超时',
              undefined,
              true,
            )
          }
          if (error instanceof SpeechProviderError) throw error
          throw new SpeechProviderError(
            `MiMo 返回了无效 JSON（HTTP ${response.status}）`,
            response.status,
            isRetryableStatus(response.status),
          )
        }
        if (!response.ok) {
          throw new SpeechProviderError(
            errorMessage(payload, response.status),
            response.status,
            isRetryableStatus(response.status),
          )
        }

        return {
          bytes: decodeBase64Audio(audioData(payload)),
          mediaType: 'audio/wav',
          providerRequestId: requestId(payload),
        }
      } finally {
        clearTimeout(timeoutId)
      }
    },
  }
}
