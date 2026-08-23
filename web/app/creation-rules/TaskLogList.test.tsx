// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listJobs: vi.fn(),
}))

vi.mock('@/lib/api/jobs', () => ({ listJobs: api.listJobs }))
vi.mock('./JobLogDialog', () => ({
  JobLogDialog: ({ job, open }: { job: { title: string } | null; open: boolean }) => (
    open ? <div role="dialog">详情：{job?.title}</div> : null
  ),
}))

import { TaskLogList } from './TaskLogList'

const job = (id: number, title: string, flow = 'daily_creation', triggerKind = 'schedule') => ({
  id,
  flow,
  title,
  status: 'queued' as const,
  created_at: `2026-08-06T0${id}:00:00Z`,
  started_at: null,
  completed_at: null,
  input: {},
  schedule: flow === 'daily_creation' ? {
    run_id: id,
    rule_name: '每日短帖',
    trigger_kind: triggerKind,
    scheduled_for: '2026-08-06T01:30:00Z',
  } : null,
  steps: [],
  events: [],
})

describe('TaskLogList', () => {
  beforeEach(() => {
    api.listJobs.mockReset()
  })

  it('loads one unified task log list and appends the next cursor page', async () => {
    api.listJobs
      .mockResolvedValueOnce({ jobs: [job(1, '定时短帖')], next_cursor: 'next-1', has_more: true })
      .mockResolvedValueOnce({
        jobs: [job(2, '手动执行固定规则', 'daily_creation', 'explicit')],
        next_cursor: null,
        has_more: false,
      })

    render(<TaskLogList refreshToken={0} onRetry={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('定时短帖')).toBeInTheDocument()
    expect(screen.getAllByText('固定任务').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))

    expect(await screen.findByText('手动执行固定规则')).toBeInTheDocument()
    expect(api.listJobs).toHaveBeenLastCalledWith({ limit: 30, cursor: 'next-1', kind: 'scheduled' })
    expect(screen.getByText('已加载全部任务')).toBeInTheDocument()
  })

  it('keeps the fixed-rule scope when the user changes the status filter', async () => {
    api.listJobs
      .mockResolvedValueOnce({ jobs: [job(1, '全部状态')], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ jobs: [job(2, '失败任务')], next_cursor: null, has_more: false })

    render(<TaskLogList refreshToken={0} onRetry={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('全部状态')).toBeInTheDocument()
    expect(screen.queryByLabelText('任务类型')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'failed' } })

    expect(await screen.findByText('失败任务')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '全部状态' })).not.toBeInTheDocument()
    expect(api.listJobs).toHaveBeenLastCalledWith({ limit: 30, kind: 'scheduled', status: 'failed' })
  })

  it('opens the task detail dialog from a unified row', async () => {
    api.listJobs.mockResolvedValueOnce({ jobs: [job(1, '可查看任务')], next_cursor: null, has_more: false })

    render(<TaskLogList refreshToken={0} onRetry={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '查看日志' }))

    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('可查看任务'))
  })
})
