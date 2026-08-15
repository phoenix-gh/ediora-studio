import { apiFetch } from './client'

export interface ProductHuntPost {
  id: string
  title: string
  tagline: string
  url: string
  thumbnail_url: string
  images: string[]
  description: string
  topics: string[]
  votes: number
  published_at: string
  collected_at: string
}

export async function getProductHuntPosts(params?: {
  days?: number
  limit?: number
  search?: string
}): Promise<ProductHuntPost[]> {
  const p = new URLSearchParams()
  if (params?.days) p.set('days', String(params.days))
  if (params?.limit) p.set('limit', String(params.limit))
  if (params?.search) p.set('search', params.search)
  return apiFetch<ProductHuntPost[]>(`/producthunt/posts?${p}`)
}

export async function collectProductHunt(): Promise<{ ok: boolean; new_posts: number }> {
  return apiFetch('/producthunt/collect', { method: 'POST' })
}
