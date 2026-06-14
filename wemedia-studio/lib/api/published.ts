import { apiFetch } from './client'

export interface Publication {
  id: number
  draft_id: number
  account_id: string
  account_name: string
  platform: string
  title: string
  external_id: string
  url: string
  status: 'draft_box' | 'published'
  published_at: string | null
  read_count: number
  like_count: number
  look_count: number
  share_count: number
  stats_as_of: string | null
  created_at: string
  updated_at: string
}

export type PublicationPatch = Partial<Pick<Publication,
  'status' | 'url' | 'read_count' | 'like_count' | 'look_count' | 'share_count'>>

export function getPublications(params?: { status?: string; account_id?: string }): Promise<Publication[]> {
  const clean = Object.fromEntries(
    Object.entries(params ?? {}).filter(([, v]) => v !== undefined),
  ) as Record<string, string>
  const qs = new URLSearchParams(clean).toString()
  return apiFetch<Publication[]>(`/published-articles${qs ? `?${qs}` : ''}`)
}

export function updatePublication(id: number, patch: PublicationPatch): Promise<Publication> {
  return apiFetch<Publication>(`/published-articles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deletePublication(id: number): Promise<void> {
  return apiFetch<void>(`/published-articles/${id}`, { method: 'DELETE' })
}
