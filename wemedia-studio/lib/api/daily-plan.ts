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
