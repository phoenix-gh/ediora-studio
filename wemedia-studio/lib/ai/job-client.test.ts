import { afterEach, expect, it, vi } from 'vitest'

import { ApiRequestError, apiPost } from './job-client'


afterEach(() => {
  vi.unstubAllGlobals()
})

it('retains HTTP status, structured detail, and retryability', () => {
  const detail = {
    message: '分镜校验失败',
    errors: ['missing-word 不存在'],
  }
  const error = new ApiRequestError(
    '分镜校验失败',
    false,
    true,
    422,
    detail,
  )

  expect(error.status).toBe(422)
  expect(error.detail).toEqual(detail)
  expect(error.retryable).toBe(false)
  expect(error.responseReceived).toBe(true)
})

it('keeps structured validation detail and retryability from an HTTP error', async () => {
  const detail = {
    message: '分镜词范围必须完整且连续',
    errors: ['missing-word 不存在'],
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ detail }),
    {
      status: 422,
      headers: {
        'Content-Type': 'application/json',
        'X-WMS-Retryable': 'false',
      },
    },
  )))

  const request = apiPost('/text-videos/1/scene-plan/worker-validate', {})

  await expect(request).rejects.toMatchObject({
    name: 'ApiRequestError',
    message: detail.message,
    status: 422,
    detail,
    retryable: false,
    responseReceived: true,
  })
})
