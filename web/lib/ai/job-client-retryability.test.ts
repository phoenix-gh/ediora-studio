import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiPost, failStep } from './job-client'


afterEach(() => {
  vi.unstubAllGlobals()
})

describe('durable job retryability', () => {
  it.each([
    ['false', false],
    ['true', true],
  ])('preserves X-WMS-Retryable=%s in fail-step payload', async (header, expected) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ detail: 'safe Telegram failure' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'X-WMS-Retryable': header,
          },
        },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ status: 'failed' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
    vi.stubGlobal('fetch', fetchMock)

    let thrown: unknown
    try {
      await apiPost('/x/responses/7/notify')
    } catch (error) {
      thrown = error
    }
    await failStep(11, 22, thrown)

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      error: 'safe Telegram failure',
      retryable: expected,
    })
  })
})
