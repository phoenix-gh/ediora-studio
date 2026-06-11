import { apiFetch } from './client'

export interface DashboardAlert {
  severity: 'error' | 'warn' | 'info'
  text: string
  action_label: string
  href: string
}

export interface ReleaseToday {
  repo_id: string
  tag_name: string
  name: string
  published_at: string
  is_prerelease: boolean
  html_url: string
  draft_ids: number[]
}

export interface SourceStatus {
  key: string
  name: string
  href: string
  schedule: string
  last_status: 'ok' | 'warn' | 'error' | null
  last_message: string
  last_run_at: string | null
  today_new: number
}

export interface DashboardOverview {
  alerts: DashboardAlert[]
  releases_today: ReleaseToday[]
  sources: SourceStatus[]
  today_output: { topics: number; drafts: number }
  errors: string[]
  generated_at: string
}

export const EMPTY_OVERVIEW: DashboardOverview = {
  alerts: [],
  releases_today: [],
  sources: [],
  today_output: { topics: 0, drafts: 0 },
  errors: [],
  generated_at: '',
}

export function getDashboardOverview(): Promise<DashboardOverview> {
  return apiFetch<DashboardOverview>('/dashboard/overview')
}
