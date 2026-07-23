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
})
