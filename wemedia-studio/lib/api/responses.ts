import { apiFetch } from './client'


export type ResponseAnalysis = {
  id: number
  version: number
  status: string
  job_id: number | null
  content_value_score: number
  value_dimensions: Record<string, { score: number; reason: string }>
  summary_cn: string
  core_thesis: string
  key_points: string[]
  evidence: Array<{ text: string; type: string; source?: string }>
  value_points: string[]
  risks: string[]
  verification_items: string[]
  personal_angles: string[]
  article_outlines: Array<{ title: string; sections: string[] }>
  comment_angles: string[]
  recommended_output_types: string[]
  recommended_action: string
  recommendation_reason: string
  recommended_publish_account_id: string | null
  created_at: string
  completed_at: string | null
}

export type AccountScore = {
  publish_account_id: string
  account_snapshot: { name?: string; platform?: string }
  score: number
  rank: number
  fit_reasons: string[]
  audience_value: string
  recommended_tone: string
  recommended_output_types: string[]
  taboo_risks: string[]
  has_hard_conflict: boolean
}

export type ResponseOutput = {
  id: number
  output_type: string
  status: string
  job_id: number | null
  article_draft_id: number | null
  content: string
  error_code: string
  error: string
}

export type ResponseItem = {
  id: number
  source_type: 'x_post' | 'youtube_video'
  source_id: string
  source_url: string
  source_title: string
  source_author: string
  source_published_at: string | null
  workflow_status: string
  decision_status: 'pending' | 'adopted' | 'later' | 'rejected'
  current_analysis_run_id: number | null
  selected_publish_account_id: string | null
  selected_output_types: string[]
  feedback_reason: string
  analysis: ResponseAnalysis | null
  job?: { id: number; status: string; flow: string } | null
}

export type ResponseDetail = ResponseItem & {
  account_scores: AccountScore[]
  outputs: ResponseOutput[]
}

export type Transcript = {
  status: string
  source: string
  language: string
  text: string
  segments: Array<{ start: number; end: number; text: string }>
  content_hash: string
  fetched_at: string | null
  error_code: string
  error: string
}

export async function getResponses(params: {
  source_type?: string
  decision_status?: string
  search?: string
  sort?: string
  page?: number
} = {}) {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value))
  })
  return apiFetch<{ items: ResponseItem[]; total: number; page: number; page_size: number }>(
    `/responses?${query}`,
  )
}

export const getResponse = (id: number) =>
  apiFetch<ResponseDetail>(`/responses/${id}`)

export const getResponseEvents = (id: number) =>
  apiFetch<{ items: Array<{
    id: number
    event_type: string
    actor: string
    payload: Record<string, unknown>
    created_at: string
  }> }>(`/responses/${id}/events`)

export const getTranscript = (videoId: string) =>
  apiFetch<Transcript>(`/youtube/videos/${videoId}/transcript`)

export const decideResponse = (
  id: number,
  action: 'adopt' | 'later' | 'not_valuable' | 'reset',
  reason = '',
) => apiFetch<ResponseItem>(`/responses/${id}/decision`, {
  method: 'POST',
  body: JSON.stringify({ action, reason }),
})

export const createResponseOutputs = (
  id: number,
  body: {
    analysis_run_id: number
    publish_account_id: string | null
    output_types: string[]
  },
) => apiFetch<{ outputs: ResponseOutput[] }>(`/responses/${id}/outputs`, {
  method: 'POST',
  body: JSON.stringify(body),
})
