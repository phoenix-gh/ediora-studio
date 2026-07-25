import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  convertXResponseToTopic,
  listXResponses,
  setXResponseFeedback,
} from './x-responses'


describe('X response inbox API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('serializes inbox filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await listXResponses({ workflow_status: 'ready', notification_tier: 'immediate' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/x/responses?workflow_status=ready&notification_tier=immediate',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('persists feedback and topic conversion', async () => {
    const response = () => new Response(
      JSON.stringify({ id: 7 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
    vi.stubGlobal('fetch', fetchMock)

    await setXResponseFeedback(7, 'used')
    await convertXResponseToTopic(7)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000/api/x/responses/7/feedback',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ status: 'used' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000/api/x/responses/7/convert-to-topic',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
