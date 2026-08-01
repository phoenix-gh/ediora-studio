import { apiFetch } from './client'

export type SkillSource = 'builtin' | 'uploaded'

export type ManagedSkill = {
  name: string
  description: string
  version: string
  source: SkillSource
  enabled: boolean
}

export function fetchSkills() {
  return apiFetch<ManagedSkill[]>('/skills')
}

export function updateSkillEnabled(name: string, enabled: boolean) {
  return apiFetch<ManagedSkill>(`/skills/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
}

export function uploadSkillArchive(file: File) {
  const body = new FormData()
  body.append('file', file)
  return apiFetch<ManagedSkill[]>('/skills/upload', { method: 'POST', body })
}

export function deleteSkill(name: string) {
  return apiFetch<void>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
