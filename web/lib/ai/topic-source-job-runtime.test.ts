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
  createOpenAI: vi.fn(),
  generateText: vi.fn(),
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

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: api.createOpenAI }))
vi.mock('ai', () => ({ generateText: api.generateText }))

import { runTopicSourceJob } from './topic-source-job'

describe('topic source malformed payload handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.startStep.mockResolvedValue({ id: 41 })
    api.failStep.mockResolvedValue({})
    api.completeStep.mockResolvedValue({})
    api.completeJob.mockResolvedValue({})
    api.workerHeaders.mockReturnValue({})
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

  it('loads the information-filtering runtime with the job adapter override', async () => {
    api.getJob.mockResolvedValue({
      id: 72,
      flow: 'topic_source',
      title: '按订阅筛选主题素材',
      status: 'queued',
      input: {
        subscription_id: 9,
        directory_ids: [3],
        tweet_ids: ['tweet-1'],
        llm_adapter_id: 'filter',
      },
      steps: [],
    })
    api.apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/assets/ingestion/candidates')) {
        return {
          directories: [{
            id: 3,
            name: 'AI 工具',
            asset_type: 'article',
            keywords: ['AI'],
            prompt: '只接受有案例的内容。',
          }],
          posts: [{
            tweet_id: 'tweet-1',
            content: '一条 AI 工具动态',
            url: 'https://x.com/example/status/1',
            media: [],
          }],
        }
      }
      if (url.startsWith('/settings/ai-runtime')) {
        return {
          api_key: 'filter-key',
          protocol: 'openai-responses',
          model: 'filter-model',
          base_url: 'https://filter.example/v1',
          headers: { 'X-Tenant': 'tenant-a' },
        }
      }
      throw new Error(`unexpected GET ${url}`)
    })
    api.apiPost.mockResolvedValue({ saved: 1, skipped: 0, decided: 1 })
    const chat = vi.fn(() => ({ id: 'filter-chat-model' }))
    const responses = vi.fn(() => ({ id: 'filter-responses-model' }))
    api.createOpenAI.mockReturnValue({ chat, responses })
    api.generateText.mockResolvedValue({
      text: JSON.stringify({ classifications: [{ tweet_id: 'tweet-1', directory_id: 3 }] }),
    })

    await expect(runTopicSourceJob(72)).resolves.toEqual(expect.objectContaining({
      candidate_count: 1,
      accepted_count: 1,
    }))

    const settingsCall = api.apiGet.mock.calls.find(([url]) => (
      typeof url === 'string' && url.startsWith('/settings/ai-runtime')
    ))
    expect(settingsCall).toBeDefined()
    const query = new URLSearchParams(String(settingsCall?.[0]).split('?')[1])
    expect(query.get('capability')).toBe('text')
    expect(query.get('purpose')).toBe('information_filtering')
    expect(query.get('adapter_id')).toBe('filter')
    expect(api.createOpenAI).toHaveBeenCalledWith({
      apiKey: 'filter-key',
      baseURL: 'https://filter.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
    })
    expect(responses).toHaveBeenCalledWith('filter-model')
    expect(chat).not.toHaveBeenCalled()
    expect(api.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'filter-responses-model' },
    }))
    expect(api.generateText).toHaveBeenCalledOnce()
    expect(api.apiPost).toHaveBeenCalledWith(
      '/assets/ingestion/accepted',
      expect.objectContaining({ subscription_id: 9 }),
      expect.anything(),
    )
  })
})
