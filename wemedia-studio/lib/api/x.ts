import { apiFetch } from './client'

// ── Types ────────────────────────────────────────────────────────────────────

export interface XSubscription {
  id: number
  url: string
  label: string
  enabled: boolean
  last_collected_at: string | null
  last_error: string
  added_at: string
  post_count: number
}

export interface XPost {
  tweet_id: string
  subscription_id: number
  username: string
  display_name: string
  content: string
  url: string
  published_at: string
  collected_at: string
  replies: number
  reposts: number
  likes: number
  views: number
  author_avatar: string
  cover_image: string
}

export interface XSearchPost {
  tweet_id: string
  username: string
  display_name: string
  content: string
  url: string
  published_at: string
  replies: number
  reposts: number
  likes: number
  views: number
  author_avatar: string
  cover_image: string
}

export interface XAuthStatus {
  ready: boolean
  hint: string
}

export interface XCollectResult {
  ok: boolean
  new_posts: number
}

export interface XCollectAllResult {
  ok: boolean
  checked: number
  new_posts: number
  failed: string[]
}

// ── Subscriptions CRUD ──────────────────────────────────────────────────────

export async function listXSubscriptions(): Promise<XSubscription[]> {
  return apiFetch<XSubscription[]>('/x/subscriptions')
}

export async function createXSubscription(url: string, label?: string): Promise<XSubscription> {
  return apiFetch<XSubscription>('/x/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ url, label }),
  })
}

export async function patchXSubscription(
  id: number,
  body: Partial<Pick<XSubscription, 'enabled' | 'label'>>,
): Promise<XSubscription> {
  return apiFetch<XSubscription>(`/x/subscriptions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteXSubscription(id: number): Promise<void> {
  await apiFetch(`/x/subscriptions/${id}`, { method: 'DELETE' })
}

// ── Collect / Posts / Search / Auth ──────────────────────────────────────────

export async function collectXSubscription(id: number): Promise<XCollectResult> {
  return apiFetch<XCollectResult>(`/x/subscriptions/${id}/collect`, { method: 'POST' })
}

export async function collectAllXSubscriptions(): Promise<XCollectAllResult> {
  return apiFetch<XCollectAllResult>('/x/collect-all', { method: 'POST' })
}

export interface ListXPostsParams {
  subscription_id?: number
  hours?: number
  limit?: number
  offset?: number
}

export async function listXPosts(params: ListXPostsParams = {}): Promise<XPost[]> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v))
  }
  const tail = qs.toString()
  return apiFetch<XPost[]>(`/x/posts${tail ? '?' + tail : ''}`)
}

export async function searchX(q: string, limit = 20): Promise<XSearchPost[]> {
  return apiFetch<XSearchPost[]>(`/x/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export async function getXAuthStatus(): Promise<XAuthStatus> {
  return apiFetch<XAuthStatus>('/x/auth-status')
}
