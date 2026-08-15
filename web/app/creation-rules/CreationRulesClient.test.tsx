// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getCreationDashboard: vi.fn().mockResolvedValue({
    date: '2026-08-05',
    summary: {
      enabled_rules: 1,
      scheduled_runs: 1,
      queued: 0,
      running: 0,
      succeeded: 0,
      partial: 0,
      failed: 1,
      cancelled: 0,
      next_run_at: '2026-08-06T01:30:00Z',
    },
    rules: [{
      id: 1,
      name: '每日短帖',
      asset_type: 'article',
      directory: '产品实验',
      directories: ['产品实验'],
      output_type: 'x_short_post',
      target_count: 3,
      execution_mode: 'recurring',
      scheduled_date: null,
      scheduled_time: '09:30',
      timezone: 'Asia/Shanghai',
      lookback_days: 5,
      delivery_mode: 'drafts',
      account_id: null,
      instructions: '',
      prompt: '围绕产品实验写一条有证据的中文 X 短帖。',
      skill_mode: 'auto',
      skill_name: null,
      enabled: true,
      last_run_at: null,
      next_run_at: '2026-08-06T01:30:00Z',
      created_at: '2026-08-05T00:00:00Z',
      updated_at: '2026-08-05T00:00:00Z',
    }],
    runs: [{
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
    }],
    scheduler_logs: [{ status: 'error', message: '每日创作失败', detail: '字段不匹配', created_at: '2026-08-05T12:01:00Z' }],
  }),
  createCreationRule: vi.fn(),
  updateCreationRule: vi.fn(),
  deleteCreationRule: vi.fn(),
  runCreationRule: vi.fn(),
  getCreationRunAgentLog: vi.fn().mockResolvedValue({ execution: null, messages: [], tools: [] }),
  listCreativeAssetDirectories: vi.fn().mockResolvedValue([]),
  listChatSkills: vi.fn().mockResolvedValue([]),
}))

const jobsApi = vi.hoisted(() => ({
  listJobs: vi.fn().mockResolvedValue({ jobs: [{
    id: 940,
    flow: 'manual_topic',
    title: '手动创作任务',
    status: 'running',
    created_at: '2026-08-05T12:02:00Z',
    started_at: '2026-08-05T12:02:01Z',
    completed_at: null,
    steps: [{ id: 1, key: 'generate', attempt: 1, status: 'running', output: {}, error: '', retryable: false, created_at: '2026-08-05T12:02:00Z', started_at: '2026-08-05T12:02:01Z', completed_at: null }],
    events: [],
  }], next_cursor: null, has_more: false }),
  cancelJob: vi.fn(),
  retryJobStep: vi.fn(),
  getJobAgentLog: vi.fn().mockResolvedValue({ execution: null, messages: [], tools: [] }),
}))

vi.mock('@/lib/api/creation-rules', () => api)
vi.mock('@/lib/api/jobs', () => jobsApi)
vi.mock('@/lib/api/assets', () => ({ listCreativeAssetDirectories: api.listCreativeAssetDirectories }))
vi.mock('@/lib/api/chat', () => ({ listChatSkills: api.listChatSkills }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { CreationRulesClient } from './CreationRulesClient'

describe('CreationRulesClient', () => {
  it('shows the task board dashboard and execution logs', async () => {
    render(<CreationRulesClient />)

    expect(await screen.findByRole('heading', { name: '任务看板' })).toBeInTheDocument()
    expect(await screen.findByText('今日运行')).toBeInTheDocument()
    expect(screen.getByText('执行中 / 排队中')).toBeInTheDocument()
    expect(screen.getByText('成功 / 失败')).toBeInTheDocument()
    expect(screen.getByText('部分完成 / 已取消')).toBeInTheDocument()
    expect(screen.queryByText('今日计划')).not.toBeInTheDocument()
    expect(screen.queryByText('今日产出')).not.toBeInTheDocument()
    expect(screen.queryByText(/共计划|目标 \d+ 条/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '创作规则' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '任务日志' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '运行日志' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '全部任务' })).not.toBeInTheDocument()
    expect(await screen.findByText('手动创作任务')).toBeInTheDocument()
    expect(screen.getByText('上次执行：尚未执行')).toBeInTheDocument()
    const promptSummary = screen.getByText('围绕产品实验写一条有证据的中文 X 短帖。')
    expect(promptSummary).toHaveClass('line-clamp-2')
    const ruleCard = promptSummary.closest('[data-slot="card"]')
    expect(ruleCard).not.toBeNull()
    expect(ruleCard).not.toHaveTextContent('产品实验 · 3 条')
    expect(ruleCard).not.toHaveTextContent('去重 5 天')
    expect(ruleCard).not.toHaveTextContent('Skill：自动匹配')
    expect(screen.getByText('最新状态：失败')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '查看日志' })[0])
    expect(screen.getByRole('dialog')).toHaveTextContent('手动创作任务')
    expect(api.getCreationDashboard).toHaveBeenCalledOnce()
  })
})
