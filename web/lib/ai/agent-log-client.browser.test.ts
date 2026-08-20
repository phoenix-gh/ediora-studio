// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { listAgentLogEvents } from './agent-log-client'

describe('Agent log browser client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads events through the shared browser API client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events: [], has_more: false, next_sequence: null }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await listAgentLogEvents({ job_id: 2051, limit: 2 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/_ediora-api/agent-logs?job_id=2051&limit=2',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})
