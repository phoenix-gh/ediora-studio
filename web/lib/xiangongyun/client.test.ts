import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  XiangongyunError,
  createXiangongyunClient,
} from './client'


function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}


describe('Xiangongyun client', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const client = createXiangongyunClient({
    baseUrl: 'https://api.example.com/',
    apiToken: 'secret-token',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('lists instances and sends the token only as a Bearer header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      list: [{ id: 'instance-1', name: 'ComfyUI', status: 'running' }],
      total: 1,
    }))

    const result = await client.getInstances()

    expect(result.total).toBe(1)
    expect(result.list[0]).toMatchObject({ id: 'instance-1', status: 'running' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/open/instances',
      expect.objectContaining({ method: 'GET' }),
    )
    const init = fetchMock.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('secret-token')
  })

  it('boots and shuts down using the documented JSON body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, success: true }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, success: true }))

    await client.bootInstance('instance-1')
    await client.shutdownInstance('instance-1')

    expect(fetchMock.mock.calls[0]).toEqual([
      'https://api.example.com/open/instance/boot',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'instance-1' }),
      }),
    ])
    expect(fetchMock.mock.calls[1]).toEqual([
      'https://api.example.com/open/instance/shutdown',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'instance-1' }),
      }),
    ])
  })

  it('returns immediately when the instance is already running', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'instance-1', status: 'running' }))

    await expect(client.ensureInstanceRunning('instance-1')).resolves.toMatchObject({
      id: 'instance-1',
      status: 'running',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('boots a shutdown instance and polls until it is running', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'instance-1', status: 'shutdown' }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, success: true }))
      .mockResolvedValueOnce(jsonResponse({ id: 'instance-1', status: 'booting', progress: 20 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'instance-1', status: 'running', progress: 100 }))

    const result = await client.ensureInstanceRunning('instance-1', {
      pollIntervalMs: 1,
      sleep: vi.fn(async () => undefined),
    })

    expect(result.status).toBe('running')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.com/open/instance/instance-1',
      'https://api.example.com/open/instance/boot',
      'https://api.example.com/open/instance/instance-1',
      'https://api.example.com/open/instance/instance-1',
    ])
  })

  it('rejects unavailable states and polling timeouts', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'instance-1', status: 'destroyed' }))

    await expect(client.ensureInstanceRunning('instance-1')).rejects.toMatchObject({
      name: 'XiangongyunError',
      code: 'instance_unavailable',
      retryable: false,
    } satisfies Partial<XiangongyunError>)

    let now = 0
    fetchMock.mockImplementation(async () => jsonResponse({ id: 'instance-1', status: 'booting' }))
    await expect(client.ensureInstanceRunning('instance-1', {
      pollIntervalMs: 1,
      timeoutMs: 5,
      now: () => now,
      sleep: async () => {
        now += 3
      },
    })).rejects.toMatchObject({
      name: 'XiangongyunError',
      code: 'instance_start_timeout',
      retryable: true,
    } satisfies Partial<XiangongyunError>)
  })

  it('classifies provider errors without exposing the token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'secret-token leaked' }, 500))

    await expect(client.getInstance('instance-1')).rejects.toMatchObject({
      name: 'XiangongyunError',
      retryable: true,
      status: 500,
    } satisfies Partial<XiangongyunError>)
    await expect(client.getInstance('instance-1')).rejects.not.toThrow('secret-token')
  })
})
