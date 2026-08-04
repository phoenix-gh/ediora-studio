import { apiFetch } from './client'

export interface DraftSource {
  url: string
  title: string
  note: string
}

export interface Draft {
  id: number
  topic_id: string
  writing_plan_id: number | null
  title: string
  content: string
  status: string
  draft_type: string
  series_id: number | null
  series_order: number
  version: number
  sources: DraftSource[]
  created_at: string
  updated_at: string
}

export interface DraftUpdate {
  title?: string
  content?: string
  status?: string
  draft_type?: string
  series_id?: number | null
  series_order?: number
  writing_plan_id?: number | null
  sources?: DraftSource[]
}

export interface Series {
  id: number
  name: string
  description: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface SeriesCreate {
  name: string
  description?: string
  sort_order?: number
}

export interface SeriesUpdate {
  name?: string
  description?: string
  sort_order?: number
}

export const DRAFT_TYPES = [
  { value: 'article', label: '文章',   badge: 'bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400' },
  { value: 'x',       label: 'X',      badge: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' },
  { value: 'mp',      label: '公众号',  badge: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  { value: 'bili',    label: 'B站',    badge: 'bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' },
  { value: 'xhs',     label: '小红书',  badge: 'bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
] as const

const UNKNOWN_DRAFT_BADGE =
  'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'

export function draftTypeInfo(value: string) {
  return DRAFT_TYPES.find(type => type.value === value) ?? {
    value,
    label: value || '未知平台',
    badge: UNKNOWN_DRAFT_BADGE,
  }
}

export const DRAFT_STATUSES = [
  { value: 'drafting',  label: '草稿'   },
  { value: 'editing',   label: '编辑中' },
  { value: 'ready',     label: '待发布' },
  { value: 'published', label: '已发布' },
  { value: 'archived',  label: '已归档' },
] as const

export interface DraftCreate {
  topic_id?: string
  title?: string
  content?: string
  status?: string
  draft_type?: string
  writing_plan_id?: number | null
  sources?: DraftSource[]
}

export async function createDraft(body: DraftCreate): Promise<Draft> {
  return apiFetch<Draft>('/write/drafts', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getDrafts(): Promise<Draft[]> {
  return apiFetch<Draft[]>('/write/drafts')
}

export async function updateDraft(id: number, body: DraftUpdate): Promise<Draft> {
  return apiFetch<Draft>(`/write/drafts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteDraft(id: number): Promise<void> {
  await apiFetch(`/write/drafts/${id}`, { method: 'DELETE' })
}

export async function getSeries(): Promise<Series[]> {
  return apiFetch<Series[]>('/write/series')
}

export async function createSeries(body: SeriesCreate): Promise<Series> {
  return apiFetch<Series>('/write/series', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateSeries(id: number, body: SeriesUpdate): Promise<Series> {
  return apiFetch<Series>(`/write/series/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteSeries(id: number): Promise<void> {
  await apiFetch(`/write/series/${id}`, { method: 'DELETE' })
}

export interface DraftImage {
  id: number
  filename: string
  original_name: string
  url: string
  hosted_url: string
  size_bytes: number
  mime_type: string
  created_at: string
}

export async function getDraftImages(draftId: number): Promise<DraftImage[]> {
  return apiFetch<DraftImage[]>(`/write/drafts/${draftId}/images`)
}

export async function uploadDraftImage(draftId: number, file: File): Promise<DraftImage> {
  const form = new FormData()
  form.append('file', file)
  return apiFetch<DraftImage>(`/write/drafts/${draftId}/images`, {
    method: 'POST',
    body: form,
  })
}

export async function deleteDraftImage(draftId: number, imageId: number): Promise<void> {
  await apiFetch(`/write/drafts/${draftId}/images/${imageId}`, { method: 'DELETE' })
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatResponse {
  reply: string
  updated_content: string | null
  session_name: string
}

export async function chatWithDraft(
  id: number,
  message: string,
  opts?: { sessionName?: string; history?: ChatMessage[] }
): Promise<ChatResponse> {
  return apiFetch<ChatResponse>(`/write/drafts/${id}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      session_name: opts?.sessionName ?? null,
      history: opts?.history ?? [],
    }),
  })
}

export interface WechatPublishRequest {
  account_id: string
  title: string
  digest: string
  html: string
  cover_image_id: number
}

export async function publishDraftToWechat(
  draftId: number, body: WechatPublishRequest,
): Promise<{ media_id: string }> {
  return apiFetch(`/write/drafts/${draftId}/publish/wechat`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface BlogPublishRequest {
  title: string
  description: string
  content_markdown: string
  cover_image_id?: number
  slug?: string
  series?: string
  tags?: string[]
  pullquote?: string
  revision_notes?: string
}

export interface BlogPublishResult {
  id: string
  slug: string
  status: string
  admin_url: string
}

export async function publishDraftToBlog(
  draftId: number, body: BlogPublishRequest,
): Promise<BlogPublishResult> {
  return apiFetch(`/write/drafts/${draftId}/publish/blog`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
