// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSessionEvent } from '@/lib/ai/agent-trajectory'
import { AgentTrajectoryPanel } from './AgentTrajectoryPanel'

const api = vi.hoisted(() => ({
  listAgentTrajectory: vi.fn(),
  listAllAgentLogEvents: vi.fn(),
}))

vi.mock('@/lib/ai/agent-log-client', () => ({
  listAgentTrajectory: api.listAgentTrajectory,
  listAllAgentLogEvents: api.listAllAgentLogEvents,
}))

function event(
  seq: number,
  type: AgentSessionEvent['type'],
  data: Record<string, unknown> = {},
  turn = 1,
  step: number | null = null,
): AgentSessionEvent {
  return { seq, time: seq * 1_000, type, turn, step, data }
}

describe('AgentTrajectoryPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.listAgentTrajectory.mockResolvedValue({
      session_key: 'chat:7',
      events: [
        event(1, 'turn/start', { turn: 1 }),
        event(2, 'user/message', { content: [{ kind: 'text', text: '查资料' }], source: { kind: 'user' } }),
        event(3, 'step/start', { turn: 1, step: 1 }, 1, 1),
        event(4, 'assistant/message', { turn: 1, step: 1, blocks: [{ kind: 'text', text: '先查一下' }] }, 1, 1),
        event(5, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'search', arguments: { q: 'AI' } }, 1, 1),
        event(6, 'tool/result', { turn: 1, step: 1, callId: 'call-1', content: [{ kind: 'text', text: '找到资料' }], isError: false }, 1, 1),
        event(7, 'turn/end', { reason: { kind: 'completed' } }),
      ],
      next_sequence: 7,
      has_more: false,
      is_running: false,
      last_error: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('only loads while open and keeps keyed ledger nodes across polling', async () => {
    const { rerender } = render(
      <AgentTrajectoryPanel scope={{ session_id: 7 }} open={false} developerModeEnabled={false} />,
    )
    await act(async () => { await Promise.resolve() })
    expect(api.listAgentTrajectory).not.toHaveBeenCalled()

    rerender(<AgentTrajectoryPanel scope={{ session_id: 7 }} open developerModeEnabled={false} />)
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listAgentTrajectory).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Turn 1')).toBeInTheDocument()
    expect(screen.getByText('Message')).toBeInTheDocument()
    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByText('search')).toBeInTheDocument()
    const userCell = screen.getByTestId('trajectory-cell-user:2')

    fireEvent.click(screen.getByRole('button', { name: /search/ }))
    expect(screen.getByTestId('trajectory-inspector')).toHaveTextContent('输入')
    expect(screen.getByTestId('trajectory-inspector')).toHaveTextContent('找到资料')

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listAgentTrajectory).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('trajectory-cell-user:2')).toBe(userCell)

    rerender(<AgentTrajectoryPanel scope={{ session_id: 7 }} open={false} developerModeEnabled={false} />)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(api.listAgentTrajectory).toHaveBeenCalledTimes(2)
  })
})
