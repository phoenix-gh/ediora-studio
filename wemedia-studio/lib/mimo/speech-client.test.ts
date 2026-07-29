import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMiMoSpeechProvider,
  SpeechProviderError,
  type MiMoSpeechConfig,
  type SpeechRequest,
} from './speech-client'


const config: MiMoSpeechConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts',
  defaultVoice: 'mimo_default',
}

const speechRequest: SpeechRequest = {
  text: '测试配音',
  voiceId: 'mimo_default',
  speed: 1,
  volume: 1,
  pitch: 0,
  audio: {
    sampleRate: 44100,
    bitrate: 128000,
    format: 'mp3',
    channels: 1,
  },
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    id: 'request-1',
    choices: [{
      message: {
        audio: { data: btoa('RIFF-test-audio') },
      },
    }],
    ...overrides,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('MiMo speech provider', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends narration as the assistant message and decodes returned WAV audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse())
    const provider = createMiMoSpeechProvider(config, fetchMock)

    const result = await provider.generate(speechRequest)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.xiaomimimo.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body).toMatchObject({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: speechRequest.text }],
      audio: { voice: 'mimo_default', format: 'wav' },
    })
    expect(new TextDecoder().decode(result.bytes)).toBe('RIFF-test-audio')
    expect(result.mediaType).toBe('audio/wav')
    expect(result.providerRequestId).toBe('request-1')
  })

  it('places an optional style instruction before the assistant narration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse())
    const provider = createMiMoSpeechProvider({
      ...config,
      styleInstruction: '沉稳、自然，不要夸张。',
    }, fetchMock)

    await provider.generate({ ...speechRequest, voiceId: '' })

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body.messages).toEqual([
      { role: 'user', content: '沉稳、自然，不要夸张。' },
      { role: 'assistant', content: speechRequest.text },
    ])
    expect(body.audio.voice).toBe('mimo_default')
  })

  it.each([
    [429, true],
    [503, true],
    [400, false],
  ])('classifies HTTP %s retryability', async (status, retryable) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'provider failed' } }),
      { status, headers: { 'Content-Type': 'application/json' } },
    ))
    const provider = createMiMoSpeechProvider(config, fetchMock)

    const error = await provider.generate(speechRequest).catch(value => value)

    expect(error).toBeInstanceOf(SpeechProviderError)
    expect(error).toMatchObject({ status, retryable })
  })

  it.each([
    [{ id: 'request-1', choices: [{ message: {} }] }, '没有返回音频'],
    [{
      id: 'request-1',
      choices: [{ message: { audio: { data: 'not-base64!' } } }],
    }, 'Base64'],
    [{
      id: 'request-1',
      choices: [{ message: { audio: { data: '' } } }],
    }, '音频为空'],
  ])('rejects malformed successful responses', async (payload, message) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(payload),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const provider = createMiMoSpeechProvider(config, fetchMock)

    await expect(provider.generate(speechRequest)).rejects.toThrow(message)
  })

  it.each([
    'https://attacker.invalid/v1',
    'http://api.xiaomimimo.com/v1',
    'https://api.xiaomimimo.com/not-v1',
  ])('rejects a non-official or insecure destination before sending a key', async baseUrl => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse())
    const provider = createMiMoSpeechProvider({
      ...config,
      baseUrl,
    }, fetchMock)

    await expect(provider.generate(speechRequest))
      .rejects.toThrow('MiMo Base URL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts a stalled provider request after the bounded timeout', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url, init: RequestInit | undefined) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'))
        }, { once: true })
      })
    ))
    const provider = createMiMoSpeechProvider(config, fetchMock)

    const errorPromise = provider.generate(speechRequest).catch(error => error)
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await errorPromise

    expect(error).toBeInstanceOf(SpeechProviderError)
    expect(error).toMatchObject({ retryable: true })
    expect(error.message).toContain('超时')
  })

  it('rejects an oversized response before parsing its body', async () => {
    const bodyCanceled = vi.fn()
    const responseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'))
      },
      cancel: bodyCanceled,
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Length': String(150 * 1024 * 1024),
        'Content-Type': 'application/json',
      },
    }))
    const provider = createMiMoSpeechProvider(config, fetchMock)

    await expect(provider.generate(speechRequest))
      .rejects.toThrow('响应超过')
    expect(bodyCanceled).toHaveBeenCalledOnce()
  })
})
