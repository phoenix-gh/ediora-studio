import { apiFetch } from './client'

export interface WriterPersona {
  id: number
  name: string
  description: string
  prompt: string
  model: string
  is_default: boolean
  created_at: string
}

export async function getPersonas(): Promise<WriterPersona[]> {
  return apiFetch('/personas')
}

export async function createPersona(body: Omit<WriterPersona, 'id' | 'created_at'>): Promise<WriterPersona> {
  return apiFetch('/personas', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updatePersona(id: number, body: Partial<Omit<WriterPersona, 'id' | 'created_at'>>): Promise<WriterPersona> {
  return apiFetch(`/personas/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deletePersona(id: number): Promise<void> {
  return apiFetch(`/personas/${id}`, { method: 'DELETE' })
}
