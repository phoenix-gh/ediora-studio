// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentLogEvent } from '@/lib/ai/agent-log-client'
import { ChatAgentLogDialog } from './ChatAgentLogDialog'

const api = vi.hoisted(() => ({
  listAllAgentLogEvents: vi.fn(),
}))

vi.mock('@/lib/ai/agent-log-client', () => ({
  listAllAgentLogEvents: api.listAllAgentLogEvents,
}))

const firstEvent: AgentLogEvent = {
  id: 1,
  sequence: 1,
  stream_kind: 'chat',
  stream_key: 'chat:7',
  session_id: 7,
  job_id: null,
  execution_id: null,
  turn_id: 'turn-1',
  step_id: null,
  event_type: 'session/turn-start',
  phase: 'chat',
  status: 'running',
  payload: { kind: 'user-message' },
  usage: null,
  duration_ms: null,
  created_at: '2026-08-20T08:00:00Z',
}

const secondEvent: AgentLogEvent = {
  ...firstEvent,
  id: 2,
  sequence: 2,
  event_type: 'llm/response',
  status: 'completed',
  payload: { text: '完成' },
}

describe('ChatAgentLogDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.listAllAgentLogEvents.mockResolvedValue({
      events: [firstEvent],
      has_more: false,
      next_sequence: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('only loads and polls the trace while the dialog is open', async () => {
    const { rerender } = render(
      <ChatAgentLogDialog
        sessionId={7}
        open={false}
        developerModeEnabled
        onOpenChange={vi.fn()}
      />,
    )

    await act(async () => { await Promise.resolve() })
    expect(api.listAllAgentLogEvents).not.toHaveBeenCalled()

    rerender(
      <ChatAgentLogDialog
        sessionId={7}
        open
        developerModeEnabled
        onOpenChange={vi.fn()}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listAllAgentLogEvents).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(api.listAllAgentLogEvents).toHaveBeenCalledTimes(2)

    rerender(
      <ChatAgentLogDialog
        sessionId={7}
        open={false}
        developerModeEnabled
        onOpenChange={vi.fn()}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(api.listAllAgentLogEvents).toHaveBeenCalledTimes(2)
  })

  it('keeps existing event nodes when a refresh appends new events', async () => {
    api.listAllAgentLogEvents
      .mockResolvedValueOnce({ events: [firstEvent], has_more: false, next_sequence: null })
      .mockResolvedValueOnce({ events: [firstEvent, secondEvent], has_more: false, next_sequence: null })

    render(
      <ChatAgentLogDialog
        sessionId={7}
        open
        developerModeEnabled
        onOpenChange={vi.fn()}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
      await Promise.resolve()
    })

    const firstNode = screen.getByTestId('trajectory-turn-1')
    expect(firstNode).not.toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('trajectory-cell-message:2')).toHaveTextContent('完成')
    expect(screen.getByTestId('trajectory-turn-1')).toBe(firstNode)
  })
})
