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

export interface Post {
  id: string
  accountId: string
  title: string
  content: string
  url: string
  publishedAt: string
  metrics: { likes: number; reposts: number; comments: number }
  isAbnormallyPopular: boolean
}

export interface Hotspot {
  id: string
  title: string
  trend: 'rising' | 'peak' | 'declining'
  platforms: string[]
  heat: number
  trendData: number[]
  category: string
  firstSeenAt: string
}

export type TopicStatus = Topic['status']
export type UrgencyLevel = Topic['urgency']

export interface EconomicItem {
  id: string
  title: string
  summary: string
  category: string
  impact: 'positive' | 'negative' | 'neutral'
  impact_level: 'high' | 'medium' | 'low'
  published_at: string
}

export interface GenerateResult {
  new_topics: number
  new_hotspots: number
  new_economic: number
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
}

export interface GithubIssue {
  id: string
  repo_id: string
  number: number
  title: string
  body: string
  labels: string[]
  state: string
  comments: number
  reactions: number
  html_url: string
  created_at: string
  updated_at: string
}

export interface IssuePainPoint {
  id: string
  repo_id: string
  title: string
  description: string
  issue_count: number
  example_issues: number[]
  category: string
  severity: string
  created_at: string
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
