import { apiFetch } from './client'

export interface Quote {
  id: number
  text: string
  author: string
  source: string
  source_url: string
  scene_tags: string[]
  writing_plan_id: number | null
  platform: string
  created_at: string
  updated_at: string
}

export interface QuoteCreate {
  text: string
  author?: string
  source?: string
  source_url?: string
  scene_tags?: string[]
  writing_plan_id?: number | null
  platform?: string
}

export interface QuoteUpdate {
  text?: string
  author?: string
  source?: string
  source_url?: string
  scene_tags?: string[]
  writing_plan_id?: number | null
}

export const SCENE_TAGS = [
  { value: 'opener',    label: '开头用',  color: 'bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' },
  { value: 'closer',    label: '收尾用',  color: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400' },
  { value: 'argument',  label: '论据',    color: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  { value: 'twist',     label: '反转',    color: 'bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400' },
  { value: 'resonance', label: '共鸣',    color: 'bg-pink-100 text-pink-600 dark:bg-pink-950/40 dark:text-pink-400' },
  { value: 'warning',   label: '警示',    color: 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
]

export function sceneTagInfo(value: string) {
  return SCENE_TAGS.find(t => t.value === value) ?? { value, label: value, color: 'bg-zinc-100 text-zinc-500' }
}

export async function getQuotes(params?: { q?: string; tag?: string; topic_id?: number }): Promise<Quote[]> {
  const qs = new URLSearchParams()
  if (params?.q) qs.set('q', params.q)
  if (params?.tag) qs.set('tag', params.tag)
  if (params?.topic_id) qs.set('topic_id', String(params.topic_id))
  return apiFetch<Quote[]>(`/quotes${qs.toString() ? '?' + qs : ''}`)
}

export async function createQuote(body: QuoteCreate): Promise<Quote> {
  return apiFetch<Quote>('/quotes', { method: 'POST', body: JSON.stringify(body) })
}

export async function updateQuote(id: number, body: QuoteUpdate): Promise<Quote> {
  return apiFetch<Quote>(`/quotes/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteQuote(id: number): Promise<void> {
  await apiFetch(`/quotes/${id}`, { method: 'DELETE' })
}
