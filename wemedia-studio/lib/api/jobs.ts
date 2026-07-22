import { apiFetch } from './client'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

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

export interface ContentJob {
  id: number
  flow: string
  title: string
  status: JobStatus
  created_at: string
  started_at: string | null
  completed_at: string | null
  steps: ContentJobStep[]
}

export function listJobs() { return apiFetch<{ jobs: ContentJob[] }>('/jobs') }
export function getJob(id: number) { return apiFetch<ContentJob>(`/jobs/${id}`) }
export function cancelJob(id: number) { return apiFetch<ContentJob>(`/jobs/${id}/cancel`, { method: 'POST' }) }
export function retryJobStep(id: number, stepKey: string) {
  return apiFetch<ContentJob>(`/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({ step_key: stepKey }) })
}
