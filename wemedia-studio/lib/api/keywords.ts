import { apiFetch } from './client'

export interface Keyword {
  id: number
  term: string
  category: string
  source: 'manual' | 'llm'
  is_active: boolean
  heat: number
  mention_count_24h: number
  platforms: string[]
  trend: 'rising' | 'stable' | 'declining'
  last_computed_at: string | null
  created_at: string
}

export interface WordCloudItem {
  term: string
  weight: number
}

export async function getKeywords(activeOnly = true): Promise<Keyword[]> {
  try {
    return await apiFetch<Keyword[]>(`/keywords?active_only=${activeOnly}`)
  } catch {
    return []
  }
}

export async function createKeyword(term: string, category = ''): Promise<Keyword> {
  return apiFetch<Keyword>('/keywords', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term, category }),
  })
}

export async function deleteKeyword(id: number): Promise<void> {
  await apiFetch<void>(`/keywords/${id}`, { method: 'DELETE' })
}

export async function refreshKeywords(): Promise<{ updated: number; message: string }> {
  return apiFetch<{ updated: number; message: string }>('/keywords/refresh', { method: 'POST' })
}

export async function extractKeywords(): Promise<Keyword[]> {
  return apiFetch<Keyword[]>('/keywords/extract', { method: 'POST' })
}

export async function getWordCloud(hours = 24, topN = 80): Promise<WordCloudItem[]> {
  try {
    return await apiFetch<WordCloudItem[]>(`/keywords/wordcloud?hours=${hours}&top_n=${topN}`)
  } catch {
    return []
  }
}
