import { apiFetch } from './client'

export type JuejinCategory =
  | 'hot' | 'backend' | 'frontend' | 'ai'
  | 'android' | 'ios' | 'tool' | 'life' | 'read'

export interface JuejinArticle {
  id: string
  category: JuejinCategory
  title: string
  url: string
  cover_url: string
  brief: string
  content: string
  author: string
  author_avatar: string
  tags: string
  view_count: number
  digg_count: number
  comment_count: number
  collect_count: number
  hot_rank: number
  published_at: string
  collected_at: string
}

export interface JuejinCategoryMeta {
  key: JuejinCategory
  label: string
}

export async function getJuejinCategories(): Promise<JuejinCategoryMeta[]> {
  return apiFetch<JuejinCategoryMeta[]>('/juejin/categories')
}

export async function getJuejinArticles(opts?: {
  category?: JuejinCategory
  limit?: number
  search?: string
}): Promise<JuejinArticle[]> {
  const p = new URLSearchParams()
  if (opts?.category) p.set('category', opts.category)
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.search) p.set('search', opts.search)
  const qs = p.toString()
  return apiFetch<JuejinArticle[]>(`/juejin/articles${qs ? `?${qs}` : ''}`)
}

export async function getJuejinArticle(id: string): Promise<JuejinArticle> {
  return apiFetch<JuejinArticle>(`/juejin/articles/${id}`)
}

export async function collectJuejin(category?: JuejinCategory): Promise<void> {
  const qs = category ? `?category=${category}` : ''
  return apiFetch<void>(`/juejin/collect${qs}`, { method: 'POST' })
}
