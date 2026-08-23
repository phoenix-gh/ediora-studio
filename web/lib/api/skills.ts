import { ApiError } from './client'

export type SkillSource = 'builtin' | 'uploaded'

export type ManagedSkill = {
  name: string
  description: string
  version: string
  digest: string
  source: SkillSource
  enabled: boolean
  reviewState: 'approved' | 'pending'
  standardCompatible: boolean
  diagnostics: readonly string[]
}

async function skillFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: isFormData ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers },
    cache: init?.cache ?? 'no-store',
  })
  if (!response.ok) {
    let detail: unknown = ''
    try { detail = (await response.json()).detail ?? '' } catch { /* ignore malformed error bodies */ }
    const message = typeof detail === 'string'
      ? detail
      : typeof detail === 'object' && detail && 'message' in detail
        ? String(detail.message)
        : ''
    throw new ApiError(message || `API ${path} → ${response.status}`, response.status, detail)
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T
  return response.json()
}

export function fetchSkills() {
  return skillFetch<ManagedSkill[]>('/skills')
}

export function updateSkillEnabled(name: string, enabled: boolean) {
  return skillFetch<ManagedSkill>(`/skills/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
}

export function uploadSkillArchive(file: File) {
  const body = new FormData()
  body.append('file', file)
  return skillFetch<ManagedSkill[]>('/skills/upload', { method: 'POST', body })
}

export function deleteSkill(name: string) {
  return skillFetch<void>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
