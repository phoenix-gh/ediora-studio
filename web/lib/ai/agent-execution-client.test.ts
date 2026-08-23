import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkpointAgentExecution,
  claimAgentToolCall,
  ensureAgentExecution,
  appendAgentMessage,
  listAgentToolCalls,
} from './agent-execution-client'
import { ApiRequestError } from './job-client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('durable Agent execution client', () => {
  it('sends the worker job identity on execution, checkpoint, and tool calls', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    vi.stubEnv('API_URL', 'http://api.test/api')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 31, version: 1 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 31, version: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: 'execute' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await ensureAgentExecution(17, {
      objective: 'create posts', skillMode: 'auto', skillName: null,
    })
    await checkpointAgentExecution(17, 31, 1, {
      phase: 'execute', checkpoint: { parts: [] }, audit: {},
    })
    await claimAgentToolCall(17, 31, {
      toolName: 'list_creative_asset_candidates', toolCallId: 'call-1',
      sideEffecting: false, autoApproved: false, status: 'started',
      inputSummary: { directories: ['搞钱副业'] }, occurredAt: '2026-08-04T00:00:00Z',
    })
    await appendAgentMessage(17, 31, {
      phase: 'execute', direction: 'model_response',
      payload: { text: 'done' }, occurredAt: '2026-08-04T00:00:00Z',
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1].headers).get('X-Content-Job-Id')).toBe('17')
      expect(new Headers(call[1].headers).get('X-Worker-Token')).toBeTruthy()
    }
  })

  it('treats checkpoint conflicts as non-retryable', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: 'version conflict' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )))

    const error = await checkpointAgentExecution(17, 31, 1, {
      phase: 'execute', checkpoint: {}, audit: {},
    }).catch(value => value)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ status: 409, retryable: false })
  })

  it('pins a stage attempt when creating a Job Agent execution', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 32, step_id: 71, attempt: 2, version: 1 }),
      { status: 201 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await ensureAgentExecution(17, {
      objective: 'write',
      skillMode: 'manual',
      skillName: 'writing-plan',
      stepId: 71,
      attempt: 2,
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({
      job_id: 17,
      step_id: 71,
      attempt: 2,
      skill_name: 'writing-plan',
    })
  })

  it('loads recorded tool calls with the worker job identity', async () => {
    vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([])))
    vi.stubGlobal('fetch', fetchMock)

    await listAgentToolCalls(17, 31)

    expect(fetchMock.mock.calls[0][0]).toContain('/agent-executions/31/tool-calls')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Content-Job-Id')).toBe('17')
  })
})
