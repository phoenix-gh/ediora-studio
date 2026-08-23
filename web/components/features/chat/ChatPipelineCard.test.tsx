// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContentJob } from '@/lib/api/jobs'
import { ChatPipelineCard } from './ChatPipelineCard'

const jobs = vi.hoisted(() => ({
  cancelPipeline: vi.fn(),
  confirmPipeline: vi.fn(),
  rerunPipelineStage: vi.fn(),
  revisePipeline: vi.fn(),
  retryPipelineStage: vi.fn(),
}))

vi.mock('@/lib/api/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/jobs')>('@/lib/api/jobs')
  return {
    ...actual,
    cancelPipeline: jobs.cancelPipeline,
    confirmPipeline: jobs.confirmPipeline,
    rerunPipelineStage: jobs.rerunPipelineStage,
    revisePipeline: jobs.revisePipeline,
    retryPipelineStage: jobs.retryPipelineStage,
  }
})

const dates = {
  created_at: '2026-08-23T08:00:00Z',
  started_at: null,
  completed_at: null,
}

function stage(key: string, status: ContentJob['status'], overrides: Record<string, unknown> = {}) {
  return {
    id: key === 'skill:01:research' ? 1 : 2,
    key,
    attempt: 1,
    status,
    input: {},
    output: {},
    error: '',
    retryable: false,
    artifacts: [],
    ...dates,
    ...overrides,
  }
}

function job(overrides: Partial<ContentJob> = {}): ContentJob {
  return {
    id: 81,
    flow: 'skill_pipeline',
    title: '写一篇 AI 文章',
    status: 'awaiting_confirmation',
    created_at: dates.created_at,
    started_at: null,
    completed_at: null,
    plan_version: 1,
    run_epoch: 1,
    steps: [],
    events: [],
    pipeline: {
      plan: {
        version: 1,
        objective: '写一篇 AI 文章',
        stages: [
          {
            position: 1,
            step_key: 'skill:01:research',
            invocation_id: 'one',
            skill_name: 'source-research',
            display_name: '资料研究',
            expected_output: '资料摘要',
            capability_profile: 'research',
            parameter_display_name: null,
            instruction: '检索一手资料',
          },
          {
            position: 2,
            step_key: 'skill:02:writing',
            invocation_id: 'two',
            skill_name: 'article-drafting',
            display_name: '文章写作',
            expected_output: '文章正文',
            capability_profile: 'writing',
            parameter_display_name: 'AI 产品观察',
            instruction: '按方案组织文章',
          },
        ],
      },
      stages: [stage('skill:01:research', 'queued'), stage('skill:02:writing', 'queued')],
      artifacts: [],
    },
    ...overrides,
  }
}

describe('ChatPipelineCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('request-1')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    jobs.confirmPipeline.mockResolvedValue(job({ status: 'queued' }))
    jobs.cancelPipeline.mockResolvedValue(job({ status: 'cancelled' }))
    jobs.retryPipelineStage.mockResolvedValue(job({ status: 'queued' }))
    jobs.rerunPipelineStage.mockResolvedValue(job({ status: 'queued' }))
    jobs.revisePipeline.mockResolvedValue(job({ plan_version: 2 }))
  })

  it('renders an awaiting-confirmation plan with ordered compact stages and actions', () => {
    render(<ChatPipelineCard initialJob={job()} onJobChange={vi.fn()} />)

    expect(screen.getByText('写一篇 AI 文章')).toBeInTheDocument()
    expect(screen.getByText('资料研究')).toBeInTheDocument()
    expect(screen.getByText('文章写作')).toBeInTheDocument()
    expect(screen.getByText(/AI 产品观察/)).toBeInTheDocument()
    expect(screen.getAllByText(/资料摘要/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/文章正文/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '开始执行' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '调整计划' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()

    const stages = screen.getAllByTestId('pipeline-stage')
    expect(stages[0]).toHaveAttribute('data-stage-key', 'skill:01:research')
    expect(stages[1]).toHaveAttribute('data-stage-key', 'skill:02:writing')
    expect(stages[0].querySelector('details')).toHaveAttribute('open', '')
    expect(stages[1].querySelector('details')).not.toHaveAttribute('open')
    expect(screen.queryByText('检索一手资料')).not.toBeInTheDocument()
  })

  it('sends confirmation, plan revision, and cancellation commands through the durable Job API', async () => {
    const onJobChange = vi.fn()
    render(<ChatPipelineCard initialJob={job()} onJobChange={onJobChange} />)

    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    expect(jobs.confirmPipeline).toHaveBeenCalledWith(81, 1, 'request-1')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: '调整计划' }))
    fireEvent.change(screen.getByLabelText('阶段调整说明'), { target: { value: '先核验资料，再开始写作' } })
    fireEvent.click(screen.getByRole('button', { name: '保存调整' }))
    expect(jobs.revisePipeline).toHaveBeenCalledWith(81, 1, 'request-1', { 'skill:01:research': '先核验资料，再开始写作' })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const cancelled = job()
    render(<ChatPipelineCard initialJob={cancelled} onJobChange={onJobChange} />)
    fireEvent.click(screen.getAllByRole('button', { name: '取消' })[0])
    expect(jobs.cancelPipeline).toHaveBeenCalledWith(81, 'request-1')
  })

  it('keeps failed evidence open and sends retry and rerun commands with request IDs', async () => {
    const failed = job({
      status: 'failed',
      completed_at: dates.created_at,
      pipeline: {
        ...job().pipeline!,
        stages: [
          stage('skill:01:research', 'succeeded', {
            output: { primary_artifact_id: 10 },
            artifacts: [{ id: 10, step_id: 1, attempt: 1, kind: 'research', role: 'primary', title: '资料摘要', text_content: '一手资料证据', structured_content: null, digest: 'a', status: 'active', created_at: dates.created_at }],
          }),
          stage('skill:02:writing', 'failed', { error: 'runtime adapter uncertain', retryable: true }),
        ],
        artifacts: [{ id: 10, step_id: 1, attempt: 1, kind: 'research', role: 'primary', title: '资料摘要', text_content: '一手资料证据', structured_content: null, digest: 'a', status: 'active', created_at: dates.created_at }],
      },
    })
    render(<ChatPipelineCard initialJob={failed} onJobChange={vi.fn()} />)

    const failedStage = screen.getAllByTestId('pipeline-stage')[1]
    expect(failedStage.querySelector('details')).toHaveAttribute('open', '')
    expect(screen.getByText('runtime adapter uncertain')).toBeInTheDocument()
    expect(screen.getByText(/不确定结果：/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试本 Stage' }))
    expect(jobs.retryPipelineStage).toHaveBeenCalledWith(81, 'skill:02:writing', 'request-1')

    const succeeded = job({
      status: 'succeeded',
      completed_at: dates.created_at,
      pipeline: {
        ...job().pipeline!,
        stages: [stage('skill:01:research', 'succeeded'), stage('skill:02:writing', 'succeeded')],
      },
    })
    render(<ChatPipelineCard initialJob={succeeded} onJobChange={vi.fn()} />)
    fireEvent.click(screen.getAllByRole('button', { name: '重新运行' })[0])
    expect(jobs.rerunPipelineStage).toHaveBeenCalledWith(81, 'skill:01:research', 'request-1')
  })

  it('folds each artifact independently', () => {
    const withArtifact = job({
      status: 'succeeded',
      pipeline: {
        ...job().pipeline!,
        stages: [stage('skill:01:research', 'succeeded', {
          artifacts: [{ id: 10, step_id: 1, attempt: 1, kind: 'research', role: 'primary', title: '资料摘要', text_content: '一手资料证据', structured_content: null, digest: 'a', status: 'active', created_at: dates.created_at }],
        }), stage('skill:02:writing', 'succeeded')],
        artifacts: [{ id: 10, step_id: 1, attempt: 1, kind: 'research', role: 'primary', title: '资料摘要', text_content: '一手资料证据', structured_content: null, digest: 'a', status: 'active', created_at: dates.created_at }],
      },
    })
    render(<ChatPipelineCard initialJob={withArtifact} onJobChange={vi.fn()} />)
    const artifact = screen.getByText('产物：资料摘要').closest('details')
    expect(artifact).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('产物：资料摘要'))
    expect(artifact).toHaveAttribute('open', '')
    expect(screen.getByText('一手资料证据')).toBeInTheDocument()
  })
})
