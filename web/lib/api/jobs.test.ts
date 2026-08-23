import { describe, expect, it, vi } from 'vitest'

import { cancelPipeline, confirmPipeline, getJobEvents, imageUrlsForJob, listJobs, rerunPipelineStage, revisePipeline, retryPipelineStage } from './jobs'

describe('job list compatibility', () => {
  it('normalizes legacy Skill Pipeline list items without top-level steps', async () => {
    const pipelineStage = {
      id: 811,
      key: 'skill:01:source-research',
      attempt: 1,
      status: 'running',
      input: {},
      output: {},
      error: '',
      retryable: false,
      artifacts: [],
      created_at: '2026-08-23T10:00:00Z',
      started_at: '2026-08-23T10:00:01Z',
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      jobs: [{
        id: 81,
        flow: 'skill_pipeline',
        title: 'Pipeline',
        status: 'running',
        created_at: '2026-08-23T10:00:00Z',
        started_at: '2026-08-23T10:00:01Z',
        completed_at: null,
        pipeline: { plan: { version: 1, objective: '写文章', stages: [] }, stages: [pipelineStage], artifacts: [] },
        events: [],
      }],
      next_cursor: null,
      has_more: false,
    }), { status: 200 })))

    const page = await listJobs()

    expect(page.jobs[0].steps).toEqual([pipelineStage])
  })
})

describe('image job results', () => {
  it('returns absolute asset URLs from succeeded image job steps', () => {
    expect(imageUrlsForJob({
      id: 24,
      flow: 'cover',
      title: 'Chat 封面',
      status: 'succeeded',
      created_at: '2026-07-23T15:03:36Z',
      started_at: '2026-07-23T15:03:37Z',
      completed_at: '2026-07-23T15:05:06Z',
      events: [],
      steps: [{
        id: 28,
        key: 'cover',
        attempt: 1,
        status: 'succeeded',
        output: { asset_urls: ['/api/uploads/cover.png'] },
        error: '',
        retryable: false,
        created_at: '2026-07-23T15:03:37Z',
        started_at: '2026-07-23T15:03:37Z',
        completed_at: '2026-07-23T15:05:06Z',
      }],
    })).toEqual(['http://localhost:8000/api/uploads/cover.png'])
  })

  it('returns the asset URL from an independent image job', () => {
    expect(imageUrlsForJob({
      id: 25,
      flow: 'standalone_image',
      title: 'Chat 独立生图',
      status: 'succeeded',
      created_at: '2026-07-25T01:00:00Z',
      started_at: '2026-07-25T01:00:01Z',
      completed_at: '2026-07-25T01:00:02Z',
      events: [],
      steps: [{
        id: 29,
        key: 'standalone_image',
        attempt: 1,
        status: 'succeeded',
        output: { asset_url: '/api/uploads/chat-image.png' },
        error: '',
        retryable: false,
        created_at: '2026-07-25T01:00:01Z',
        started_at: '2026-07-25T01:00:01Z',
        completed_at: '2026-07-25T01:00:02Z',
      }],
    })).toEqual(['http://localhost:8000/api/uploads/chat-image.png'])
  })
})

describe('Skill Pipeline job commands', () => {
  it('uses versioned idempotent command endpoints and exposes the event cursor', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push([input, init])
      return new Response(JSON.stringify({ id: 81, plan_version: 2, events: [], next_after: 4 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await confirmPipeline(81, 1, 'confirm-1')
    await revisePipeline(81, 1, 'revise-1', { 'skill:01:article-drafting': '先列提纲' })
    await cancelPipeline(81, 'cancel-1')
    await retryPipelineStage(81, 'skill:01:article-drafting', 'retry-1')
    await rerunPipelineStage(81, 'skill:01:article-drafting', 'rerun-1')
    await getJobEvents(81, 3)

    expect(calls.map(([url]) => url)).toEqual([
      'http://localhost:8000/api/jobs/81/confirm',
      'http://localhost:8000/api/jobs/81/plan/revise',
      'http://localhost:8000/api/jobs/81/cancel',
      'http://localhost:8000/api/jobs/81/stages/skill%3A01%3Aarticle-drafting/retry',
      'http://localhost:8000/api/jobs/81/stages/skill%3A01%3Aarticle-drafting/rerun',
      'http://localhost:8000/api/jobs/81/events?after=3',
    ])
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ plan_version: 1, request_id: 'confirm-1' })
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      plan_version: 1,
      request_id: 'revise-1',
      stage_instructions: { 'skill:01:article-drafting': '先列提纲' },
    })
    expect(JSON.parse(calls[2][1]?.body as string)).toEqual({ request_id: 'cancel-1' })
  })
})
