import { afterEach, describe, expect, it, vi } from 'vitest'

import { getYoutubeTranscript } from './youtube'

describe('getYoutubeTranscript', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads the complete transcript only from the selected video endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ready',
      source: 'manual',
      language: 'zh-Hans',
      text: '第一段 第二段',
      segments: [
        { start: 0.4, end: 2.1, text: '第一段' },
        { start: 2.1, end: 4.8, text: '第二段' },
      ],
      content_hash: 'hash-1',
      fetched_at: '2026-08-11T02:00:00Z',
      error_code: '',
      error: '',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const transcript = await getYoutubeTranscript('video/id')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/youtube/videos/video%2Fid/transcript',
      expect.objectContaining({
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    expect(transcript.segments[1]).toEqual({ start: 2.1, end: 4.8, text: '第二段' })
  })
})
