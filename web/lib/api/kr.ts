import { apiFetch } from './client'

export type KrFeedType = 'hot' | 'article' | 'newsflash'

export interface KrArticle {
  id: string
  feed_type: KrFeedType
  title: string
  url: string
  image_url: string
  summary: string
  content: string
  author: string
  stat_text: string
  stat_read: number
  stat_like: number
  stat_comment: number
  rank: number
  published_at: string
  collected_at: string
}

export async function getKrArticles(opts?: {
  feed_type?: KrFeedType
  days?: number
  limit?: number
  search?: string
}): Promise<KrArticle[]> {
  const p = new URLSearchParams()
  if (opts?.feed_type) p.set('feed_type', opts.feed_type)
  if (opts?.days) p.set('days', String(opts.days))
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.search) p.set('search', opts.search)
  const qs = p.toString()
  return apiFetch<KrArticle[]>(`/kr/articles${qs ? `?${qs}` : ''}`)
}

export async function getKrArticle(id: string): Promise<KrArticle> {
  return apiFetch<KrArticle>(`/kr/articles/${id}`)
}

export async function collectKr(feed_type?: KrFeedType): Promise<void> {
  const qs = feed_type ? `?feed_type=${feed_type}` : ''
  return apiFetch<void>(`/kr/collect${qs}`, { method: 'POST' })
}
