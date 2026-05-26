import { apiFetch, API_BASE } from './client'

export interface ProfileSummary {
  name: string
  is_default: boolean
  model: string
  skill_count: number
  display_name: string
  avatar_url: string
  description: string
}

export interface Toolset { name: string; label: string; emoji: string; enabled: boolean }
export interface McpServer { name: string; url: string; enabled: boolean }
export interface Skill { name: string; category: string; source: string; enabled: boolean }

export interface ProfileDetail {
  name: string
  is_default: boolean
  soul: string
  display_name: string
  avatar_url: string
  description: string
  toolsets: Toolset[]
  mcp_servers: McpServer[]
  skills: Skill[]
}

export interface ProfileMeta {
  id: string
  display_name: string
  avatar_url: string
  description: string
}

export const listProfiles = () =>
  apiFetch<{ profiles: ProfileSummary[] }>('/profiles').then(r => r.profiles)

export const getProfile = (name: string) =>
  apiFetch<ProfileDetail>(`/profiles/${encodeURIComponent(name)}`)

export const saveSoul = (name: string, content: string) =>
  apiFetch<{ ok: boolean }>(`/profiles/${encodeURIComponent(name)}/soul`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

export const createProfile = (body: {
  id: string
  display_name?: string
  clone_from?: string
  description?: string
}) => apiFetch<ProfileMeta>('/profiles', { method: 'POST', body: JSON.stringify(body) })

export const deleteProfile = (name: string) =>
  apiFetch<void>(`/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })

export const updateProfileMeta = (
  name: string,
  body: { display_name?: string; avatar_url?: string; description?: string },
) =>
  apiFetch<ProfileMeta>(`/profiles/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const generateAvatar = (name: string, prompt: string) =>
  apiFetch<{ avatar_url: string }>(`/profiles/${encodeURIComponent(name)}/avatar/generate`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  })

export async function uploadAvatar(name: string, file: File): Promise<{ avatar_url: string }> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${API_BASE}/profiles/${encodeURIComponent(name)}/avatar`, {
    method: 'POST',
    body: fd,
  })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export const toggleToolset = (profile: string, name: string, enabled: boolean) =>
  apiFetch<void>(`/profiles/${encodeURIComponent(profile)}/toolsets`, {
    method: 'POST',
    body: JSON.stringify({ name, enabled }),
  })

export const toggleMcp = (profile: string, name: string, enabled: boolean) =>
  apiFetch<void>(`/profiles/${encodeURIComponent(profile)}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ name, enabled }),
  })

export const toggleSkills = (profile: string, names: string[], enabled: boolean) =>
  apiFetch<void>(`/profiles/${encodeURIComponent(profile)}/skills`, {
    method: 'POST',
    body: JSON.stringify({ names, enabled }),
  })
