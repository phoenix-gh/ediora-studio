// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ContentJob } from '@/lib/api/jobs'
import { CreationJobPanel } from './CreationJobPanel'

vi.mock('@/lib/api/jobs', () => ({
  getJobAgentLog: vi.fn().mockResolvedValue({ execution: null, messages: [], tools: [] }),
}))

const job: ContentJob = {
  id: 940,
  flow: 'manual_topic',
  title: '手动创作任务',
  status: 'failed',
  created_at: '2026-08-05T12:02:00Z',
  started_at: '2026-08-05T12:02:01Z',
  completed_at: '2026-08-05T12:03:00Z',
  steps: [{
    id: 1, key: 'generate', attempt: 1, status: 'failed', output: {},
    error: '模型暂时不可用', retryable: true, created_at: '2026-08-05T12:02:00Z',
    started_at: '2026-08-05T12:02:01Z', completed_at: '2026-08-05T12:03:00Z',
  }],
  events: [{ id: 1, kind: 'step_failed', payload: { reason: 'timeout' }, created_at: '2026-08-05T12:03:00Z' }],
}

describe('CreationJobPanel', () => {
  it('opens generic Job details in a dialog and exposes retry', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    render(<CreationJobPanel jobs={[job]} onRetry={onRetry} onCancel={onCancel} />)

    expect(screen.getByRole('heading', { name: '全部任务' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('模型暂时不可用')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledWith(job.id, 'generate')
  })
})
