// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getYoutubeTranscript, type YoutubeVideo } from '@/lib/api/youtube'
import {
  buildYoutubeTimestampUrl,
  formatTranscriptTime,
  YoutubeTranscriptDialog,
} from './YoutubeTranscriptDialog'

vi.mock('@/lib/api/youtube', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/youtube')>()
  return { ...actual, getYoutubeTranscript: vi.fn() }
})

const video: YoutubeVideo = {
  id: 'video-1',
  channel_id: 'channel-1',
  channel_name: '频道',
  title: '测试视频',
  url: 'https://www.youtube.com/watch?v=video-1&list=abc',
  thumbnail_url: '',
  description: '',
  views: 1,
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

const timestampedTranscript = {
  status: 'ready',
  source: 'manual',
  language: 'zh-Hans',
  text: '第一段\n第二段',
  segments: [
    { start: 0, end: 2, text: '第一段' },
    { start: 65.9, end: 70, text: '第二段' },
  ],
  content_hash: 'hash',
  fetched_at: '2026-08-11T02:00:00Z',
  error_code: '',
  error: '',
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: vi.fn(() => []),
  })
})

describe('YoutubeTranscriptDialog', () => {
  beforeEach(() => vi.mocked(getYoutubeTranscript).mockReset())

  it('formats timestamps and preserves existing YouTube query parameters', () => {
    expect(formatTranscriptTime(65.9)).toBe('01:05')
    expect(buildYoutubeTimestampUrl(video.url, 65.9)).toBe(
      'https://www.youtube.com/watch?v=video-1&list=abc&t=65',
    )
    expect(buildYoutubeTimestampUrl(video.url, -1)).toBeNull()
    expect(buildYoutubeTimestampUrl('not-a-url', 10)).toBeNull()
  })

  it('does not expose the viewer before a transcript is ready', () => {
    render(<YoutubeTranscriptDialog video={{ ...video, transcript_status: 'failed' }} />)

    expect(screen.queryByRole('button', { name: '逐字稿' })).not.toBeInTheDocument()
  })

  it('loads only after opening and renders timestamped segments', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue(timestampedTranscript)
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    expect(getYoutubeTranscript).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '逐字稿' }))

    expect(await screen.findByRole('dialog')).toHaveTextContent('测试视频')
    expect(getYoutubeTranscript).toHaveBeenCalledOnce()
    expect(getYoutubeTranscript).toHaveBeenCalledWith('video-1')
    expect(screen.getByRole('link', { name: '01:05' })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=video-1&list=abc&t=65',
    )
    expect(screen.getByText('第二段')).toBeInTheDocument()
  })

  it('copies the exact full transcript text', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue(timestampedTranscript)
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    await screen.findByText('第二段')
    await user.click(screen.getByRole('button', { name: '复制全文' }))

    expect(writeText).toHaveBeenCalledWith('第一段\n第二段')
  })

  it('falls back to the complete plain text when segments are absent', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue({
      ...timestampedTranscript,
      source: '',
      language: '',
      text: '纯文本逐字稿',
      segments: [],
    })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))

    expect(await screen.findByText('纯文本逐字稿')).toBeInTheDocument()
    expect(screen.getByText('未知语言 · 未知来源')).toBeInTheDocument()
  })

  it('reports failed loads and retries the same video', async () => {
    vi.mocked(getYoutubeTranscript)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ...timestampedTranscript, text: '重试成功', segments: [] })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={{ ...video, id: 'video-2' }} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByText('逐字稿加载失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新加载' }))

    expect(await screen.findByText('重试成功')).toBeInTheDocument()
    expect(getYoutubeTranscript).toHaveBeenNthCalledWith(2, 'video-2')
  })

  it('shows an explicit empty state for a ready transcript without content', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue({
      ...timestampedTranscript,
      text: '',
      segments: [],
    })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))

    expect(await screen.findByText('逐字稿内容为空')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制全文' })).toBeDisabled()
  })
})
