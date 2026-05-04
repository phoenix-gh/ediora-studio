import { EconomicItem } from '@/lib/types'
import { apiFetch } from './client'

function toEconomicItem(raw: Record<string, unknown>): EconomicItem {
  return {
    id: raw.id as string,
    title: raw.title as string,
    summary: raw.summary as string,
    category: raw.category as string,
    impact: raw.impact as EconomicItem['impact'],
    impact_level: raw.impact_level as EconomicItem['impact_level'],
    published_at: raw.published_at as string,
  }
}

export async function getEconomicItems(params?: { category?: string; impact?: string }): Promise<EconomicItem[]> {
  try {
    const qs = new URLSearchParams()
    if (params?.category) qs.set('category', params.category)
    if (params?.impact) qs.set('impact', params.impact)
    const raw = await apiFetch<Record<string, unknown>[]>(`/economic${qs.size ? '?' + qs : ''}`)
    return raw.map(toEconomicItem)
  } catch {
    return []
  }
}

export async function triggerGenerateEconomic(): Promise<{ new_economic: number; message: string }> {
  return apiFetch('/economic/generate', { method: 'POST', next: { revalidate: 0 } as RequestInit['next'] })
}
