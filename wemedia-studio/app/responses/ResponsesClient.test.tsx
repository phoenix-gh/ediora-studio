// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResponsesClient } from './ResponsesClient'
import type { ResponseDetail, ResponseItem } from '@/lib/api/responses'

const api = vi.hoisted(() => ({
  createResponseDestination: vi.fn(),
  createResponseOutputs: vi.fn(),
  decideResponse: vi.fn(),
  getResponse: vi.fn(),
  getResponseEvents: vi.fn(),
  getResponses: vi.fn(),
  updateResponseClassification: vi.fn(),
}))
const assets = vi.hoisted(() => ({ listCreativeAssetDirectories: vi.fn() }))
const notifications = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))

vi.mock('@/lib/api/responses', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/responses')>('@/lib/api/responses')
  return { ...actual, ...api }
})
vi.mock('@/lib/api/assets', () => assets)
vi.mock('sonner', () => ({ toast: notifications }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function detail(id: number, sourceType: 'x_post' | 'youtube_video' = 'x_post'): ResponseDetail {
  const item: ResponseItem = {
    id,
    source_type: sourceType,
    source_id: sourceType === 'x_post' ? `post-${id}` : `video-${id}`,
    source_url: sourceType === 'x_post' ? 'https://x.com/post' : 'https://youtube.com/watch?v=video',
    source_title: sourceType === 'x_post' ? 'X 原文标题' : 'YouTube 视频标题',
    source_author: '作者',
    source_published_at: '2026-08-05T00:00:00Z',
    subscription_id: sourceType === 'x_post' ? 1 : null,
    workflow_status: 'ready',
    decision_status: 'pending',
    content_types: ['research'],
    destination: null,
    current_analysis_run_id: id * 10,
    feedback_reason: '',
    created_at: '2026-08-05T00:00:00Z',
    updated_at: '2026-08-05T00:00:00Z',
    analysis: {
      id: id * 10,
      version: 1,
      status: 'succeeded',
      job_id: null,
      content_value_score: 88,
      value_dimensions: {
        novelty: { score: 90, reason: '新角度' },
        practicality: { score: 80, reason: '可执行' },
        credibility: { score: 85, reason: '有来源' },
        writing_space: { score: 88, reason: '有展开空间' },
        evergreen_value: { score: 70, reason: '可长期参考' },
      },
      summary_cn: '摘要',
      core_thesis: '核心判断',
      suggested_title: '建议标题',
      suggested_angle: '从实践路径切入',
      target_reader: '内容创作者',
      suggested_structure: ['开篇', '论证', '结论'],
      value_points: ['价值点'],
      evidence: [{ text: '原文证据', type: 'source_claim' }],
      risks: ['需要核验'],
      verification_items: ['查证来源'],
      recommended_content_types: ['research'],
      recommended_disposition: 'worth_writing',
      recommendation_reason: '适合写入内容系统',
      created_at: '2026-08-05T00:00:00Z',
      completed_at: '2026-08-05T00:01:00Z',
    },
  }
  return {
    ...item,
    source: sourceType === 'x_post'
      ? {
          type: 'x_post', id: item.source_id, url: item.source_url, title: item.source_title,
          author: item.source_author, published_at: item.source_published_at, available: true,
          unavailable_reason: '', content: '完整 X 原文正文', raw_markdown: '完整 X Markdown',
        }
      : {
          type: 'youtube_video', id: item.source_id, url: item.source_url, title: item.source_title,
          author: item.source_author, published_at: item.source_published_at, available: true,
          unavailable_reason: '', description: '视频说明', transcript_status: 'ready',
          transcript_language: 'zh', transcript_text: '完整 YouTube 字幕', transcript_segments: [],
        },
    outputs: [],
  }
}

function listResult(value: ResponseDetail) {
  return {
    items: [value],
    counts: { all: 1, pending: 1, worth_writing: 0, creative_asset: 0, not_processed: 0 },
    total: 1,
    page: 1,
    page_size: 30,
  }
}

function listPage(items: ResponseItem[], total: number, page: number) {
  return {
    items,
    counts: { all: total, pending: total, worth_writing: 0, creative_asset: 0, not_processed: 0 },
    total,
    page,
    page_size: 30,
  }
}

describe('Intelligence Station workbench', () => {
  it('renders the original source and AI evaluation together', async () => {
    const value = detail(1)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)

    expect(await screen.findByRole('heading', { name: value.source_title })).toBeInTheDocument()
    expect(screen.getByText('AI 评价')).toBeInTheDocument()
    expect(screen.getByText('完整 X Markdown')).toBeInTheDocument()
    expect(screen.getAllByText('适合写入内容系统').length).toBeGreaterThan(0)
    expect(screen.getByTestId('response-source-scroll').className).toContain('overflow-y-auto')
    expect(screen.queryByText('评论')).not.toBeInTheDocument()
    expect(screen.queryByText('回复')).not.toBeInTheDocument()
  })

  it('keeps complete YouTube transcript visible with its evaluation', async () => {
    const value = detail(2, 'youtube_video')
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)

    expect(await screen.findByText('完整 YouTube 字幕')).toBeInTheDocument()
    expect(screen.getAllByText('视频说明').length).toBeGreaterThan(0)
    expect(screen.getByText('AI 评价')).toBeInTheDocument()
  })

  it('keeps the selected detail visible when the same item is clicked again', async () => {
    const value = detail(11)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')

    await user.click(screen.getByRole('button', { name: /X 原文标题/ }))

    expect(screen.getByText('AI 评价')).toBeInTheDocument()
    expect(screen.queryByText('正在加载原文与 AI 评价…')).not.toBeInTheDocument()
    expect(api.getResponse).toHaveBeenCalledTimes(1)
  })

  it('uses the default three-day window and resets to page one when the window changes', async () => {
    const value = detail(12)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')

    await waitFor(() => expect(api.getResponses).toHaveBeenCalledWith(expect.objectContaining({ days: 3, page: 1 })))
    await user.click(screen.getByRole('button', { name: '筛选：7天内' }))

    await waitFor(() => expect(api.getResponses).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7, page: 1 })))
  })

  it('loads and appends the next page when the list sentinel becomes visible', async () => {
    let onIntersect: IntersectionObserverCallback | undefined
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        onIntersect = callback
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      root = null
      rootMargin = ''
      thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)

    const first = detail(13)
    const secondBase = detail(14)
    const second = {
      ...secondBase,
      source_title: '第二页 X 原文标题',
      source: { ...secondBase.source, title: '第二页 X 原文标题' },
    }
    api.getResponse.mockResolvedValue(first)
    api.getResponses.mockImplementation((params: { page?: number }) => (
      params.page === 2
        ? Promise.resolve(listPage([second], 2, 2))
        : Promise.resolve(listPage([first], 2, 1))
    ))

    render(<ResponsesClient initialItems={[first]} initialTotal={2} initialSelectedId={first.id} initialSource="" />)
    await screen.findByText('AI 评价')

    await act(async () => {
      onIntersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })

    await waitFor(() => expect(screen.getByText(second.source_title)).toBeInTheDocument())
    expect(api.getResponses).toHaveBeenCalledWith(expect.objectContaining({ days: 3, page: 2 }))
  })

  it('uses the same button interaction for content type filters as other filters', async () => {
    const value = detail(7)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByRole('button', { name: '筛选：教程' }))

    await waitFor(() => expect(api.getResponses).toHaveBeenLastCalledWith(expect.objectContaining({ content_type: 'tutorial' })))
  })

  it('updates content classification without changing the destination decision', async () => {
    const value = detail(3)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))
    api.updateResponseClassification.mockResolvedValue({ ...value, content_types: ['research', 'tutorial'] })

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByRole('button', { name: '教程' }))

    await waitFor(() => expect(api.updateResponseClassification).toHaveBeenCalledWith(3, ['research', 'tutorial']))
  })

  it('starts a full article writing job without opening a draft seed dialog', async () => {
    const value = detail(4)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))
    api.createResponseOutputs.mockResolvedValue({
      outputs: [{ id: 41, output_type: 'expanded_article', status: 'queued', job_id: 42, created: true }],
    })

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByRole('button', { name: '值得写' }))

    await waitFor(() => expect(api.createResponseOutputs).toHaveBeenCalledWith(4, {
      analysis_run_id: 40,
      output_types: ['expanded_article'],
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(notifications.success).toHaveBeenCalledWith('写作任务已启动')
  })

  it('keeps the queued writing status visible when the pending list no longer contains the item', async () => {
    const value = detail(15)
    const queuedDetail: ResponseDetail = {
      ...value,
      decision_status: 'worth_writing',
      outputs: [{
        id: 151,
        output_type: 'expanded_article',
        status: 'queued',
        job_id: 152,
        job_status: 'queued',
        article_draft_id: null,
        content: '',
        error_code: '',
        error: '',
      }],
    }
    api.getResponse.mockResolvedValueOnce(value).mockResolvedValueOnce(queuedDetail)
    let listCalls = 0
    api.getResponses.mockImplementation(() => {
      listCalls += 1
      return Promise.resolve(listCalls === 1 ? listResult(value) : listPage([], 0, 1))
    })
    api.createResponseOutputs.mockResolvedValue({
      outputs: [{ id: 151, output_type: 'expanded_article', status: 'queued', job_id: 152, created: true }],
    })

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByRole('button', { name: '值得写' }))

    expect(await screen.findByTestId('response-writing-status')).toHaveTextContent('文章写作中')
    expect(screen.getByText(/写作完成后会自动创建完整文章草稿/)).toBeInTheDocument()
  })

  it('links a completed writing output to the generated draft', async () => {
    const value: ResponseDetail = {
      ...detail(16),
      decision_status: 'worth_writing',
      outputs: [{
        id: 161,
        output_type: 'expanded_article',
        status: 'draft_ready',
        job_id: 162,
        job_status: 'succeeded',
        article_draft_id: 163,
        content: '# 完整文章',
        error_code: '',
        error: '',
      }],
    }
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)

    expect(await screen.findByTestId('response-writing-status')).toHaveTextContent('写作完成，已进入草稿箱')
    expect(screen.getByRole('link', { name: /打开草稿箱/ })).toHaveAttribute('href', '/drafts?draft=163')
  })

  it('keeps the asset dialog open and retryable after a destination failure', async () => {
    const value = detail(5)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))
    assets.listCreativeAssetDirectories.mockResolvedValue([{ id: 1, name: '研究' }])
    api.createResponseDestination.mockRejectedValueOnce(new Error('保存失败'))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByRole('button', { name: '创作资产' }))
    await user.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!)

    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('sends a direct not-processed decision and can reset it', async () => {
    const value = detail(6)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))
    api.decideResponse.mockResolvedValue({ ...value, decision_status: 'not_processed' })

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByRole('button', { name: '暂不处理' }))
    await waitFor(() => expect(api.decideResponse).toHaveBeenCalledWith(6, 'not_processed'))
  })

  it('uses 1 to start writing and 2 to open the asset dialog', async () => {
    const value = detail(8)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))
    assets.listCreativeAssetDirectories.mockResolvedValue([{ id: 1, name: '研究' }])
    api.createResponseOutputs.mockResolvedValue({
      outputs: [{ id: 81, output_type: 'expanded_article', status: 'queued', job_id: 82, created: true }],
    })

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')

    await user.keyboard('1')
    await waitFor(() => expect(api.createResponseOutputs).toHaveBeenCalledWith(8, {
      analysis_run_id: 80,
      output_types: ['expanded_article'],
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.keyboard('2')
    expect(await screen.findByRole('dialog')).toHaveTextContent('保存为创作资产')
    expect(assets.listCreativeAssetDirectories).toHaveBeenCalledWith('article')
  })

  it('uses 3 to mark the selected pending item as not processed', async () => {
    const value = detail(9)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))
    api.decideResponse.mockResolvedValue({ ...value, decision_status: 'not_processed' })

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.keyboard('3')

    await waitFor(() => expect(api.decideResponse).toHaveBeenCalledWith(9, 'not_processed'))
  })

  it('does not trigger shortcuts while an editable control is focused', async () => {
    const value = detail(10)
    api.getResponse.mockResolvedValue(value)
    api.getResponses.mockResolvedValue(listResult(value))

    render(<ResponsesClient initialItems={[value]} initialTotal={1} initialSelectedId={value.id} initialSource="" />)
    const user = userEvent.setup()
    await screen.findByText('AI 评价')
    await user.click(screen.getByPlaceholderText('搜索标题或作者'))
    await user.keyboard('3')

    expect(api.decideResponse).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
