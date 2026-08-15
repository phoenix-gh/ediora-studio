// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { YoutubeVideo } from '@/lib/api/youtube'
import { YoutubeClient } from './YoutubeClient'

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

const readyVideo: YoutubeVideo = {
  id: 'ready-video',
  channel_id: 'channel-1',
  channel_name: '频道',
  title: '已有逐字稿',
  url: 'https://www.youtube.com/watch?v=ready-video',
  thumbnail_url: '',
  description: '',
  views: 0,
  published_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
  collected_at: '2026-08-10T00:00:00Z',
  transcript_status: 'ready',
  transcript_source: 'manual',
  transcript_language: 'zh-Hans',
  transcript_error_code: '',
  transcript_error: '',
  response_item_id: null,
  analysis_status: null,
}

describe('YoutubeClient transcript integration', () => {
  it('shows the transcript action alongside the existing analysis action', () => {
    render(<YoutubeClient initialChannels={[]} initialVideos={[readyVideo]} />)

    expect(screen.getByRole('button', { name: '逐字稿' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提取字幕并分析' })).toBeInTheDocument()
  })
})
