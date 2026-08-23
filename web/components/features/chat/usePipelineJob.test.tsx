// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContentJob } from '@/lib/api/jobs'
import { usePipelineJob } from './usePipelineJob'

const jobs = vi.hoisted(() => ({
  getJob: vi.fn(),
  getJobEvents: vi.fn(),
}))

vi.mock('@/lib/api/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/jobs')>('@/lib/api/jobs')
  return { ...actual, getJob: jobs.getJob, getJobEvents: jobs.getJobEvents }
})

function makeJob(status: ContentJob['status']): ContentJob {
  return {
    id: 81,
    flow: 'skill_pipeline',
    title: 'Pipeline',
    status,
    created_at: '2026-08-23T08:00:00Z',
    started_at: null,
    completed_at: null,
    plan_version: 1,
    run_epoch: 1,
    steps: [],
    events: [{ id: 4, kind: 'pipeline_created', payload: {}, created_at: '2026-08-23T08:00:00Z' }],
    pipeline: {
      plan: { version: 1, objective: '目标', stages: [] },
      stages: [],
      artifacts: [],
    },
  }
}

function Harness({ initialJob }: { initialJob?: ContentJob }) {
  const state = usePipelineJob(81, initialJob)
  return <>
    <output data-testid="status">{state.job?.status ?? 'loading'}</output>
    <output data-testid="cursor">{state.nextAfter}</output>
    <button type="button" onClick={() => void state.refresh()}>手动刷新</button>
  </>
}

describe('usePipelineJob', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    jobs.getJobEvents.mockResolvedValue({ events: [], next_after: 7 })
  })

  it('loads the durable job, advances the event cursor, and polls active jobs', async () => {
    jobs.getJob.mockResolvedValueOnce(makeJob('queued')).mockResolvedValueOnce(makeJob('running'))
    render(<Harness initialJob={makeJob('queued')} />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(jobs.getJob).toHaveBeenCalledWith(81)
    expect(jobs.getJobEvents).toHaveBeenCalledWith(81, 4)
    expect(screen.getByTestId('cursor')).toHaveTextContent('7')

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(jobs.getJob).toHaveBeenCalledTimes(2)
    expect(jobs.getJobEvents).toHaveBeenLastCalledWith(81, 7)
    expect(screen.getByTestId('status')).toHaveTextContent('running')
  })

  it('stops polling after a terminal job and still supports manual refresh', async () => {
    jobs.getJob.mockResolvedValue(makeJob('succeeded'))
    render(<Harness initialJob={makeJob('succeeded')} />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(6_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(jobs.getJob).toHaveBeenCalledTimes(1)

    await act(async () => {
      screen.getByRole('button', { name: '手动刷新' }).click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(jobs.getJob).toHaveBeenCalledTimes(2)
  })
})
