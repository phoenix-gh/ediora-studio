import { Topic, TopicStatus } from '@/lib/types'
import { apiFetch } from './client'

function toTopic(raw: Record<string, unknown>): Topic {
  return {
    id: raw.id as string,
    title: raw.title as string,
    summary: raw.summary as string,
    score: raw.score as number,
    urgency: raw.urgency as Topic['urgency'],
    tags: raw.tags as string[],
    category: raw.category as Topic['category'],
    sources: (raw.sources as Topic['sources']) ?? [],
    competitorCount: raw.competitor_count as number,
    createdAt: raw.created_at as string,
    status: raw.status as TopicStatus,
    recommendReason: raw.recommend_reason as string,
    trendData: raw.trend_data as number[],
    directionId: raw.direction_id as number | null ?? null,
    directionName: (raw.direction_name as string) ?? '',
    strategyId: raw.strategy_id as number | null ?? null,
    strategyName: (raw.strategy_name as string) ?? '',
    clusterId: (raw.cluster_id as string) ?? '',
    clusterTitle: (raw.cluster_title as string) ?? '',
    clusterSourceCount: (raw.cluster_source_count as number) ?? 0,
  }
}

async function fetchTopics(params?: URLSearchParams): Promise<Topic[]> {
  const qs = params?.toString() ? `?${params}` : ''
  const raw = await apiFetch<Record<string, unknown>[]>(`/topics${qs}`)
  return raw.map(toTopic)
}

export interface TopicFilters {
  categories?: string[]
  urgency?: Topic['urgency'][]
  unreadOnly?: boolean
  sortBy?: 'score' | 'createdAt' | 'urgency'
}

export async function getTopics(filters?: TopicFilters): Promise<Topic[]> {
  const params = new URLSearchParams()
  if (filters?.urgency?.length === 1) params.set('urgency', filters.urgency[0])

  let result = await fetchTopics(params)

  if (filters?.categories?.length) {
    result = result.filter(t => filters.categories!.includes(t.category))
  }
  if (filters?.unreadOnly) {
    result = result.filter(t => t.status === 'pending')
  }

  const urgencyOrder = { urgent: 0, this_week: 1, long_tail: 2 }
  if (filters?.sortBy === 'urgency') {
    result.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency])
  } else if (filters?.sortBy === 'createdAt') {
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  } else {
    result.sort((a, b) => b.score - a.score)
  }
  return result
}

export async function getTopicById(id: string): Promise<Topic | undefined> {
  const all = await fetchTopics()
  return all.find(t => t.id === id)
}

export async function updateTopicStatus(id: string, status: TopicStatus): Promise<Topic> {
  const raw = await apiFetch<Record<string, unknown>>(`/topics/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  return toTopic(raw)
}

export async function getRecommendedTopics(limit = 5): Promise<Topic[]> {
  const all = await fetchTopics()
  return all.filter(t => t.status === 'pending').slice(0, limit)
}
