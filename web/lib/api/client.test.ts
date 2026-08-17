// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'


describe('API client runtime base URL', () => {
  afterEach(() => {
    delete process.env.API_URL
    delete process.env.NEXT_PUBLIC_API_URL
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses the internal API URL during server rendering', async () => {
    process.env.API_URL = 'http://api:8000/api'
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8000/api'
    vi.resetModules()

    const { API_BASE } = await import('./client')

    expect(API_BASE).toBe('http://api:8000/api')
  })

  it('preserves HTTP status and structured detail for client recovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        detail: {
          message: '任务不存在',
          job_id: 61,
        },
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    )))
    const { ApiError, apiFetch } = await import('./client')

    let thrown: unknown
    try {
      await apiFetch('/jobs/61')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({
      message: '任务不存在',
      status: 404,
      detail: {
        message: '任务不存在',
        job_id: 61,
      },
    })
  })

  it('shows the first FastAPI field validation message instead of a generic 422', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        detail: [{
          type: 'value_error',
          loc: ['body', 'collection_proxy_url'],
          msg: 'Value error, 采集代理地址必须使用 http、https 或 socks5 协议并包含主机',
          input: '127.0.0.1:7890',
        }],
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      },
    )))
    const { ApiError, apiFetch } = await import('./client')

    let thrown: unknown
    try {
      await apiFetch('/settings', { method: 'PUT' })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({
      message: '采集代理地址必须使用 http、https 或 socks5 协议并包含主机',
      status: 422,
    })
  })
})
