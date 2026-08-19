// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { AgentLogTimeline } from './AgentLogTimeline'

const events = [
  {
    id: 1, sequence: 1, stream_kind: 'chat' as const, stream_key: 'chat:12',
    session_id: 12, job_id: null, execution_id: null, turn_id: 'turn-1', step_id: null,
    event_type: 'session/turn-start', phase: 'chat', status: 'running',
    payload: { kind: 'user-message' }, usage: null, duration_ms: null,
    created_at: '2026-08-19T00:00:00.000Z',
  },
  {
    id: 2, sequence: 2, stream_kind: 'chat' as const, stream_key: 'chat:12',
    session_id: 12, job_id: null, execution_id: null, turn_id: 'turn-1', step_id: null,
    event_type: 'llm/response', phase: 'execute', status: 'completed',
    payload: { text: 'answer' }, usage: { inputTokens: 2 }, duration_ms: 120,
    created_at: '2026-08-19T00:00:01.000Z',
  },
]

describe('AgentLogTimeline', () => {
  it('renders typed events with collapsed payload details', () => {
    render(<AgentLogTimeline events={events} loading={false} error="" />)

    expect(screen.getByRole('heading', { name: 'Agent 运行轨迹' })).toBeInTheDocument()
    expect(screen.getByText('开始会话')).toBeInTheDocument()
    expect(screen.getByText('LLM 响应')).toBeInTheDocument()
    expect(screen.getAllByText(/answer/).length).toBeGreaterThan(0)
    expect(screen.getByText(/输入 2 tokens/)).toBeInTheDocument()
  })

  it('shows loading, error, and empty states', () => {
    const { rerender } = render(<AgentLogTimeline events={[]} loading={true} error="" />)
    expect(screen.getByText('运行轨迹加载中…')).toBeInTheDocument()

    rerender(<AgentLogTimeline events={[]} loading={false} error="加载失败" />)
    expect(screen.getByRole('alert')).toHaveTextContent('加载失败')

    rerender(<AgentLogTimeline events={[]} loading={false} error="" />)
    expect(screen.getByText('暂无 Agent 事件记录')).toBeInTheDocument()
  })
})
