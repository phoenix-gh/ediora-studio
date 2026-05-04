import { Hotspot } from '@/lib/types'
import { apiFetch } from './client'
import { mockHotspots } from '@/mock/hotspots'

function toHotspot(raw: Record<string, unknown>): Hotspot {
  return {
    id: raw.id as string,
    title: raw.title as string,
    trend: raw.trend as Hotspot['trend'],
    platforms: raw.platforms as string[],
    heat: raw.heat as number,
    trendData: raw.trend_data as number[],
    category: raw.category as string,
    firstSeenAt: raw.first_seen_at as string,
  }
}

export interface HotspotFilters {
  categories?: string[]
  trends?: Hotspot['trend'][]
}

export async function getHotspots(limit?: number, filters?: HotspotFilters): Promise<Hotspot[]> {
  try {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    if (filters?.trends?.length === 1) params.set('trend', filters.trends[0])
    if (filters?.categories?.length === 1) params.set('category', filters.categories[0])
    const qs = params.toString() ? `?${params}` : ''
    const raw = await apiFetch<Record<string, unknown>[]>(`/hotspots${qs}`)
    let result = raw.map(toHotspot)
    if (filters?.categories?.length && filters.categories.length > 1) {
      result = result.filter(h => filters.categories!.includes(h.category))
    }
    return result
  } catch {
    let result = [...mockHotspots]
    if (filters?.categories?.length) result = result.filter(h => filters.categories!.includes(h.category))
    if (filters?.trends?.length) result = result.filter(h => filters.trends!.includes(h.trend))
    result.sort((a, b) => b.heat - a.heat)
    return limit ? result.slice(0, limit) : result
  }
}
