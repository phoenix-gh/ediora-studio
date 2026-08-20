// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentJob } from '@/lib/api/jobs'
import { JobLogDialog } from './JobLogDialog'

const api = vi.hoisted(() => ({
  getJobAgentLog: vi.fn(),
  listAllAgentLogEvents: vi.fn(),
}))

vi.mock('@/lib/api/jobs', () => ({ getJobAgentLog: api.getJobAgentLog }))
vi.mock('@/lib/ai/agent-log-client', () => ({ listAllAgentLogEvents: api.listAllAgentLogEvents }))

const job: ContentJob = {
  id: 123,
  flow: 'daily_creation',
  title: '开发者模式日志任务',
  status: 'failed',
  created_at: '2026-08-20T08:00:00Z',
  started_at: '2026-08-20T08:00:01Z',
  completed_at: '2026-08-20T08:01:00Z',
  steps: [{
    id: 1,
    key: 'agent',
    attempt: 1,
    status: 'failed',
    output: {},
    error: '模型失败',
    retryable: true,
    created_at: '2026-08-20T08:00:00Z',
    started_at: '2026-08-20T08:00:01Z',
    completed_at: '2026-08-20T08:01:00Z',
  }],
  events: [{
    id: 9,
    kind: 'step_failed',
    payload: { reason: 'timeout-secret' },
    created_at: '2026-08-20T08:01:00Z',
  }],
}

const agentEvents = [{
  id: 1,
  sequence: 1,
  stream_kind: 'job' as const,
  stream_key: 'execution:123',
  session_id: null,
  job_id: 123,
  execution_id: 55,
  turn_id: null,
  step_id: null,
  event_type: 'llm/response',
  phase: 'execute',
  status: 'completed',
  payload: { text: '模型回复内容' },
  usage: { inputTokens: 10, outputTokens: 4 },
  duration_ms: 320,
  created_at: '2026-08-20T08:00:10Z',
}]

const legacyLog = {
  execution: null,
  messages: [{
    id: 1,
    execution_id: 55,
    phase: 'execute',
    direction: 'model_response' as const,
    payload: { text: '完整模型消息' },
    created_at: '2026-08-20T08:00:10Z',
  }],
  tools: [],
}

describe('JobLogDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', '1')
    api.getJobAgentLog.mockResolvedValue(legacyLog)
    api.listAllAgentLogEvents.mockResolvedValue({ events: agentEvents, has_more: false, next_sequence: null })
  })

  it('hides developer tabs and does not fetch agent logs when developer mode is off', () => {
    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', '0')

    render(<JobLogDialog job={job} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    expect(screen.getByRole('tab', { name: '任务概览' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Agent 运行轨迹' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'AI 完整消息' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '执行事件' })).not.toBeInTheDocument()
    expect(api.listAllAgentLogEvents).not.toHaveBeenCalled()
    expect(api.getJobAgentLog).not.toHaveBeenCalled()
  })

  it('opens on the agent trajectory and keeps execution events behind a collapsed tab', async () => {
    render(<JobLogDialog job={job} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    expect(await screen.findByText('LLM 响应')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Agent 运行轨迹' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('step_failed')
    expect(api.listAllAgentLogEvents).toHaveBeenCalledWith({ job_id: job.id, limit: 500 })
    expect(api.getJobAgentLog).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: '执行事件' }))

    const event = await screen.findByText('step_failed')
    expect(event.closest('details')).not.toHaveAttribute('open')
  })

  it('loads legacy full messages only after opening the AI message tab', async () => {
    render(<JobLogDialog job={job} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    expect(await screen.findByText('LLM 响应')).toBeInTheDocument()
    expect(api.getJobAgentLog).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'AI 完整消息' }))

    expect(await screen.findByRole('heading', { name: 'AI 完整消息' })).toBeInTheDocument()
    expect(api.getJobAgentLog).toHaveBeenCalledWith(job.id)
    fireEvent.click(await screen.findByText('模型 → AI'))
    expect(await screen.findByText(/完整模型消息/)).toBeInTheDocument()
  })
})
