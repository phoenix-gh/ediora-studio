import { apiFetch } from './client'

export interface ProjectSkill {
  name: string
  description: string
  version: string
  tags: string[]
  installed: boolean
}

export const listProjectSkills = (profile: string) =>
  apiFetch<{ skills: ProjectSkill[] }>(
    `/profiles/${encodeURIComponent(profile)}/project-skills`,
  ).then(r => r.skills)

export const installProjectSkill = (profile: string, skill: string) =>
  apiFetch<{ ok: boolean }>(
    `/profiles/${encodeURIComponent(profile)}/project-skills/${encodeURIComponent(skill)}`,
    { method: 'POST' },
  )

export const uninstallProjectSkill = (profile: string, skill: string) =>
  apiFetch<void>(
    `/profiles/${encodeURIComponent(profile)}/project-skills/${encodeURIComponent(skill)}`,
    { method: 'DELETE' },
  )
