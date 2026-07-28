// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResponsesClient } from './ResponsesClient'
import type { ResponseDetail, ResponseItem } from '@/lib/api/responses'

const api = vi.hoisted(() => ({
  createResponseOutputs: vi.fn(),
  decideResponse: vi.fn(),
  getResponse: vi.fn(),
  getResponseEvents: vi.fn(),
  getResponses: vi.fn(),
  getTranscript: vi.fn(),
}))

vi.mock('@/lib/api/responses', () => api)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function item(id: number, title: string, decision_status: ResponseItem['decision_status'] = 'pending'): ResponseItem {
  return {
    id,
    source_type: 'youtube_video',
    source_id: `video-${id}`,
    source_url: `https://youtube.com/watch?v=video-${id}`,
    source_title: title,
    source_author: 'Channel',
    source_published_at: null,
    workflow_status: 'ready',
    decision_status,
    current_analysis_run_id: id * 10,
    selected_publish_account_id: null,
    selected_output_types: [],
    feedback_reason: '',
    analysis: {
      id,
      version: 1,
      status: 'ready',
      job_id: null,
      content_value_score: 90,
      value_dimensions: {},
      summary_cn: '摘要',
      core_thesis: '核心观点',
      key_points: [],
      evidence: [],
      value_points: [],
      risks: [],
      verification_items: [],
      personal_angles: [],
      article_outlines: [],
      comment_angles: [],
      recommended_output_types: ['expanded_article'],
      recommended_action: '建议创作',
      recommendation_reason: '有价值',
      recommended_publish_account_id: null,
      created_at: '2026-07-27T00:00:00Z',
      completed_at: '2026-07-27T00:00:00Z',
    },
  }
}

function detail(id: number, title: string, decision_status: ResponseItem['decision_status'] = 'pending'): ResponseDetail {
  return { ...item(id, title, decision_status), account_scores: [], outputs: [] }
}

describe('ResponsesClient action source', () => {
  it('disables decisions while the selected detail is loading and decides only the matching response', async () => {
    const first = detail(38, 'Selected video')
    const second = detail(39, 'Another video')
    const secondRequest = deferred<ResponseDetail>()
    let secondCalls = 0
    api.getResponse.mockImplementation((id: number) => {
      if (id === first.id) return Promise.resolve(first)
      secondCalls += 1
      return secondCalls === 1 ? secondRequest.promise : Promise.resolve(second)
    })
    api.getResponses.mockResolvedValue({ items: [first, second], total: 2, page: 1, page_size: 30 })
    api.decideResponse.mockResolvedValue({ ...second, decision_status: 'later' })

    render(<ResponsesClient initialItems={[first, second]} initialTotal={2} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Selected video' })
    await user.click(screen.getByText('Another video'))

    const adoptButton = screen.getByRole('button', { name: '采纳创作' })
    expect(adoptButton).toBeDisabled()
    expect(screen.getAllByRole('button', { name: '稍后处理' }).at(-1)).toBeDisabled()
    expect(screen.getAllByRole('button', { name: '不值得' }).at(-1)).toBeDisabled()
    expect(screen.getByPlaceholderText('可选：记录不值得或稍后处理的原因')).toBeDisabled()
    await user.click(adoptButton)
    expect(api.decideResponse).not.toHaveBeenCalled()

    await act(async () => {
      secondRequest.resolve(second)
      await secondRequest.promise
    })
    await waitFor(() => expect(screen.getAllByRole('button', { name: '稍后处理' }).at(-1)).toBeEnabled())
    await user.click(screen.getAllByRole('button', { name: '稍后处理' }).at(-1)!)

    await waitFor(() => expect(api.decideResponse).toHaveBeenCalledWith(39, 'later', ''))
  })

  it('ignores a stale detail response that resolves after a newer selection', async () => {
    const first = detail(38, 'Slow video')
    const second = detail(39, 'Current video')
    const firstRequest = deferred<ResponseDetail>()
    api.getResponse.mockImplementation((id: number) => (
      id === first.id ? firstRequest.promise : Promise.resolve(second)
    ))
    api.getResponses.mockResolvedValue({ items: [first, second], total: 2, page: 1, page_size: 30 })

    render(<ResponsesClient initialItems={[first, second]} initialTotal={2} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await waitFor(() => expect(api.getResponse).toHaveBeenCalledWith(38))
    await user.click(screen.getByText('Current video'))
    await screen.findByRole('heading', { name: 'Current video' })

    await act(async () => {
      firstRequest.resolve(first)
      await firstRequest.promise
    })

    expect(screen.getByRole('heading', { name: 'Current video' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Slow video' })).not.toBeInTheDocument()
  })

  it('keeps output creation gated when a list refresh selects a different response', async () => {
    const first = detail(38, 'Selected video')
    const second = detail(39, 'Another video')
    const secondRequest = deferred<ResponseDetail>()
    let secondCalls = 0
    api.getResponse.mockImplementation((id: number) => {
      if (id === first.id) return Promise.resolve(first)
      secondCalls += 1
      return secondCalls === 1 ? secondRequest.promise : Promise.resolve(second)
    })
    api.getResponses.mockResolvedValue({ items: [second], total: 1, page: 1, page_size: 30 })
    api.decideResponse.mockResolvedValue({ ...first, decision_status: 'adopted' })
    api.createResponseOutputs.mockResolvedValue({ outputs: [] })

    render(<ResponsesClient initialItems={[first, second]} initialTotal={2} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Selected video' })
    await user.click(screen.getByRole('button', { name: '采纳创作' }))
    const createButton = await screen.findByRole('button', { name: '创建任务' })

    await waitFor(() => expect(api.getResponse).toHaveBeenCalledWith(39))
    expect(createButton).toBeDisabled()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '扩写文章' })).toBeDisabled()
    await user.click(createButton)
    expect(api.createResponseOutputs).not.toHaveBeenCalled()

    await act(async () => {
      secondRequest.resolve(second)
      await secondRequest.promise
    })
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(api.createResponseOutputs).not.toHaveBeenCalled()
  })
})
