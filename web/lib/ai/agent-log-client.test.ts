import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendAgentLogEvent, listAgentLogEvents, listAllAgentLogEvents } from './agent-log-client'

describe('Agent log client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes a worker-authenticated event with a stable stream envelope', async () => {
    process.env.WORKER_TOKEN = 'agent-log-client-token-at-least-32-chars'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sequence: 7 }), { status: 201 }),
    )

    await appendAgentLogEvent({
      stream_kind: 'chat',
      stream_key: 'chat:12',
      session_id: 12,
      turn_id: 'turn-1',
      event_type: 'llm/response',
      phase: 'execute',
      status: 'completed',
      payload: { text: 'answer' },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/agent-logs/events'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Worker-Token': 'agent-log-client-token-at-least-32-chars',
        }),
      }),
    )
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream_kind: 'chat',
      stream_key: 'chat:12',
      event_type: 'llm/response',
    })
  })

  it('queries a session event stream with filters and a replay cursor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ events: [], has_more: false, next_sequence: null }), { status: 200 }),
    )

    await listAgentLogEvents({
      session_id: 12,
      event_type: 'tool/result',
      after_sequence: 6,
      limit: 50,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/agent-logs?session_id=12&event_type=tool%2Fresult&after_sequence=6&limit=50'),
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('replays all pages of a stream in sequence order', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        events: [{ id: 1, sequence: 1 }], has_more: true, next_sequence: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        events: [{ id: 2, sequence: 2 }], has_more: false, next_sequence: null,
      }), { status: 200 }))

    await expect(listAllAgentLogEvents({ session_id: 12, limit: 1 })).resolves.toMatchObject({
      events: [{ id: 1 }, { id: 2 }],
      has_more: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
