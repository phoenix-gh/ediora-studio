// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getYoutubeTranscript, type YoutubeVideo } from '@/lib/api/youtube'
import {
  alignBilingualSegments,
  buildYoutubeTimestampUrl,
  formatBilingualTranscript,
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

const bilingualTranscript = {
  ...timestampedTranscript,
  language: 'en',
  text: 'Original transcript',
  segments: [{ start: 0, end: 2, text: 'Original transcript' }],
  chinese: {
    source: 'auto',
    language: 'zh-Hans',
    text: '中文字幕',
    segments: [{ start: 0, end: 2, text: '中文字幕' }],
    content_hash: 'hash-zh',
  },
}

const alignedBilingualTranscript = {
  ...bilingualTranscript,
  text: 'English first.\nEnglish second.',
  segments: [
    { start: 0, end: 4, text: 'English first.' },
    { start: 10, end: 12, text: 'English second.' },
  ],
  chinese: {
    ...bilingualTranscript.chinese,
    text: '中文第一句。\n中文补充句。\n独立中文。\n中文第二句。',
    segments: [
      { start: 0, end: 2, text: '中文第一句。' },
      { start: 2, end: 4, text: '中文补充句。' },
      { start: 6, end: 7, text: '独立中文。' },
      { start: 10, end: 12, text: '中文第二句。' },
    ],
  },
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: vi.fn(() => []),
  })
})

describe('bilingual transcript alignment', () => {
  it('assigns each Chinese segment once to the original with the largest overlap', () => {
    const groups = alignBilingualSegments(
      [
        { start: 0, end: 5, text: 'Original A' },
        { start: 4, end: 10, text: 'Original B' },
      ],
      [
        { start: 4.5, end: 6, text: '中文一' },
        { start: 6, end: 7, text: '中文二' },
      ],
    )

    expect(groups).toEqual([
      {
        original: { start: 0, end: 5, text: 'Original A' },
        chinese: [],
      },
      {
        original: { start: 4, end: 10, text: 'Original B' },
        chinese: [
          { start: 4.5, end: 6, text: '中文一' },
          { start: 6, end: 7, text: '中文二' },
        ],
      },
    ])
  })

  it('uses the nearest original within 1.5 seconds and preserves unmatched Chinese', () => {
    const groups = alignBilingualSegments(
      [
        { start: 0, end: 3, text: 'Original A' },
        { start: 10, end: 13, text: 'Original B' },
      ],
      [
        { start: 4.2, end: 5, text: '附近中文' },
        { start: 7, end: 8, text: '独立中文' },
        { start: Number.NaN, end: 9, text: '时间无效中文' },
      ],
    )

    expect(groups).toEqual([
      {
        original: { start: 0, end: 3, text: 'Original A' },
        chinese: [{ start: 4.2, end: 5, text: '附近中文' }],
      },
      {
        original: null,
        chinese: [{ start: 7, end: 8, text: '独立中文' }],
      },
      {
        original: { start: 10, end: 13, text: 'Original B' },
        chinese: [],
      },
      {
        original: null,
        chinese: [{ start: Number.NaN, end: 9, text: '时间无效中文' }],
      },
    ])
  })

  it('formats original and all assigned Chinese lines with blank lines between groups', () => {
    expect(formatBilingualTranscript([
      {
        original: { start: 0, end: 2, text: 'Original sentence.' },
        chinese: [
          { start: 0, end: 1, text: '中文第一行。' },
          { start: 1, end: 2, text: '中文第二行。' },
        ],
      },
      {
        original: null,
        chinese: [{ start: 5, end: 6, text: '独立中文。' }],
      },
    ])).toBe(
      'Original sentence.\n中文第一行。\n中文第二行。\n\n独立中文。',
    )
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
    expect(buildYoutubeTimestampUrl('javascript:alert(1)', 10)).toBeNull()
    expect(buildYoutubeTimestampUrl('data:text/html,unsafe', 10)).toBeNull()
    expect(buildYoutubeTimestampUrl('https://example.com/watch?v=video-1', 10)).toBeNull()
    expect(buildYoutubeTimestampUrl('https://evil.youtube.com/watch?v=video-1', 10)).toBeNull()
  })

  it('ignores a stale request after closing and reopening', async () => {
    let resolveFirst!: (value: typeof timestampedTranscript) => void
    const firstRequest = new Promise<typeof timestampedTranscript>(resolve => {
      resolveFirst = resolve
    })
    vi.mocked(getYoutubeTranscript)
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce({ ...timestampedTranscript, text: '最新内容', segments: [] })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByText('最新内容')).toBeInTheDocument()

    resolveFirst({ ...timestampedTranscript, text: '过期内容', segments: [] })
    await Promise.resolve()

    expect(screen.queryByText('过期内容')).not.toBeInTheDocument()
    expect(screen.getByText('最新内容')).toBeInTheDocument()
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

  it('defaults to original and switches the displayed and copied version to Chinese', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue(bilingualTranscript)
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    expect(await screen.findByText('Original transcript')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '原文' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '中英' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByText('中文字幕')).toBeInTheDocument()
    expect(screen.queryByText('Original transcript')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '复制全文' }))
    expect(writeText).toHaveBeenCalledWith('中文字幕')
  })

  it('renders aligned English then Chinese and copies the bilingual layout', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue(alignedBilingualTranscript)
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    await user.click(await screen.findByRole('button', { name: '中英' }))

    const englishFirst = screen.getByText('English first.')
    const chineseFirst = screen.getByText('中文第一句。')
    const chineseExtra = screen.getByText('中文补充句。')
    const chineseOnly = screen.getByText('独立中文。')
    const englishSecond = screen.getByText('English second.')
    expect(englishFirst.compareDocumentPosition(chineseFirst)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(chineseFirst.compareDocumentPosition(chineseExtra)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(chineseExtra.compareDocumentPosition(chineseOnly)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(chineseOnly.compareDocumentPosition(englishSecond)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getByText('仅中文')).toBeInTheDocument()
    expect(screen.getByText('en / zh-Hans · manual / auto')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制全文' }))
    expect(writeText).toHaveBeenCalledWith(
      'English first.\n中文第一句。\n中文补充句。\n\n独立中文。\n\nEnglish second.\n中文第二句。',
    )
  })

  it('hides version controls without Chinese and gives the body a bounded scroll region', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue(timestampedTranscript)
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))
    await screen.findByText('第二段')

    expect(screen.queryByRole('button', { name: '原文' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '中英' })).not.toBeInTheDocument()
    expect(screen.getByTestId('transcript-scroll-region')).toHaveClass(
      'min-h-0', 'flex-1', 'overflow-y-auto',
    )
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
    expect(await screen.findByText('逐字稿加载失败', {
      selector: '[data-slot="empty-title"]',
    })).toBeInTheDocument()
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

  it('does not allow copying whitespace-only transcript text', async () => {
    vi.mocked(getYoutubeTranscript).mockResolvedValue({
      ...timestampedTranscript,
      text: '   \n',
      segments: [],
    })
    const user = userEvent.setup()
    render(<YoutubeTranscriptDialog video={video} />)

    await user.click(screen.getByRole('button', { name: '逐字稿' }))

    expect(await screen.findByText('逐字稿内容为空')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制全文' })).toBeDisabled()
  })
})
