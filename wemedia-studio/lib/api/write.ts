import { apiFetch } from './client'

export type DraftStatus = 'drafting' | 'editing' | 'ready' | 'published' | 'archived'

export interface ArticleDraft {
  id: number
  topic_id: string
  title: string
  content: string
  status: DraftStatus
  persona_id: number | null
  version: number
  created_at: string
  updated_at: string
}

export async function generateArticleDraft(topicId: string, personaId?: number): Promise<{
  id: number
  topic_id: string
  title: string
  draft: string
  content: string
  status: DraftStatus
  persona_id: number | null
  version: number
  created_at: string
  updated_at: string
}> {
  return apiFetch('/write/generate', {
    method: 'POST',
    body: JSON.stringify({ topic_id: topicId, persona_id: personaId ?? null }),
  })
}

export async function getArticleDrafts(topicId: string): Promise<ArticleDraft[]> {
  return apiFetch(`/write/drafts?topic_id=${encodeURIComponent(topicId)}`, { next: { revalidate: 0 } as RequestInit['next'] })
}

export async function createArticleDraft(body: {
  topic_id: string
  title?: string
  content?: string
  status?: DraftStatus
  persona_id?: number | null
}): Promise<ArticleDraft> {
  return apiFetch('/write/drafts', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateArticleDraft(id: number, body: Partial<{
  title: string
  content: string
  status: DraftStatus
  persona_id: number | null
}>): Promise<ArticleDraft> {
  return apiFetch(`/write/drafts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function triggerGenerateTopics(): Promise<{ new_topics: number; message: string }> {
  return apiFetch('/topics/generate', { method: 'POST', next: { revalidate: 0 } as RequestInit['next'] })
}

export async function triggerGenerateHotspots(): Promise<{ new_hotspots: number; message: string }> {
  return apiFetch('/hotspots/generate', { method: 'POST', next: { revalidate: 0 } as RequestInit['next'] })
}

export async function triggerFullAnalysis(): Promise<{ new_topics: number; new_hotspots: number; new_economic: number }> {
  return apiFetch('/analyze/all', { method: 'POST', next: { revalidate: 0 } as RequestInit['next'] })
}
