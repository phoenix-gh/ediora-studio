import { apiFetch } from './client'

export interface Draft {
  id: number
  topic_id: string
  title: string
  content: string
  status: string
  persona_id: number | null
  version: number
  created_at: string
  updated_at: string
}

export interface DraftUpdate {
  title?: string
  content?: string
  status?: string
}

export const DRAFT_STATUSES = [
  { value: 'drafting',  label: '草稿'   },
  { value: 'editing',   label: '编辑中' },
  { value: 'ready',     label: '待发布' },
  { value: 'published', label: '已发布' },
  { value: 'archived',  label: '已归档' },
] as const

export async function getDrafts(): Promise<Draft[]> {
  return apiFetch<Draft[]>('/write/drafts')
}

export async function updateDraft(id: number, body: DraftUpdate): Promise<Draft> {
  return apiFetch<Draft>(`/write/drafts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteDraft(id: number): Promise<void> {
  await apiFetch(`/write/drafts/${id}`, { method: 'DELETE' })
}
