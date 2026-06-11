import { GithubRepo, GithubTrendingRepo, GithubRelease } from '@/lib/types'
import { apiFetch } from './client'

export async function getGithubRepos(): Promise<GithubRepo[]> {
  return apiFetch<GithubRepo[]>('/github/repos')
}

export async function addGithubRepo(owner: string, repo: string, group = '未分组', interval = 60): Promise<GithubRepo> {
  return apiFetch<GithubRepo>('/github/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, repo, group, collect_interval_minutes: interval }),
  })
}

export async function updateGithubRepo(
  owner: string, repo: string,
  body: { group?: string; muted?: boolean; collect_interval_minutes?: number; release_draft_enabled?: boolean; release_draft_types?: string[] }
): Promise<GithubRepo> {
  return apiFetch<GithubRepo>(`/github/repos/${owner}/${repo}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteGithubRepo(owner: string, repo: string): Promise<void> {
  await apiFetch(`/github/repos/${owner}/${repo}`, { method: 'DELETE' })
}

export async function getTrendingRepos(period: 'daily' | 'weekly' = 'daily'): Promise<GithubTrendingRepo[]> {
  return apiFetch<GithubTrendingRepo[]>(`/github/trending?period=${period}`)
}

export async function getGithubReleases(repoId?: string, limit = 30): Promise<GithubRelease[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (repoId) params.set('repo_id', repoId)
  return apiFetch<GithubRelease[]>(`/github/releases?${params}`)
}

export async function dispatchReleaseWrite(
  owner: string, repo: string, tag: string,
  accountId: string, planId: number, withCover: boolean,
): Promise<{ task_id: string; kanban_url: string }> {
  return apiFetch<{ task_id: string; kanban_url: string }>(
    `/github/releases/${owner}/${repo}/${encodeURIComponent(tag)}/dispatch-write`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, plan_id: planId, with_cover: withCover }),
    }
  )
}

export async function dispatchRepoIntro(
  owner: string, repo: string,
  accountId: string, planId: number, withCover: boolean,
): Promise<{ task_id: string; kanban_url: string }> {
  return apiFetch<{ task_id: string; kanban_url: string }>(
    `/github/repos/${owner}/${repo}/dispatch-intro`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, plan_id: planId, with_cover: withCover }),
    }
  )
}

export async function generateReleaseDraft(
  owner: string, repo: string, tag: string
): Promise<{ drafts_created: number }> {
  return apiFetch<{ drafts_created: number }>(
    `/github/releases/${owner}/${repo}/${encodeURIComponent(tag)}/generate-draft`,
    { method: 'POST' }
  )
}

export async function collectAllGithub(): Promise<{ ok: boolean }> {
  return apiFetch('/github/collect', { method: 'POST' })
}

export async function collectOneRepo(owner: string, repo: string): Promise<{ repo_id: string }> {
  return apiFetch(`/github/collect/${owner}/${repo}`, { method: 'POST' })
}

export async function collectOneRepoReleases(owner: string, repo: string): Promise<{ new_releases: number }> {
  return apiFetch(`/github/collect/${owner}/${repo}/releases-only`, { method: 'POST' })
}
