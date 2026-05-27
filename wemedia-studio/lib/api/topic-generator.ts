import { apiFetch } from './client'

export interface SourcePost {
  username: string
  content: string
  url: string
}

export interface TopicSuggestion {
  title: string
  angle: string
  type: 'long' | 'short' | 'story' | 'share'
  source_posts: SourcePost[]
}

export interface GenerateResponse {
  warning: string | null
  topics: TopicSuggestion[]
}

export interface EnqueueResponse {
  enqueued: number
  task_ids: string[]
  pipeline_task_ids: number[]
}

export async function generateTopics(opts: {
  account_id: string | null
  sources?: string[]
  custom_prompt?: string | null
}): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/topic-generator/generate', {
    method: 'POST',
    body: JSON.stringify({
      account_id: opts.account_id,
      sources: opts.sources ?? ['x'],
      custom_prompt: opts.custom_prompt ?? null,
    }),
  })
}

export async function enqueueTopics(opts: {
  account_id: string
  topics: TopicSuggestion[]
}): Promise<EnqueueResponse> {
  return apiFetch<EnqueueResponse>('/topic-generator/enqueue', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}

export interface CachedTopicsResponse {
  generated_at: string | null
  topics: TopicSuggestion[]
}

export async function getCachedTopics(accountId?: string | null): Promise<CachedTopicsResponse> {
  const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : ''
  return apiFetch<CachedTopicsResponse>(`/topic-generator/cached${qs}`)
}
