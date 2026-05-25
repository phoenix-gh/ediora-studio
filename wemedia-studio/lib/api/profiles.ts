import { apiFetch } from './client'

export interface ProfileSummary {
  name: string
  is_default: boolean
  model: string
  skill_count: number
}

export interface Toolset { name: string; label: string; emoji: string; enabled: boolean }
export interface McpServer { name: string; url: string; enabled: boolean }
export interface Skill { name: string; category: string; source: string; enabled: boolean }

export interface ProfileDetail {
  name: string
  is_default: boolean
  soul: string
  toolsets: Toolset[]
  mcp_servers: McpServer[]
  skills: Skill[]
}

export const listProfiles = () =>
  apiFetch<{ profiles: ProfileSummary[] }>('/profiles').then(r => r.profiles)

export const getProfile = (name: string) =>
  apiFetch<ProfileDetail>(`/profiles/${encodeURIComponent(name)}`)

export const saveSoul = (name: string, content: string) =>
  apiFetch<void>(`/profiles/${encodeURIComponent(name)}/soul`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

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
