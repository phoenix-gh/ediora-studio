// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatAgentLogDialog } from './ChatAgentLogDialog'

const api = vi.hoisted(() => ({
  listAgentTrajectory: vi.fn(),
}))

vi.mock('@/lib/ai/agent-log-client', () => ({
  listAgentTrajectory: api.listAgentTrajectory,
}))

const firstEvent = { seq: 1, time: 1_000, type: 'turn/start' as const, turn: 1, step: null, data: { turn: 1 } }
const secondEvent = { seq: 2, time: 2_000, type: 'assistant/message' as const, turn: 1, step: 1, data: { turn: 1, step: 1, blocks: [{ kind: 'text', text: '完成' }] } }

describe('ChatAgentLogDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.listAgentTrajectory.mockResolvedValue({
      session_key: 'chat:7',
      events: [firstEvent],
      next_sequence: 1,
      has_more: false,
      is_running: true,
      last_error: null,
      unsupported_format: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('only loads and polls the canonical trace while the dialog is open', async () => {
    const { rerender } = render(
      <ChatAgentLogDialog
        sessionId={7}
        open={false}
        developerModeEnabled
        onOpenChange={vi.fn()}
      />,
    )

    await act(async () => { await Promise.resolve() })
    expect(api.listAgentTrajectory).not.toHaveBeenCalled()

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
    expect(api.listAgentTrajectory).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('trajectory-running-indicator')).toHaveClass('animate-spin')
    expect(screen.getByTestId('trajectory-running-indicator')).toHaveAttribute('aria-label', '运行中')
    expect(screen.queryByRole('heading', { name: 'Agent 运行轨迹' })).not.toBeInTheDocument()
    expect(screen.queryByText('运行轨迹加载中…')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(api.listAgentTrajectory).toHaveBeenCalledTimes(2)

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
    expect(api.listAgentTrajectory).toHaveBeenCalledTimes(2)
  })

  it('keeps existing event nodes when a refresh appends new events', async () => {
    api.listAgentTrajectory
      .mockResolvedValueOnce({ session_key: 'chat:7', events: [firstEvent], next_sequence: 1, has_more: false, is_running: true, last_error: null, unsupported_format: false })
      .mockResolvedValueOnce({ session_key: 'chat:7', events: [firstEvent, secondEvent], next_sequence: 2, has_more: false, is_running: false, last_error: null, unsupported_format: false })

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
