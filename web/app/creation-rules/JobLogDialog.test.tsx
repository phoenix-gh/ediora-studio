// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentJob } from '@/lib/api/jobs'
import { JobLogDialog } from './JobLogDialog'

const api = vi.hoisted(() => ({
  listAgentTrajectory: vi.fn(),
}))
const developerMode = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/lib/api/jobs', () => ({}))
vi.mock('@/lib/ai/agent-log-client', () => ({
  listAgentTrajectory: api.listAgentTrajectory,
}))
vi.mock('@/components/providers/DeveloperModeProvider', () => ({
  useDeveloperMode: () => developerMode.enabled,
}))

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

const agentEvents = [
  { seq: 1, time: 1_000, type: 'turn/start' as const, turn: 1, step: null, data: { turn: 1 } },
  { seq: 2, time: 2_000, type: 'assistant/message' as const, turn: 1, step: 1, data: { turn: 1, step: 1, blocks: [{ kind: 'text', text: '模型回复内容' }] } },
  { seq: 3, time: 3_000, type: 'turn/end' as const, turn: 1, step: null, data: { reason: { kind: 'completed' } } },
]

describe('JobLogDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    developerMode.enabled = true
    api.listAgentTrajectory.mockResolvedValue({
      session_key: 'execution:55',
      events: agentEvents,
      next_sequence: 3,
      has_more: false,
      is_running: false,
      last_error: null,
      unsupported_format: false,
    })
  })

  it('hides developer tabs and does not fetch agent logs when developer mode is off', () => {
    developerMode.enabled = false

    render(<JobLogDialog job={job} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    expect(screen.getByRole('tab', { name: '任务概览' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '执行时间线' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Agent 运行轨迹' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'AI 完整消息' })).not.toBeInTheDocument()
    expect(api.listAgentTrajectory).not.toHaveBeenCalled()
  })

  it('uses the overview timeline trace order and opens on the overview', async () => {
    render(<JobLogDialog job={job} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['任务概览', '执行时间线', 'Agent 运行轨迹'])
    expect(screen.getByRole('tab', { name: '任务概览' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('dialog')).toHaveClass(
      'h-[min(720px,calc(100dvh-2rem))]',
      'min-h-[min(520px,calc(100dvh-2rem))]',
      'max-h-[calc(100dvh-2rem)]',
    )
    await waitFor(() => expect(api.listAgentTrajectory).toHaveBeenCalledWith({ job_id: job.id }, null, 500))

    fireEvent.click(screen.getByRole('tab', { name: 'Agent 运行轨迹' }))
    expect(await screen.findByText('模型回复内容')).toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('step_failed')

    fireEvent.click(screen.getByRole('tab', { name: '执行时间线' }))

    const event = await screen.findByText('step_failed')
    expect(event.closest('details')).not.toHaveAttribute('open')
  })

  it('keeps the overview panel out of the shared vertical scroll container', async () => {
    render(<JobLogDialog job={job} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Agent 运行轨迹' }))
    expect(screen.getByTestId('job-log-agent-panel')).toHaveClass('overflow-hidden')

    fireEvent.click(screen.getByRole('tab', { name: '任务概览' }))

    expect(screen.getByTestId('job-log-dialog-body')).not.toHaveClass('overflow-y-auto')
    expect(screen.getByTestId('job-log-overview-panel')).toHaveClass('flex-1', 'overflow-y-auto')
  })

  it('shows completed task token usage in the overview', () => {
    const tokenUsageJob = {
      ...job,
      status: 'succeeded' as const,
      token_usage: {
        input_tokens: 12_345,
        output_tokens: 678,
        total_tokens: 13_023,
        request_count: 4,
      },
    } as ContentJob

    render(<JobLogDialog job={tokenUsageJob} open onOpenChange={vi.fn()} onRetry={vi.fn()} />)

    expect(screen.getByText('Token 消耗')).toBeInTheDocument()
    expect(screen.getByText(/输入 12,345/)).toBeInTheDocument()
    expect(screen.getByText(/输出 678/)).toBeInTheDocument()
    expect(screen.getByText(/总计 13,023/)).toBeInTheDocument()
    expect(screen.getByText(/4 次模型请求/)).toBeInTheDocument()
  })
})
