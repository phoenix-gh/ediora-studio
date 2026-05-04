import { apiFetch } from './client'

export interface XCandidate {
  username: string
  display_name: string
  avatar_url: string
  followers: number
  bio: string
  profile_url: string
  status: string
  added_at: string
  last_seen_at: string
}

export interface XMetricsPoint {
  collected_at: string
  replies: number
  reposts: number
  likes: number
  views: number
}

export interface XPost {
  tweet_id: string
  username: string
  display_name: string
  content: string
  url: string
  published_at: string
  author_followers: number
  latest_replies: number
  latest_reposts: number
  latest_likes: number
  latest_views: number
  is_viral: boolean
  metrics_history: XMetricsPoint[]
}

export async function getXCandidates(status?: string, limit = 200): Promise<XCandidate[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) params.set('status', status)
  return apiFetch<XCandidate[]>(`/x/candidates?${params}`)
}

export async function updateXCandidate(username: string, status: string): Promise<XCandidate> {
  return apiFetch<XCandidate>(`/x/candidates/${username}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export async function deleteXCandidate(username: string): Promise<void> {
  await apiFetch(`/x/candidates/${username}`, { method: 'DELETE' })
}

export async function triggerXCollect(): Promise<{ ok: boolean; message: string }> {
  return apiFetch('/x/collect', { method: 'POST' })
}

export async function getXPosts(hours = 24): Promise<XPost[]> {
  return apiFetch<XPost[]>(`/x/posts?hours=${hours}`)
}
