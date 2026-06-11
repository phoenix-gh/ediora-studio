export interface Source {
  id: string
  platform: 'HN' | 'X' | '知乎' | '微博' | 'arXiv' | 'GitHub' | 'Reddit' | '36Kr' | '少数派' | '量子位' | '来源'
  title: string
  url: string
  publishedAt: string
  type: 'primary' | 'secondary' | 'discussion'
}

export interface Topic {
  id: string
  title: string
  summary: string
  score: number
  urgency: 'urgent' | 'this_week' | 'long_tail'
  tags: string[]
  category: string
  sources: Source[]
  competitorCount: number
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected' | 'snoozed' | 'transferred'
  recommendReason: string
  trendData: number[]
  directionId?: number | null
  directionName?: string
  strategyId?: number | null
  strategyName?: string
  clusterId?: string
  clusterTitle?: string
  clusterSourceCount?: number
}

export interface FollowedAccount {
  id: string
  name: string
  avatar: string
  platform: string
  group: string
  priority: 'high' | 'normal'
  muted: boolean
}

export type TopicStatus = Topic['status']
export type UrgencyLevel = Topic['urgency']

export interface GenerateResult {
  new_topics: number
  message: string
}

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
