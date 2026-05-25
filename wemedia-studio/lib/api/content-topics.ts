import { apiFetch } from './client'

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
  description: string
  parent_id: number | null
  priority: number
  status: string
  created_at: string
  updated_at: string
  sources: TopicSource[]
  children: ContentTopic[]
  draft_count: number
}

export interface ContentTopicCreate {
  title: string
  description?: string
  parent_id?: number | null
  priority?: number
}

export interface ContentTopicUpdate {
  title?: string
  description?: string
  parent_id?: number | null
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

export const PLATFORMS = [
  { value: 'x',      label: 'X / Twitter' },
  { value: 'github', label: 'GitHub' },
  { value: 'wechat', label: '微信公众号' },
  { value: 'manual', label: '手动录入' },
  { value: 'self',   label: '自己发布' },
]

export async function getTopics(): Promise<ContentTopic[]> {
  return apiFetch<ContentTopic[]>('/content-topics')
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

export async function addSource(topicId: number, body: Omit<TopicSourceCreate, 'topic_id'>): Promise<TopicSource> {
  return apiFetch<TopicSource>(`/content-topics/${topicId}/sources`, {
    method: 'POST',
    body: JSON.stringify({ ...body, topic_id: topicId }),
  })
}

export async function deleteSource(topicId: number, sourceId: number): Promise<void> {
  await apiFetch(`/content-topics/${topicId}/sources/${sourceId}`, { method: 'DELETE' })
}

export function flattenTopics(topics: ContentTopic[]): ContentTopic[] {
  const result: ContentTopic[] = []
  for (const t of topics) {
    result.push(t)
    if (t.children.length) result.push(...flattenTopics(t.children))
  }
  return result
}

export interface FlatTopic {
  topic: ContentTopic
  depth: number
  label: string   // indented display label
}

export function flattenTopicsWithDepth(topics: ContentTopic[], depth = 0): FlatTopic[] {
  const result: FlatTopic[] = []
  for (const t of topics) {
    const prefix = depth === 0 ? '' : '　'.repeat(depth - 1) + '└ '
    result.push({ topic: t, depth, label: prefix + t.title })
    if (t.children.length) result.push(...flattenTopicsWithDepth(t.children, depth + 1))
  }
  return result
}
