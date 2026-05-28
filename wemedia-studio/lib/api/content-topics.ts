import { apiFetch } from './client'

export interface TopicTag {
  id: number
  name: string
  color: string
}

export interface TopicSource {
  id: number
  topic_id: number
  url: string
  title: string
  content: string
  note: string
  platform: string
  draft_id: number | null
  created_at: string
}

export interface ContentTopic {
  id: number
  title: string
  brief: string
  description: string
  priority: number
  status: string
  created_at: string
  updated_at: string
  tags: TopicTag[]
  sources: TopicSource[]
  source_count: number
  draft_count: number
}

export interface ContentTopicCreate {
  title: string
  brief?: string
  tags?: string[]
  priority?: number
}

export interface ContentTopicUpdate {
  title?: string
  brief?: string
  tags?: string[]
  priority?: number
  status?: string
}

export interface TopicSourceCreate {
  topic_id: number
  url?: string
  title?: string
  content?: string
  note?: string
  platform?: string
  draft_id?: number | null
}

export interface DraftSummary {
  id: number
  title: string
  status: string
  draft_type: string
  created_at: string
}

export interface DispatchResult {
  task_id: string
  kanban_url: string
}

export const PLATFORMS = [
  { value: 'x',      label: 'X / Twitter' },
  { value: 'github', label: 'GitHub' },
  { value: 'wechat', label: '微信公众号' },
  { value: 'manual', label: '手动录入' },
  { value: 'self',   label: '自己发布' },
]

export async function getTopics(tags?: string[]): Promise<ContentTopic[]> {
  const params = tags?.length ? `?tags=${tags.join(',')}` : ''
  return apiFetch<ContentTopic[]>(`/content-topics${params}`)
}

export async function getTags(): Promise<TopicTag[]> {
  return apiFetch<TopicTag[]>('/content-topics/tags')
}

export async function createTag(name: string): Promise<TopicTag> {
  return apiFetch<TopicTag>('/content-topics/tags', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteTag(id: number): Promise<void> {
  await apiFetch(`/content-topics/tags/${id}`, { method: 'DELETE' })
}

export async function createTopic(body: ContentTopicCreate): Promise<ContentTopic> {
  return apiFetch<ContentTopic>('/content-topics', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateTopic(id: number, body: ContentTopicUpdate): Promise<ContentTopic> {
  return apiFetch<ContentTopic>(`/content-topics/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteTopic(id: number): Promise<void> {
  await apiFetch(`/content-topics/${id}`, { method: 'DELETE' })
}

export async function getTopicDrafts(topicId: number): Promise<DraftSummary[]> {
  return apiFetch<DraftSummary[]>(`/content-topics/${topicId}/drafts`)
}

export async function dispatchTopic(topicId: number): Promise<DispatchResult> {
  return apiFetch<DispatchResult>(`/content-topics/${topicId}/dispatch`, {
    method: 'POST',
  })
}

export async function addSource(topicId: number, body: Omit<TopicSourceCreate, 'topic_id'>): Promise<TopicSource> {
  return apiFetch<TopicSource>(`/content-topics/${topicId}/sources`, {
    method: 'POST',
    body: JSON.stringify({ ...body, topic_id: topicId }),
  })
}

export async function deleteSource(topicId: number, sourceId: number): Promise<void> {
  await apiFetch(`/content-topics/${topicId}/sources/${sourceId}`, { method: 'DELETE' })
}

// ── Legacy helpers (topics are now flat; kept for call-site compatibility) ────

export function flattenTopics(topics: ContentTopic[]): ContentTopic[] {
  return topics
}

export interface FlatTopic {
  topic: ContentTopic
  depth: number
  label: string
}

export function flattenTopicsWithDepth(topics: ContentTopic[]): FlatTopic[] {
  return topics.map(t => ({ topic: t, depth: 0, label: t.title }))
}
