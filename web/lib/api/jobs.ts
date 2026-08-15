import { API_BASE, apiFetch } from './client'
import type { DailyCreationAgentLog } from './creation-rules'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobKind = 'scheduled' | 'manual'

export interface JobScheduleSummary {
  run_id: number
  rule_name: string
  trigger_kind: string
  scheduled_for: string
}

export interface ContentJobStep {
  id: number
  key: string
  attempt: number
  status: JobStatus
  output: Record<string, unknown>
  error: string
  retryable: boolean
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface ContentJobEvent {
  id: number
  kind: string
  payload: Record<string, unknown>
  created_at: string
}

export interface ContentJob {
  id: number
  flow: string
  title: string
  status: JobStatus
  input?: Record<string, unknown>
  schedule?: JobScheduleSummary | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  steps: ContentJobStep[]
  events: ContentJobEvent[]
}

export interface JobListOptions {
  limit?: number
  cursor?: string | null
  kind?: JobKind
  status?: JobStatus
}

export interface JobListPage {
  jobs: ContentJob[]
  next_cursor: string | null
  has_more: boolean
}

export function imageUrlsForJob(job: ContentJob) {
  const apiOrigin = new URL(API_BASE).origin
  return job.steps.flatMap(step => {
    const assetUrls = step.output.asset_urls
    if (Array.isArray(assetUrls)) return assetUrls.filter((url): url is string => typeof url === 'string')
    return typeof step.output.asset_url === 'string' ? [step.output.asset_url] : []
  }).map(url => new URL(url, apiOrigin).toString())
}

export function listJobs(options: JobListOptions = {}) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 30) })
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.kind) params.set('kind', options.kind)
  if (options.status) params.set('status', options.status)
  return apiFetch<JobListPage>(`/jobs?${params.toString()}`)
}
export function createJob(body: { flow: string; title: string; input: Record<string, unknown>; idempotency_key?: string }) {
  return apiFetch<ContentJob>('/jobs', { method: 'POST', body: JSON.stringify(body) })
}
export function getJob(id: number) { return apiFetch<ContentJob>(`/jobs/${id}`) }
export function getJobAgentLog(id: number) { return apiFetch<DailyCreationAgentLog>(`/jobs/${id}/agent-log`) }
export function cancelJob(id: number) { return apiFetch<ContentJob>(`/jobs/${id}/cancel`, { method: 'POST' }) }
export function retryJobStep(id: number, stepKey: string) {
  return apiFetch<ContentJob>(`/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({ step_key: stepKey }) })
}
export function recordJobEvent(id: number, kind: string, payload: Record<string, unknown> = {}) {
  return apiFetch(`/jobs/${id}/events`, { method: 'POST', body: JSON.stringify({ kind, payload }) })
}
