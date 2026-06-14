export interface GithubRepo {
  id: string
  owner: string
  repo: string
  description: string
  stars: number
  language: string
  group: string
  muted: boolean
  collect_interval_minutes: number
  last_collected_at: string | null
  release_draft_enabled: boolean
  release_draft_types: string[]
}

export interface GithubRelease {
  id: string
  repo_id: string
  tag_name: string
  name: string
  body: string
  is_prerelease: boolean
  is_draft: boolean
  html_url: string
  published_at: string
  draft_generated_at: string | null
}

export interface GithubTrendingRepo {
  id: string
  owner: string
  repo: string
  description: string
  language: string
  stars: number
  stars_gained: number
  period: string
  trending_date: string
  url: string
}
