import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComfyUIError, createComfyUIClient } from './client'


function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}


describe('ComfyUI client', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const client = createComfyUIClient({
    baseUrl: 'http://127.0.0.1:8188',
    authToken: 'secret-token',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('puts the token in the Authorization header, not the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ system: {} }))

    await client.systemStats()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8188/system_stats',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
    const init = fetchMock.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer secret-token')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('secret-token')
  })

  it('queues a prompt and returns prompt_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ prompt_id: 'p-1' }))

    const id = await client.queuePrompt({ '1': { class_type: 'KSampler' } })

    expect(id).toBe('p-1')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8188/prompt',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('classifies auth failures as not retryable', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }))

    await expect(client.systemStats()).rejects.toMatchObject({
      name: 'ComfyUIError',
      retryable: false,
      code: 'authentication_failed',
      status: 401,
    } satisfies Partial<ComfyUIError>)
  })

  it('waits through transient gateway errors until system_stats is ready', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('starting', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ system: {} }))
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(client.waitUntilReady({ pollIntervalMs: 25, sleep })).resolves.toEqual({ system: {} })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(25)
  })
})
