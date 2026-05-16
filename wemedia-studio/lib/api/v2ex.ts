import { apiFetch } from './client'

export type V2exKind = 'node' | 'user' | 'tab' | 'all'

export interface V2exSubscription {
  id: number
  kind: V2exKind
  key: string
  label: string
  group: string
  muted: boolean
  last_collected_at: string | null
  created_at: string
  topic_count: number
}

export interface V2exTopic {
  id: string
  subscription_id: number
  topic_id: number
  title: string
  content: string
  url: string
  author: string
  author_url: string
  replies: number
  published_at: string
  collected_at: string
}

export interface V2exPresets {
  tabs: { key: string; label: string }[]
  nodes: { key: string; label: string }[]
}

export async function getV2exPresets(): Promise<V2exPresets> {
  return apiFetch<V2exPresets>('/v2ex/presets')
}

export async function getV2exSubscriptions(): Promise<V2exSubscription[]> {
  return apiFetch<V2exSubscription[]>('/v2ex/subscriptions')
}

export async function addV2exSubscription(body: {
  kind: V2exKind
  key?: string
  label?: string
  group?: string
}): Promise<V2exSubscription> {
  return apiFetch<V2exSubscription>('/v2ex/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateV2exSubscription(
  id: number,
  patch: { label?: string; group?: string; muted?: boolean },
): Promise<V2exSubscription> {
  return apiFetch<V2exSubscription>(`/v2ex/subscriptions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function deleteV2exSubscription(id: number): Promise<void> {
  return apiFetch<void>(`/v2ex/subscriptions/${id}`, { method: 'DELETE' })
}

export async function collectV2exSubscription(id: number): Promise<void> {
  return apiFetch<void>(`/v2ex/subscriptions/${id}/collect`, { method: 'POST' })
}

export async function collectV2exAll(): Promise<void> {
  return apiFetch<void>('/v2ex/collect', { method: 'POST' })
}

export async function getV2exTopics(opts?: {
  subscription_id?: number
  days?: number
  limit?: number
  search?: string
}): Promise<V2exTopic[]> {
  const p = new URLSearchParams()
  if (opts?.subscription_id !== undefined) p.set('subscription_id', String(opts.subscription_id))
  if (opts?.days) p.set('days', String(opts.days))
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.search) p.set('search', opts.search)
  const qs = p.toString()
  return apiFetch<V2exTopic[]>(`/v2ex/topics${qs ? `?${qs}` : ''}`)
}
