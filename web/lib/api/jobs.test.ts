import { describe, expect, it } from 'vitest'

import { imageUrlsForJob } from './jobs'

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
