// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreationDashboardRun, CreationSchedulerLog } from '@/lib/api/creation-rules'
import { CreationRunLog } from './CreationRunLog'

const api = vi.hoisted(() => ({
  getCreationRunAgentLog: vi.fn().mockResolvedValue({
    execution: { id: 17, job_id: 931, status: 'failed', objective: 'create posts', phase: 'failed', error: '', created_at: null, updated_at: null, completed_at: null },
    messages: [{ id: 1, execution_id: 17, phase: 'execute', direction: 'model_request', payload: { messages: [{ role: 'user', content: 'create posts' }] }, created_at: '2026-08-05T12:00:30Z' }],
    tools: [],
  }),
}))

vi.mock('@/lib/api/creation-rules', () => ({ getCreationRunAgentLog: api.getCreationRunAgentLog }))

const run: CreationDashboardRun = {
  id: 7,
  rule_id: 1,
  content_job_id: 931,
  scheduled_for: '2026-08-05T12:00:00Z',
  trigger_kind: 'schedule',
  status: 'failed',
  requested_count: 3,
  created_count: 0,
  detail: {},
  rule: { name: '每日短帖', directory: '产品实验', directories: ['产品实验'] },
  created_at: '2026-08-05T12:00:00Z',
  agent_execution: {
    status: 'failed',
    phase: 'failed',
    skill_name: null,
    skill_activation: '',
    loaded_references: [],
    tools: [{ tool_name: 'save_daily_creation_outputs', status: 'failed', auto_approved: true, occurred_at: '2026-08-05T12:01:00Z', error: '字段不匹配' }],
    self_validation: {},
    completion: null,
  },
  job: {
    id: 931,
    status: 'failed',
    started_at: '2026-08-05T12:00:00Z',
    completed_at: '2026-08-05T12:01:00Z',
    steps: [{ key: 'agent', attempt: 1, status: 'failed', started_at: '2026-08-05T12:00:00Z', completed_at: '2026-08-05T12:01:00Z', error: '字段不匹配' }],
    events: [],
  },
}

const logs: CreationSchedulerLog[] = [{
  status: 'error', message: '每日创作失败', detail: '字段不匹配', created_at: '2026-08-05T12:01:00Z',
}]

describe('CreationRunLog', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('labels a cancelled creation run in Chinese', () => {
    render(<CreationRunLog runs={[{
      ...run,
      status: 'cancelled',
      job: run.job ? { ...run.job, status: 'cancelled' } : null,
    }]} schedulerLogs={[]} />)

    expect(screen.getByText('已取消')).toBeInTheDocument()
  })

  it('hides Agent details and skips the debug log request when developer mode is off', () => {
    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', '0')

    render(<CreationRunLog runs={[run]} schedulerLogs={logs} />)
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }))

    expect(screen.getByRole('dialog')).not.toHaveTextContent('save_daily_creation_outputs')
    expect(screen.getByRole('dialog')).not.toHaveTextContent('AI 完整消息')
    expect(api.getCreationRunAgentLog).not.toHaveBeenCalled()
  })

  it('expands a failed run with job steps, agent tools and scheduler logs', async () => {
    render(<CreationRunLog runs={[run]} schedulerLogs={logs} />)

    expect(screen.getByRole('heading', { name: '运行日志' })).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.textContent === 'Job #931')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看日志' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('字段不匹配')
    expect(screen.getByRole('dialog')).toHaveTextContent('save_daily_creation_outputs')
    expect(screen.getByRole('dialog')).toHaveTextContent('每日创作失败')
    expect(await screen.findByText('AI 完整消息')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('create posts'))
  })
})
