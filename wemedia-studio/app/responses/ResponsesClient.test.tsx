// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

describe('ResponsesClient creation source', () => {
  it('keeps the visible response as the action and creation source while the list selection refreshes', async () => {
    const adopted = detail(38, 'Selected video')
    const nextPending = detail(39, 'Another video')
    api.getResponse.mockImplementation((id: number) => (
      id === 38 ? Promise.resolve(adopted) : new Promise<ResponseDetail>(() => {})
    ))
    api.getResponses.mockResolvedValue({ items: [nextPending], total: 1, page: 1, page_size: 30 })
    api.decideResponse.mockResolvedValue({ ...adopted, decision_status: 'adopted' })
    api.createResponseOutputs.mockResolvedValue({ outputs: [] })

    render(<ResponsesClient initialItems={[adopted, nextPending]} initialTotal={2} accounts={[]} initialSelectedId={38} initialSource="" />)
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Selected video' })
    await waitFor(() => expect(api.getResponse).toHaveBeenCalledWith(39))
    await user.click(screen.getByRole('button', { name: '采纳创作' }))
    expect(api.decideResponse).toHaveBeenCalledWith(38, 'adopt', '')
    await screen.findByRole('button', { name: '创建任务' })
    expect(screen.getByText('将基于：Selected video')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => {
      expect(api.createResponseOutputs).toHaveBeenCalledWith(38, {
        analysis_run_id: 380,
        publish_account_id: null,
        output_types: ['expanded_article'],
      })
    })
  })
})
