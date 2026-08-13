import { apiFetch } from './client'

export type ResponseDisposition =
  | 'pending'
  | 'worth_writing'
  | 'creative_asset'
  | 'not_processed'

export type ContentType =
  | 'tool'
  | 'industry_update'
  | 'case'
  | 'tutorial'
  | 'research'

export const contentTypeLabels: Record<ContentType, string> = {
  tool: '工具',
  industry_update: '行业动态',
  case: '案例',
  tutorial: '教程',
  research: '研究',
}

export const dispositionLabels: Record<ResponseDisposition, string> = {
  pending: '待判断',
  worth_writing: '值得写',
  creative_asset: '创作资产',
  not_processed: '暂不处理',
}

export type ResponseAnalysis = {
  id: number
  version: number
  status: string
  job_id: number | null
  content_value_score: number
  value_dimensions: Record<string, { score: number; reason: string }>
  summary_cn: string
  core_thesis: string
  suggested_title: string
  suggested_angle: string
  target_reader: string
  suggested_structure: string[]
  value_points: string[]
  evidence: Array<{ text: string; type: string; source?: string }>
  risks: string[]
  verification_items: string[]
  recommended_content_types: ContentType[]
  recommended_disposition: Exclude<ResponseDisposition, 'pending'>
  recommendation_reason: string
  created_at: string
  completed_at: string | null
}

export type ResponseSource = {
  type: 'x_post' | 'youtube_video'
  id: string
  url: string
  title: string
  author: string
  published_at: string | null
  available: boolean
  unavailable_reason: string
  content?: string
  raw_markdown?: string
  description?: string
  transcript_status?: string
  transcript_source?: string
  transcript_language?: string
  transcript_text?: string
  transcript_segments?: Array<{ start: number; end: number; text: string }>
  transcript_content_hash?: string
  transcript_fetched_at?: string | null
  transcript_error_code?: string
  transcript_error?: string
}

export type ResponseDestination = {
  type: 'draft' | 'creative_asset'
  id: number
  url: string
}

export type ResponseOutputType =
  | 'expanded_article'
  | 'commentary'
  | 'x_share'
  | 'x_reply'
  | 'x_quote'
  | 'x_short_post'
  | 'x_article'
  | 'wechat_article'

export const responseOutputLabels: Record<ResponseOutputType, string> = {
  expanded_article: '通用文章',
  commentary: '评论文章',
  x_share: 'X 分享',
  x_reply: 'X 回复',
  x_quote: 'X 引用帖',
  x_short_post: 'X 短帖',
  x_article: 'X Article',
  wechat_article: '公众号文章',
}

export type ResponseOutput = {
  id: number
  output_type: ResponseOutputType
  status: string
  job_id: number | null
  job_status: string | null
  article_draft_id: number | null
  content: string
  error_code: string
  error: string
}

export type ResponseOutputQueueResult = Pick<
  ResponseOutput,
  'id' | 'output_type' | 'status' | 'job_id' | 'job_status'
> & { created: boolean }

export type ResponseItem = {
  id: number
  source_type: 'x_post' | 'youtube_video'
  source_id: string
  source_url: string
  source_title: string
  source_author: string
  source_published_at: string | null
  subscription_id: number | null
  workflow_status: string
  decision_status: ResponseDisposition
  content_types: ContentType[]
  destination: ResponseDestination | null
  current_analysis_run_id: number | null
  feedback_reason: string
  created_at: string
  updated_at: string
  analysis: ResponseAnalysis | null
  job?: { id: number; status: string; flow: string } | null
}

export type ResponseDetail = ResponseItem & {
  source: ResponseSource
  outputs: ResponseOutput[]
}

export type ResponseList = {
  items: ResponseItem[]
  counts: Record<ResponseDisposition | 'all', number>
  total: number
  page: number
  page_size: number
}

export async function getResponses(params: {
  source_type?: string
  decision_status?: ResponseDisposition | ''
  workflow_status?: string
  content_type?: ContentType | ''
  days?: number
  search?: string
  sort?: 'score' | 'newest'
  page?: number
  page_size?: number
} = {}) {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value))
  })
  return apiFetch<ResponseList>(`/responses?${query}`)
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

export const decideResponse = (
  id: number,
  action: 'not_processed' | 'reset',
  reason = '',
) => apiFetch<ResponseItem>(`/responses/${id}/decision`, {
  method: 'POST',
  body: JSON.stringify({ action, reason }),
})

export const updateResponseClassification = (id: number, contentTypes: ContentType[]) =>
  apiFetch<ResponseItem>(`/responses/${id}/classification`, {
    method: 'POST',
    body: JSON.stringify({ content_types: contentTypes }),
  })

export const createResponseDestination = (
  id: number,
  body: {
    destination: 'creative_asset'
    analysis_run_id: number
    directory: string | null
  },
) => apiFetch<ResponseDestination>(`/responses/${id}/destination`, {
  method: 'POST',
  body: JSON.stringify(body),
})

export const createResponseOutputs = (
  id: number,
  body: {
    analysis_run_id: number
    output_types: ResponseOutputType[]
    publish_account_id?: string | null
  },
) => apiFetch<{ outputs: ResponseOutputQueueResult[] }>(`/responses/${id}/outputs`, {
  method: 'POST',
  body: JSON.stringify(body),
})
