import { apiFetch } from './client'

export interface Paper {
  arxiv_id: string
  title: string
  abstract: string
  authors: string[]
  categories: string[]
  primary_category: string
  arxiv_url: string
  pdf_url: string
  submitted_at: string
  collected_at: string
}

export async function getPapers(params?: {
  limit?: number
  category?: string
  days?: number
  search?: string
}): Promise<Paper[]> {
  const q = new URLSearchParams()
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.category) q.set('category', params.category)
  if (params?.days) q.set('days', String(params.days))
  if (params?.search) q.set('search', params.search)
  const qs = q.toString()
  return apiFetch<Paper[]>(`/papers${qs ? '?' + qs : ''}`, { cache: 'no-store' } as RequestInit)
}

export async function collectPapers(): Promise<{ new_papers: number; errors: string[] }> {
  return apiFetch('/papers/collect', { method: 'POST' })
}
