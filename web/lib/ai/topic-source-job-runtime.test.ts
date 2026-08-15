import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getJob: vi.fn(),
  startStep: vi.fn(),
  failStep: vi.fn(),
  completeStep: vi.fn(),
  completeJob: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  workerHeaders: vi.fn(),
}))

vi.mock('./job-client', () => ({
  apiGet: api.apiGet,
  apiPost: api.apiPost,
  completeJob: api.completeJob,
  completeStep: api.completeStep,
  failStep: api.failStep,
  getJob: api.getJob,
  retryableForError: vi.fn(() => true),
  startStep: api.startStep,
  workerHeaders: api.workerHeaders,
}))

vi.mock('./agent-execution-client', () => ({
  appendAgentMessage: vi.fn(),
  completeAgentExecution: vi.fn(),
  ensureAgentExecution: vi.fn(),
  failAgentExecution: vi.fn(),
}))

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn() }))
vi.mock('ai', () => ({ generateText: vi.fn() }))

import { runTopicSourceJob } from './topic-source-job'

describe('topic source malformed payload handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.startStep.mockResolvedValue({ id: 41 })
    api.failStep.mockResolvedValue({})
  })

  it.each([
    { tweet_ids: ['old-post'] },
    { subscription_id: 3, tweet_ids: ['old-post'] },
  ])('fails malformed payloads durably without retrying', async input => {
    api.getJob.mockResolvedValue({
      id: 71,
      flow: 'topic_source',
      title: '旧主题素材任务',
      status: 'queued',
      input,
      steps: [],
    })

    await expect(runTopicSourceJob(71))
      .rejects.toThrow('topic_source flow requires rule_id')

    expect(api.startStep).toHaveBeenCalledWith(71, 'select')
    expect(api.failStep).toHaveBeenCalledWith(
      71,
      41,
      expect.objectContaining({
        message: 'topic_source flow requires rule_id',
      }),
      false,
    )
    expect(api.completeJob).not.toHaveBeenCalled()
  })
})
