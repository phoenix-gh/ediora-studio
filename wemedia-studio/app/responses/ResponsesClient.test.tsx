// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/lib/api/responses', () => api)
vi.mock('sonner', () => ({ toast: notifications }))

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

  it('uses the loaded detail sources and synchronously blocks same-tick duplicate output creation', async () => {
    const first = detail(38, 'Selected video')
    const createRequest = deferred<{ outputs: [] }>()
    api.getResponse.mockResolvedValue(first)
    api.getResponses.mockResolvedValue({ items: [first], total: 1, page: 1, page_size: 30 })
    api.decideResponse.mockResolvedValue({ ...first, decision_status: 'adopted' })
    api.createResponseOutputs.mockReturnValue(createRequest.promise)

    render(<ResponsesClient initialItems={[first]} initialTotal={1} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Selected video' })
    await user.click(screen.getByRole('button', { name: '采纳创作' }))
    await screen.findByText('将基于：Selected video')
    expect(api.decideResponse).toHaveBeenCalledWith(first.id, 'adopt', '')

    const createButton = screen.getByRole('button', { name: '创建任务' })
    act(() => {
      createButton.click()
      createButton.click()
    })

    expect(api.createResponseOutputs).toHaveBeenCalledTimes(1)
    expect(api.createResponseOutputs).toHaveBeenCalledWith(first.id, {
      analysis_run_id: 380,
      publish_account_id: null,
      output_types: ['expanded_article'],
    })
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled()

    await act(async () => {
      createRequest.resolve({ outputs: [] })
      await createRequest.promise
    })
    await waitFor(() => expect(screen.queryByText('将基于：Selected video')).not.toBeInTheDocument())
  })

  it('keeps a newer creation session and its busy payload intact when an older submit completes', async () => {
    const first = detail(38, 'First video')
    const second = detail(39, 'Second video')
    second.analysis!.recommended_output_types = ['commentary']
    const firstCreate = deferred<{ outputs: [] }>()
    const secondCreate = deferred<{ outputs: [] }>()
    api.getResponse.mockImplementation((id: number) => Promise.resolve(id === first.id ? first : second))
    api.getResponses.mockResolvedValue({ items: [first, second], total: 2, page: 1, page_size: 30 })
    api.decideResponse.mockImplementation((id: number) => Promise.resolve({
      ...(id === first.id ? first : second),
      decision_status: 'adopted',
    }))
    api.createResponseOutputs
      .mockReturnValueOnce(firstCreate.promise)
      .mockReturnValueOnce(secondCreate.promise)

    render(<ResponsesClient initialItems={[first, second]} initialTotal={2} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'First video' })
    await user.click(screen.getByRole('button', { name: '采纳创作' }))
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(api.createResponseOutputs).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getByText('Second video'))
    await screen.findByRole('heading', { name: 'Second video' })
    await user.click(screen.getByRole('button', { name: '采纳创作' }))
    expect(await screen.findByText('将基于：Second video')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(api.createResponseOutputs).toHaveBeenCalledTimes(2))
    expect(api.decideResponse).toHaveBeenNthCalledWith(1, first.id, 'adopt', '')
    expect(api.decideResponse).toHaveBeenNthCalledWith(2, second.id, 'adopt', '')
    expect(api.createResponseOutputs).toHaveBeenNthCalledWith(1, first.id, {
      analysis_run_id: 380,
      publish_account_id: null,
      output_types: ['expanded_article'],
    })
    expect(api.createResponseOutputs).toHaveBeenNthCalledWith(2, second.id, {
      analysis_run_id: 390,
      publish_account_id: null,
      output_types: ['commentary'],
    })

    await act(async () => {
      firstCreate.resolve({ outputs: [] })
      await firstCreate.promise
    })

    expect(screen.getByText('将基于：Second video')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled()

    await act(async () => {
      secondCreate.resolve({ outputs: [] })
      await secondCreate.promise
    })
    await waitFor(() => expect(screen.queryByText('将基于：Second video')).not.toBeInTheDocument())
  })

  it('ends the creation session after mutation success even when the detail refresh fails', async () => {
    const first = detail(38, 'Selected video')
    api.getResponse
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('refresh offline'))
    api.getResponses.mockResolvedValue({ items: [first], total: 1, page: 1, page_size: 30 })
    api.decideResponse.mockResolvedValue({ ...first, decision_status: 'adopted' })
    api.createResponseOutputs.mockResolvedValue({ outputs: [] })

    render(<ResponsesClient initialItems={[first]} initialTotal={1} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Selected video' })
    await user.click(screen.getByRole('button', { name: '采纳创作' }))
    const completedSessionButton = await screen.findByRole('button', { name: '创建任务' })
    await user.click(completedSessionButton)

    await waitFor(() => expect(screen.queryByText('将基于：Selected video')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '创建任务' })).not.toBeInTheDocument()
    fireEvent.click(completedSessionButton)
    expect(api.createResponseOutputs).toHaveBeenCalledTimes(1)
    expect(notifications.success).toHaveBeenCalledWith('创作任务已创建')
    expect(notifications.error).toHaveBeenCalledWith('详情刷新失败：refresh offline')
    expect(notifications.error).not.toHaveBeenCalledWith(expect.stringContaining('创作任务创建失败'))
  })

  it('shows a detail load error and retries the same selected row', async () => {
    const first = detail(38, 'Retry video')
    api.getResponse
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(first)
    api.getResponses.mockResolvedValue({ items: [first], total: 1, page: 1, page_size: 30 })

    render(<ResponsesClient initialItems={[first]} initialTotal={1} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    expect(await screen.findByRole('alert')).toHaveTextContent('详情加载失败：offline')
    await user.click(screen.getByText('Retry video'))

    expect(await screen.findByRole('heading', { name: 'Retry video' })).toBeInTheDocument()
    expect(api.getResponse).toHaveBeenCalledTimes(2)
  })
})
