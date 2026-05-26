import { apiFetch } from './client'

export interface RedditSubscription {
  id: number
  subreddit: string
  label: string
  group: string
  muted: boolean
  last_collected_at: string | null
  created_at: string
  post_count: number
}

export interface RedditPost {
  id: string
  post_id: string
  subscription_id: number
  title: string
  content: string
  url: string
  linked_url: string
  author: string
  subreddit: string
  flair: string
  score: number
  upvote_ratio: number
  comment_count: number
  is_self: boolean
  published_at: string
  collected_at: string
}

export type RedditView = 'hot' | 'new' | 'all'

export async function getRedditSubscriptions(): Promise<RedditSubscription[]> {
  return apiFetch<RedditSubscription[]>('/reddit/subscriptions')
}

export async function addRedditSubscription(body: {
  subreddit: string
  label?: string
  group?: string
}): Promise<RedditSubscription> {
  return apiFetch<RedditSubscription>('/reddit/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateRedditSubscription(
  id: number,
  patch: { label?: string; group?: string; muted?: boolean },
): Promise<RedditSubscription> {
  return apiFetch<RedditSubscription>(`/reddit/subscriptions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function deleteRedditSubscription(id: number): Promise<void> {
  return apiFetch<void>(`/reddit/subscriptions/${id}`, { method: 'DELETE' })
}

export async function collectRedditSubscription(id: number): Promise<void> {
  return apiFetch<void>(`/reddit/subscriptions/${id}/collect`, { method: 'POST' })
}

export async function collectRedditAll(): Promise<void> {
  return apiFetch<void>('/reddit/collect', { method: 'POST' })
}

export async function getRedditPosts(opts?: {
  subscription_id?: number
  view?: RedditView
  days?: number
  limit?: number
  search?: string
}): Promise<RedditPost[]> {
  const p = new URLSearchParams()
  if (opts?.subscription_id !== undefined) p.set('subscription_id', String(opts.subscription_id))
  if (opts?.view) p.set('view', opts.view)
  if (opts?.days) p.set('days', String(opts.days))
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.search) p.set('search', opts.search)
  const qs = p.toString()
  return apiFetch<RedditPost[]>(`/reddit/posts${qs ? `?${qs}` : ''}`)
}
