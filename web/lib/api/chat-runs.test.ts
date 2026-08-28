import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ChatRunApiError,
  createChatRun,
  decideChatRunApproval,
  loadChatRunCheckpoint,
} from './chat-runs'

describe('internal Chat Run API client', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('creates a run with the worker boundary and frozen objective identity', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'run-1', status: 'preparing', checkpoint_version: 0,
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await createChatRun(7, { user_message_id: 11, objective: 'write' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/chat/sessions/7/runs',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Token': 'worker-token-at-least-32-characters',
        },
        body: JSON.stringify({ user_message_id: 11, objective: 'write' }),
      }),
    )
  })

  it('submits only durable approval identity and the decision', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      run_id: 'run-1', tool_call_id: 'call-1', decision: 'approved',
      duplicate: false, run_status: 'resuming', checkpoint_version: 3,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await decideChatRunApproval(7, 'run-1', 'approval-1', {
      tool_call_id: 'call-1', approved: true,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/chat/sessions/7/runs/run-1/approvals/approval-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tool_call_id: 'call-1', approved: true }),
      }),
    )
  })

  it('returns a typed non-retryable conflict for stale checkpoints', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: 'chat run version conflict' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )))

    const error = await loadChatRunCheckpoint(7, 'run-1').catch(value => value)

    expect(error).toBeInstanceOf(ChatRunApiError)
    expect(error).toMatchObject({ status: 409, retryable: false })
  })
})
