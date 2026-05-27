import { apiFetch } from './client'

export interface SourcePost {
  username: string
  content: string
  url: string
}

export interface TopicSuggestion {
  title: string
  angle: string
  type: 'long' | 'short'
  source_posts: SourcePost[]
}

export interface GenerateResponse {
  warning: string | null
  topics: TopicSuggestion[]
}

export interface EnqueueResponse {
  enqueued: number
  task_ids: string[]
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
  account_id: string | null
  topics: TopicSuggestion[]
}): Promise<EnqueueResponse> {
  return apiFetch<EnqueueResponse>('/topic-generator/enqueue', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}
