import { apiFetch } from './client'

export type CreativeAsset = { id: number; asset_type: 'article' | 'media'; media_kind: '' | 'image' | 'video' | 'audio'; title: string; content: string; url: string; media_type: string; filename: string; directory: string; tags: string[]; source: string; created_at: string; updated_at: string }
const PUBLIC_API_BASE = process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:8000/api'
export const creativeAssetUrl = (url: string) => new URL(
  url,
  new URL(PUBLIC_API_BASE).origin,
).toString()
export const listCreativeAssets = (assetType?: CreativeAsset['asset_type']) => apiFetch<CreativeAsset[]>(`/assets${assetType ? `?asset_type=${assetType}` : ''}`)
export const createCreativeAsset = (body: Pick<CreativeAsset, 'asset_type' | 'media_kind' | 'title' | 'content' | 'url' | 'media_type' | 'filename' | 'directory' | 'tags'>) => apiFetch<CreativeAsset>('/assets', { method: 'POST', body: JSON.stringify(body) })
export const updateCreativeAsset = (id: number, body: Partial<Pick<CreativeAsset, 'title' | 'content' | 'url' | 'directory' | 'tags'>>) => apiFetch<CreativeAsset>(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export async function uploadCreativeAsset(mediaKind: 'image' | 'video' | 'audio', file: File) { const body = new FormData(); body.append('file', file); return apiFetch<CreativeAsset>(`/assets/upload?media_kind=${mediaKind}`, { method: 'POST', body, headers: {} }) }
export const deleteCreativeAsset = (id: number) => apiFetch<void>(`/assets/${id}`, { method: 'DELETE' })
export type TopicSourceRule = { id: number; subscription_id: number; directory: string; keywords: string[]; enabled: boolean; created_at: string; updated_at: string }
export const listTopicSourceRules = () => apiFetch<TopicSourceRule[]>('/assets/topic-rules')
export const createTopicSourceRule = (body: Pick<TopicSourceRule, 'subscription_id' | 'directory' | 'keywords'>) => apiFetch<TopicSourceRule>('/assets/topic-rules', { method: 'POST', body: JSON.stringify(body) })
export const dailyArticleCandidates = (directory: string) => apiFetch<{ assets: CreativeAsset[] }>(`/assets/daily-candidates?directory=${encodeURIComponent(directory)}`)
export const selectDailyArticleCandidates = (directory: string) => apiFetch<{ assets: CreativeAsset[] }>('/assets/daily-candidates', { method: 'POST', body: JSON.stringify({ directory }) })
export type CreativeAssetDirectory = { id: number; name: string; asset_type: 'article' | 'media'; parent_id: number | null; is_system: boolean; created_at: string }
export const listCreativeAssetDirectories = (assetType: 'article' | 'media') => apiFetch<CreativeAssetDirectory[]>(`/assets/directories?asset_type=${assetType}`)
export const createCreativeAssetDirectory = (name: string, assetType: 'article' | 'media', parentId: number | null = null) => apiFetch<CreativeAssetDirectory>('/assets/directories', { method: 'POST', body: JSON.stringify({ name, asset_type: assetType, parent_id: parentId }) })
export const renameCreativeAssetDirectory = (id: number, name: string) => apiFetch<CreativeAssetDirectory>(`/assets/directories/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
export const deleteCreativeAssetDirectory = (id: number) => apiFetch<void>(`/assets/directories/${id}`, { method: 'DELETE' })
