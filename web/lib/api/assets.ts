import { API_BASE, apiFetch } from './client'

export type CreativeAssetType = 'article' | 'media' | 'prompt'
export type PromptKind = 'image' | 'video' | 'other'
export type CreativeAsset = { id: number; asset_type: CreativeAssetType; prompt_kind?: PromptKind | ''; media_kind: '' | 'image' | 'video' | 'audio'; title: string; content: string; url: string; media_type: string; filename: string; directory: string; tags: string[]; source: string; created_at: string; updated_at: string }
const PUBLIC_API_BASE = process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:8000/api'
export const creativeAssetUrl = (url: string) => {
  if (typeof window !== 'undefined') {
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return url
    const path = url.startsWith('/api/') ? url.slice('/api'.length) : url
    return new URL(`${API_BASE}${path}`, window.location.origin).toString()
  }
  return new URL(url, new URL(PUBLIC_API_BASE).origin).toString()
}
export const listCreativeAssets = (assetType?: CreativeAsset['asset_type']) => apiFetch<CreativeAsset[]>(`/assets${assetType ? `?asset_type=${assetType}` : ''}`)
export type CreativeAssetCreate = { asset_type: CreativeAssetType; prompt_kind?: PromptKind; media_kind: CreativeAsset['media_kind'] | null; title: string; content: string; url: string; media_type: string; filename: string; directory: string; tags: string[] }
export const createCreativeAsset = (body: CreativeAssetCreate) => apiFetch<CreativeAsset>('/assets', { method: 'POST', body: JSON.stringify(body) })
export const updateCreativeAsset = (id: number, body: Partial<Pick<CreativeAsset, 'prompt_kind' | 'title' | 'content' | 'url' | 'directory' | 'tags'>>) => apiFetch<CreativeAsset>(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export async function uploadCreativeAsset(
  mediaKind: 'image' | 'video' | 'audio',
  file: File,
  directory = '',
) {
  const body = new FormData()
  body.append('file', file)
  const query = new URLSearchParams({ media_kind: mediaKind })
  if (directory) query.set('directory', directory)
  return apiFetch<CreativeAsset>(`/assets/upload?${query.toString()}`, {
    method: 'POST',
    body,
    headers: {},
  })
}
export type RemoteImageImportItem = { source_url: string; url: string; error_code: string; error: string }
export const importCreativeAssetImages = async (urls: string[]) => (
  await apiFetch<{ items: RemoteImageImportItem[] }>('/assets/images/import', {
    method: 'POST',
    body: JSON.stringify({ urls }),
  })
).items
export async function uploadInlineAssetImage(file: File) {
  const body = new FormData()
  body.append('file', file)
  const result = await apiFetch<{ url: string }>('/upload/image', {
    method: 'POST',
    body,
    headers: {},
  })
  return result.url
}
export const deleteCreativeAsset = (id: number) => apiFetch<void>(`/assets/${id}`, { method: 'DELETE' })
export type PromptGeneration = {
  id: number
  prompt_asset_id: number
  media_asset_id: number | null
  provider: string
  model: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  job_id: number | null
  error: string
  generated_at: string | null
  created_at: string
  media: CreativeAsset | null
}
export const listPromptGenerations = (promptAssetId: number, limit?: number) => apiFetch<PromptGeneration[]>(`/assets/${promptAssetId}/generations${limit ? `?limit=${limit}` : ''}`)
export const createPromptGeneration = (promptAssetId: number) => apiFetch<PromptGeneration>(`/assets/${promptAssetId}/generations`, { method: 'POST' })
export const attachPromptGeneration = (promptAssetId: number, mediaAssetId: number, provider = '', model = '') => apiFetch<PromptGeneration>(`/assets/${promptAssetId}/generations/attach`, { method: 'POST', body: JSON.stringify({ media_asset_id: mediaAssetId, provider, model }) })
export const deletePromptGeneration = (promptAssetId: number, generationId: number) => apiFetch<void>(`/assets/${promptAssetId}/generations/${generationId}`, { method: 'DELETE' })
export type TopicSourceRule = { id: number; subscription_id: number; directory: string; keywords: string[]; screening_prompt: string; enabled: boolean; created_at: string; updated_at: string }
export const listTopicSourceRules = () => apiFetch<TopicSourceRule[]>('/assets/topic-rules')
export const createTopicSourceRule = (body: Pick<TopicSourceRule, 'subscription_id' | 'directory' | 'keywords' | 'screening_prompt'>) => apiFetch<TopicSourceRule>('/assets/topic-rules', { method: 'POST', body: JSON.stringify(body) })
export const updateTopicSourceRule = (id: number, body: Partial<Pick<TopicSourceRule, 'directory' | 'keywords' | 'screening_prompt' | 'enabled'>>) => apiFetch<TopicSourceRule>(`/assets/topic-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export const dailyArticleCandidates = (directory: string) => apiFetch<{ assets: CreativeAsset[] }>(`/assets/daily-candidates?directory=${encodeURIComponent(directory)}`)
export const selectDailyArticleCandidates = (directory: string) => apiFetch<{ assets: CreativeAsset[] }>('/assets/daily-candidates', { method: 'POST', body: JSON.stringify({ directory }) })
export type CreativeAssetDirectory = {
  id: number
  name: string
  asset_type: CreativeAssetType
  parent_id: number | null
  is_system: boolean
  ai_ingestion_enabled: boolean
  ai_ingestion_keywords: string[]
  ai_ingestion_prompt: string
  created_at: string
}
export const listCreativeAssetDirectories = (assetType: CreativeAssetType) => apiFetch<CreativeAssetDirectory[]>(`/assets/directories?asset_type=${assetType}`)
export const createCreativeAssetDirectory = (name: string, assetType: CreativeAssetType, parentId: number | null = null) => apiFetch<CreativeAssetDirectory>('/assets/directories', { method: 'POST', body: JSON.stringify({ name, asset_type: assetType, parent_id: parentId }) })
export const renameCreativeAssetDirectory = (id: number, name: string, assetType: CreativeAssetType = 'article') => apiFetch<CreativeAssetDirectory>(`/assets/directories/${id}`, { method: 'PATCH', body: JSON.stringify({ name, asset_type: assetType }) })
export const deleteCreativeAssetDirectory = (id: number) => apiFetch<void>(`/assets/directories/${id}`, { method: 'DELETE' })
export type CreativeAssetDirectoryIngestionRule = { directory_id: number; enabled: boolean; keywords: string[]; prompt: string }
export const updateCreativeAssetDirectoryIngestionRule = (id: number, body: Pick<CreativeAssetDirectoryIngestionRule, 'enabled' | 'keywords' | 'prompt'>) => apiFetch<CreativeAssetDirectoryIngestionRule>(`/assets/directories/${id}/ingestion-rule`, { method: 'PUT', body: JSON.stringify(body) })
