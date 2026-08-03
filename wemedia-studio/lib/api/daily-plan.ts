import { apiFetch } from './client'

export interface PlanItemSource {
  platform: string
  title: string
  url: string
}

export interface DailyPlanItem {
  id: number
  account_id: string
  account_name: string
  title: string
  angle: string
  reason: string
  content_type: 'long' | 'short' | 'story' | 'share'
  sources: PlanItemSource[]
  group_key: string
  is_primary: boolean
  status: 'suggested' | 'skipped' | 'enqueued'
  pipeline_task_id: number | null
  draft_id: number | null
}

export interface DailyPlan {
  id: number
  plan_date: string
  status: 'planning' | 'ready' | 'failed'
  planner_note: string
  kanban_task_id: string
  items: DailyPlanItem[]
}

export interface TodayPlanResponse {
  plan: DailyPlan | null
}

export function getTodayPlan(): Promise<TodayPlanResponse> {
  return apiFetch<TodayPlanResponse>('/daily-plan/today')
}

export function generatePlan(): Promise<{ plan_id: number; status: string }> {
  return apiFetch('/daily-plan/generate', { method: 'POST' })
}

export function enqueuePlanItems(
  planId: number,
  itemIds: number[],
): Promise<{ enqueued_items: number; chains: number; task_ids: string[] }> {
  return apiFetch(`/daily-plan/${planId}/enqueue`, {
    method: 'POST',
    body: JSON.stringify({ item_ids: itemIds }),
  })
}

export function toggleSkipItem(itemId: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/daily-plan/items/${itemId}/skip`, { method: 'POST' })
}

export type DailyCreationRule = {
  id: number; name: string; asset_type: 'article' | 'media'; directory: string; directories?: string[]
  output_type: 'x_short_post'; target_count: number; execution_mode: 'once' | 'recurring'
  scheduled_date: string | null; scheduled_time: string; timezone: string; lookback_days: number
  delivery_mode: 'drafts' | 'plan_items'; account_id: string | null; instructions: string
  enabled: boolean; created_at: string; updated_at: string
}
export type DailyCreationRuleInput = Omit<DailyCreationRule, 'id' | 'created_at' | 'updated_at' | 'directories'> & { directories: string[] }
export type DailyCreationRun = {
  id: number; rule_id: number; content_job_id: number | null; scheduled_for: string
  trigger_kind: string; status: 'queued' | 'running' | 'failed' | 'partial' | 'succeeded'
  requested_count: number; created_count: number; detail: Record<string, unknown>
  rule: Partial<DailyCreationRule>; created_at: string
}

export const listCreationRules = () => apiFetch<DailyCreationRule[]>('/daily-plan/creation-rules')
export const createCreationRule = (input: DailyCreationRuleInput) => apiFetch<DailyCreationRule>('/daily-plan/creation-rules', { method: 'POST', body: JSON.stringify(input) })
export const updateCreationRule = (id: number, input: Partial<DailyCreationRuleInput>) => apiFetch<DailyCreationRule>(`/daily-plan/creation-rules/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
export const deleteCreationRule = (id: number) => apiFetch<void>(`/daily-plan/creation-rules/${id}`, { method: 'DELETE' })
export const runCreationRule = (id: number) => apiFetch<DailyCreationRun>(`/daily-plan/creation-rules/${id}/run`, { method: 'POST' })
export const listCreationRuns = () => apiFetch<DailyCreationRun[]>('/daily-plan/creation-runs')
