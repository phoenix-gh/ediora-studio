import { apiFetch } from './client'

export interface XCandidate {
  username: string
  display_name: string
  avatar_url: string
  followers: number
  following_count: number
  tweet_count: number
  favourites_count: number
  location: string
  join_date: string
  hot_post_count: number
  bio: string
  profile_url: string
  status: string
  added_at: string
  last_seen_at: string
}

export interface XPost {
  tweet_id: string
  username: string
  display_name: string
  content: string
  url: string
  published_at: string
  collected_at: string
  author_followers: number
  source: string
  latest_replies: number
  latest_reposts: number
  latest_likes: number
  latest_views: number
  is_viral: boolean
  category: string
}

export interface XCandidateList {
  candidates: XCandidate[]
  total: number
  status_counts: Record<string, number>
}

export async function getXCandidates(status?: string, limit = 50, offset = 0): Promise<XCandidateList> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (status) params.set('status', status)
  return apiFetch<XCandidateList>(`/x/candidates?${params}`)
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

export async function triggerTl1UsersCollect(maxPages = 100): Promise<{ ok: boolean; message: string }> {
  return apiFetch(`/x/collect-tl1-users?max_pages=${maxPages}`, { method: 'POST' })
}

export async function triggerClassifyPosts(batchSize = 20): Promise<{ ok: boolean; message: string }> {
  return apiFetch(`/x/classify-posts?batch_size=${batchSize}`, { method: 'POST' })
}
