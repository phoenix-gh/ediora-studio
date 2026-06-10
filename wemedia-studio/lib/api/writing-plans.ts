import { apiFetch } from './client'
import { CoverStyle } from './publish-accounts'

export interface PlanTag {
  id: number
  name: string
  color: string
}

export interface PlanSource {
  id: number
  plan_id: number
  url: string
  title: string
  content: string
  note: string
  platform: string
  draft_id: number | null
  created_at: string
}

export interface WritingPlan {
  id: number
  title: string
  strategy: string
  description: string
  priority: number
  status: string
  created_at: string
  updated_at: string
  cover_style?: CoverStyle
  image_style?: string
  genre?: string
  tags: PlanTag[]
  sources: PlanSource[]
  source_count: number
  draft_count: number
}

export interface WritingPlanCreate {
  title: string
  strategy?: string
  tags?: string[]
  priority?: number
  cover_style?: CoverStyle
  image_style?: string
  genre?: string
}

export interface WritingPlanUpdate {
  title?: string
  strategy?: string
  tags?: string[]
  priority?: number
  status?: string
  cover_style?: CoverStyle
  image_style?: string
  genre?: string
}

export interface PlanSourceCreate {
  plan_id: number
  url?: string
  title?: string
  content?: string
  note?: string
  platform?: string
  draft_id?: number | null
}

export interface DraftSummary {
  id: number
  title: string
  status: string
  draft_type: string
  created_at: string
}

export interface DispatchResult {
  task_id: string
  kanban_url: string
}

export interface PlanUpdate {
  id: number
  plan_id: number
  source_url: string
  description: string
  created_at: string
}

export interface AnalyzeRequest {
  url?: string
  content?: string
}

export interface AnalyzeResult {
  task_id: string
  kanban_url: string
}

export const PLATFORMS = [
  { value: 'x',      label: 'X / Twitter' },
  { value: 'github', label: 'GitHub' },
  { value: 'wechat', label: '微信公众号' },
  { value: 'manual', label: '手动录入' },
  { value: 'self',   label: '自己发布' },
]

export async function getWritingPlans(tags?: string[]): Promise<WritingPlan[]> {
  const params = tags?.length ? `?tags=${tags.join(',')}` : ''
  return apiFetch<WritingPlan[]>(`/writing-plans${params}`)
}

export async function getTags(): Promise<PlanTag[]> {
  return apiFetch<PlanTag[]>('/writing-plans/tags')
}

export async function createTag(name: string): Promise<PlanTag> {
  return apiFetch<PlanTag>('/writing-plans/tags', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteTag(id: number): Promise<void> {
  await apiFetch(`/writing-plans/tags/${id}`, { method: 'DELETE' })
}

export async function createWritingPlan(body: WritingPlanCreate): Promise<WritingPlan> {
  return apiFetch<WritingPlan>('/writing-plans', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateWritingPlan(id: number, body: WritingPlanUpdate): Promise<WritingPlan> {
  return apiFetch<WritingPlan>(`/writing-plans/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteWritingPlan(id: number): Promise<void> {
  await apiFetch(`/writing-plans/${id}`, { method: 'DELETE' })
}

export async function getPlanDrafts(planId: number): Promise<DraftSummary[]> {
  return apiFetch<DraftSummary[]>(`/writing-plans/${planId}/drafts`)
}

export async function dispatchPlan(
  planId: number,
  opts: { accountId?: string; angle?: string; draftType?: string; coverStyle?: CoverStyle; imageStyle?: string } = {},
): Promise<DispatchResult> {
  return apiFetch<DispatchResult>(`/writing-plans/${planId}/dispatch`, {
    method: 'POST',
    body: JSON.stringify({
      account_id: opts.accountId ?? null,
      angle: opts.angle,
      draft_type: opts.draftType ?? 'article',
      cover_style: opts.coverStyle,
      image_style: opts.imageStyle,
    }),
  })
}

export async function analyzePlan(body: AnalyzeRequest): Promise<AnalyzeResult> {
  return apiFetch<AnalyzeResult>('/writing-plans/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function reanalyzePlan(planId: number, suggestions?: string): Promise<AnalyzeResult> {
  return apiFetch<AnalyzeResult>(`/writing-plans/${planId}/reanalyze`, {
    method: 'POST',
    body: JSON.stringify({ suggestions: suggestions ?? '' }),
  })
}

export async function getAnalyzePrompt(): Promise<string> {
  const res = await apiFetch<{ instructions: string }>('/writing-plans/analyze-prompt')
  return res.instructions
}

export async function updateAnalyzePrompt(instructions: string): Promise<void> {
  await apiFetch('/writing-plans/analyze-prompt', {
    method: 'PUT',
    body: JSON.stringify({ instructions }),
  })
}

export async function getPlanUpdates(planId: number): Promise<PlanUpdate[]> {
  return apiFetch<PlanUpdate[]>(`/writing-plans/${planId}/updates`)
}

export async function addPlanSource(planId: number, body: Omit<PlanSourceCreate, 'plan_id'>): Promise<PlanSource> {
  return apiFetch<PlanSource>(`/writing-plans/${planId}/sources`, {
    method: 'POST',
    body: JSON.stringify({ ...body, plan_id: planId }),
  })
}

export async function deletePlanSource(planId: number, sourceId: number): Promise<void> {
  await apiFetch(`/writing-plans/${planId}/sources/${sourceId}`, { method: 'DELETE' })
}

// ── Legacy helpers (plans are now flat; kept for call-site compatibility) ─────

export function flattenTopics(plans: WritingPlan[]): WritingPlan[] {
  return plans
}

export interface FlatTopic {
  plan: WritingPlan
  depth: number
  label: string
}

export function flattenTopicsWithDepth(plans: WritingPlan[]): FlatTopic[] {
  return plans.map(p => ({ plan: p, depth: 0, label: p.title }))
}
