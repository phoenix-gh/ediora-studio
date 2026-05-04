import { apiFetch } from './client'

export interface Direction {
  id: number
  name: string
  description: string
  is_active: boolean
  created_at: string
}

export interface Strategy {
  id: number
  direction_id: number
  name: string
  filter_hours: number
  filter_min_views: number
  filter_viral_only: boolean
  filter_keywords: string[]
  filter_exclude_keywords: string[]
  llm_prompt: string
  output_count: number
  is_active: boolean
  created_at: string
}

export interface DirectionCreate {
  name: string
  description?: string
}

export interface DirectionUpdate {
  name?: string
  description?: string
  is_active?: boolean
}

export interface StrategyCreate {
  name: string
  filter_hours?: number
  filter_min_views?: number
  filter_viral_only?: boolean
  filter_keywords?: string[]
  filter_exclude_keywords?: string[]
  llm_prompt?: string
  output_count?: number
}

export interface StrategyUpdate extends Partial<StrategyCreate> {
  is_active?: boolean
}

export async function getDirections(): Promise<Direction[]> {
  return apiFetch<Direction[]>('/directions')
}

export async function createDirection(body: DirectionCreate): Promise<Direction> {
  return apiFetch<Direction>('/directions', { method: 'POST', body: JSON.stringify(body) })
}

export async function updateDirection(id: number, body: DirectionUpdate): Promise<Direction> {
  return apiFetch<Direction>(`/directions/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteDirection(id: number): Promise<void> {
  await apiFetch(`/directions/${id}`, { method: 'DELETE' })
}

export async function getStrategies(directionId: number): Promise<Strategy[]> {
  return apiFetch<Strategy[]>(`/directions/${directionId}/strategies`)
}

export async function createStrategy(directionId: number, body: StrategyCreate): Promise<Strategy> {
  return apiFetch<Strategy>(`/directions/${directionId}/strategies`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateStrategy(directionId: number, strategyId: number, body: StrategyUpdate): Promise<Strategy> {
  return apiFetch<Strategy>(`/directions/${directionId}/strategies/${strategyId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteStrategy(directionId: number, strategyId: number): Promise<void> {
  await apiFetch(`/directions/${directionId}/strategies/${strategyId}`, { method: 'DELETE' })
}

export async function generateTopics(directionId: number, strategyId: number): Promise<unknown[]> {
  return apiFetch<unknown[]>(`/directions/${directionId}/strategies/${strategyId}/generate`, {
    method: 'POST',
  })
}
