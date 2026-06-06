import { apiFetch } from './client'

export interface Material {
  id: number
  platform: string
  source_id: string | null
  text: string
  text_clean: string
  author: string
  handle: string
  source: string
  source_url: string
  cover_image: string
  likes: number; reposts: number; replies: number; views: number
  score: number
  category: string
  scene_tags: string[]
  tags: string[]
  writing_plan_id: number | null
  status: string
  published_at: string | null
  created_at: string
}

export interface MaterialCreate {
  text: string; author?: string; source?: string; source_url?: string
  category?: string; scene_tags?: string[]; tags?: string[]; writing_plan_id?: number | null
}

export interface CollectRule {
  id: number; label: string; source_subscription_id: number | null
  min_faves: number; min_retweets: number
  lang: string; days: number; exclude_sensitive: boolean
  extra_terms: string; raw_query: string; sort: string; max_results: number
  enabled: boolean; last_collected_at: string | null; last_error: string
}

// 使用场景（与后端 SCENE_TAGS 一致，沿用金句库配色）
export const SCENE_TAGS = [
  { value: 'opener',    label: '开头用', color: 'bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' },
  { value: 'closer',    label: '收尾用', color: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400' },
  { value: 'argument',  label: '论据',   color: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  { value: 'twist',     label: '反转',   color: 'bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400' },
  { value: 'resonance', label: '共鸣',   color: 'bg-pink-100 text-pink-600 dark:bg-pink-950/40 dark:text-pink-400' },
  { value: 'warning',   label: '警示',   color: 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
]
export function sceneTagInfo(v: string) {
  return SCENE_TAGS.find(t => t.value === v) ?? { value: v, label: v, color: 'bg-zinc-100 text-zinc-500' }
}

export async function getMaterials(params: Record<string, string | number> = {}): Promise<Material[]> {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v !== 0) qs.set(k, String(v)) })
  return apiFetch<Material[]>(`/materials${qs.toString() ? '?' + qs : ''}`)
}
export async function createMaterial(body: MaterialCreate): Promise<Material> {
  return apiFetch<Material>('/materials', { method: 'POST', body: JSON.stringify(body) })
}
export async function updateMaterial(id: number, body: Partial<MaterialCreate> & { status?: string }): Promise<Material> {
  return apiFetch<Material>(`/materials/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}
export async function deleteMaterial(id: number): Promise<void> {
  await apiFetch(`/materials/${id}`, { method: 'DELETE' })
}
export async function getCategories(): Promise<string[]> {
  return apiFetch<string[]>('/materials/categories')
}
export async function getRules(): Promise<CollectRule[]> {
  return apiFetch<CollectRule[]>('/materials/rules')
}
export async function createRule(body: Partial<CollectRule>): Promise<CollectRule> {
  return apiFetch<CollectRule>('/materials/rules', { method: 'POST', body: JSON.stringify(body) })
}
export async function updateRule(id: number, body: Partial<CollectRule>): Promise<CollectRule> {
  return apiFetch<CollectRule>(`/materials/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}
export async function deleteRule(id: number): Promise<void> {
  await apiFetch(`/materials/rules/${id}`, { method: 'DELETE' })
}
export async function collectRule(id: number): Promise<{ new_raw: number }> {
  return apiFetch(`/materials/rules/${id}/collect`, { method: 'POST' })
}
export async function collectAll(): Promise<{ new_raw: number; failed: string[] }> {
  return apiFetch('/materials/collect-all', { method: 'POST' })
}

export async function getRawCount(): Promise<number> {
  const items = await apiFetch<Material[]>('/materials?status=raw&limit=1000')
  return items.length
}

export interface CleanBatchResult {
  processed: number
  kept: number
  rejected: number
  remaining_raw: number
}

export async function cleanBatch(size?: number): Promise<CleanBatchResult> {
  return apiFetch('/materials/clean-batch', {
    method: 'POST',
    body: JSON.stringify(size !== undefined ? { size } : {}),
  })
}
