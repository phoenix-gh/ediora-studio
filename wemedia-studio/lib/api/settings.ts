import { apiFetch } from './client'

export interface ProviderInfo {
  key: string
  label: string
  base_url: string
  default_model: string
}

export interface AppSettings {
  llm_provider: string
  llm_model: string
  llm_base_url: string
  llm_effective_base_url: string
  llm_api_key_set: boolean
  llm_api_key_preview: string
  embedding_model: string
  embedding_base_url: string
  embedding_api_key_set: boolean
  embedding_api_key_preview: string
  embedding_similarity_threshold: number
  rsshub_base: string
  github_token_set: boolean
  github_token_preview: string
  collect_interval_minutes: number
  github_interval_minutes: number
  github_trending_interval_hours: number
  camofox_url: string
  camofox_api_key_set: boolean
  camofox_user_id: string
  camofox_novnc_url: string
  x_collect_enabled: boolean
  x_cookies_set: boolean
  x_collect_interval_minutes: number
  x_follower_threshold: number
  x_post_window_hours: number
  x_post_lookback_hours: number
  x_timeline_scrolls: number
  twitterapi_io_key_set: boolean
  x_search_queries: string
  arxiv_categories: string
  arxiv_collect_interval_hours: number
  providers: ProviderInfo[]
}

export interface SettingsUpdate {
  llm_provider?: string
  llm_model?: string
  llm_api_key?: string
  llm_base_url?: string
  embedding_model?: string
  embedding_base_url?: string
  embedding_api_key?: string
  embedding_similarity_threshold?: number
  rsshub_base?: string
  github_token?: string
  collect_interval_minutes?: number
  github_interval_minutes?: number
  github_trending_interval_hours?: number
  camofox_url?: string
  camofox_api_key?: string
  camofox_user_id?: string
  camofox_novnc_url?: string
  x_collect_enabled?: boolean
  x_cookies?: string
  x_collect_interval_minutes?: number
  x_follower_threshold?: number
  x_post_window_hours?: number
  x_post_lookback_hours?: number
  x_timeline_scrolls?: number
  twitterapi_io_key?: string
  x_search_queries?: string
  arxiv_categories?: string
  arxiv_collect_interval_hours?: number
}

export interface FetchModelsRequest {
  provider?: string
  api_key?: string
  base_url?: string
}

export interface FetchModelsResult {
  ok: boolean
  models: string[]
  error?: string
}

export async function getSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings')
}

export async function updateSettings(body: SettingsUpdate): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function fetchProviderModels(body: FetchModelsRequest): Promise<FetchModelsResult> {
  return apiFetch<FetchModelsResult>('/settings/fetch-models', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function testLLM(): Promise<{ ok: boolean; response?: string; error?: string }> {
  return apiFetch('/settings/test', { method: 'POST' })
}
