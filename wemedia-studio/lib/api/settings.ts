import { apiFetch } from './client'

export interface ProviderInfo {
  key: string
  label: string
  base_url: string
  default_model: string
}

export interface WebSearchProviderConfig {
  key: 'searxng'
  enabled: boolean
  base_url: string
  timeout_seconds: number
}

export interface WebFetchProviderConfig {
  key: 'direct' | 'jina_reader' | 'camofox'
  enabled: boolean
  base_url: string
  timeout_seconds: number
}

export type TextVideoTemplateDefaults = Record<
  string,
  Record<string, unknown>
>

export type TranscriptionProvider =
  | 'local-whisper'
  | 'openai-compatible'

export interface TranscriptionStatus {
  provider: TranscriptionProvider
  status: 'unavailable' | 'preparing' | 'ready' | 'busy' | 'error'
  model: string
  device: string
  compute_type: string
  error: string
}

export interface AppSettings {
  llm_provider: string
  llm_model: string
  llm_base_url: string
  llm_effective_base_url: string
  llm_api_key_set: boolean
  llm_api_key_preview: string
  image_model: string
  image_base_url: string
  image_api_key_set: boolean
  image_api_key_preview: string
  prompt_generation_history_limit: number
  heygen_api_key_set: boolean
  heygen_api_key_preview: string
  comfyui_base_url: string
  comfyui_auth_token_set: boolean
  comfyui_auth_token_preview: string
  comfyui_min_shot_seconds: number
  comfyui_max_shot_seconds: number
  transcription_provider: TranscriptionProvider
  transcription_model: string
  transcription_base_url: string
  transcription_api_key_set: boolean
  transcription_api_key_preview: string
  transcription_max_duration_seconds: number
  transcription_max_audio_bytes: number
  speech_provider: string
  speech_model: string
  speech_base_url: string
  speech_api_key_set: boolean
  speech_api_key_preview: string
  speech_default_voice: string
  youtube_cookies_set: boolean
  rsshub_base: string
  collection_proxy_url: string
  collection_proxy_url_set: boolean
  collection_proxy_url_preview: string
  github_token_set: boolean
  github_token_preview: string
  github_interval_minutes: number
  github_trending_interval_hours: number
  camofox_url: string
  camofox_api_key_set: boolean
  camofox_user_id: string
  camofox_novnc_url: string
  x_collect_enabled: boolean
  x_cookies_set: boolean
  x_collect_interval_minutes: number
  telegram_bot_token_set: boolean
  telegram_bot_token_preview: string
  telegram_chat_id: string
  telegram_test_status: '' | 'success' | 'failed'
  telegram_last_tested_at: string
  telegram_last_test_error: string
  x_follower_threshold: number
  x_post_window_hours: number
  x_post_lookback_hours: number
  x_timeline_scrolls: number
  twitterapi_io_key_set: boolean
  twitterapi_io_collect_enabled: boolean
  x_search_queries: string
  tl1_collect_enabled: boolean
  tl1_collect_interval_seconds: number
  tl1_trending_hours: number
  x_post_classify_enabled: boolean
  x_post_classify_prompt: string
  arxiv_categories: string
  arxiv_collect_interval_hours: number
  ref_collect_interval_minutes: number
  ref_classify_interval_minutes: number
  clean_batch_size: number
  wechat_tunnel_enabled: boolean
  wechat_tunnel_ssh_host: string
  wechat_tunnel_ssh_port: number
  wechat_tunnel_ssh_user: string
  wechat_tunnel_ssh_key_path: string
  wechat_tunnel_local_host: string
  wechat_tunnel_local_port: number
  wechat_tunnel_remote_host: string
  wechat_tunnel_remote_port: number
  wechat_tunnel_extra_args: string
  blog_api_base: string
  blog_api_token_set: boolean
  blog_api_token_preview: string
  web_search_providers: WebSearchProviderConfig[]
  web_fetch_providers: WebFetchProviderConfig[]
  text_video_template_defaults: TextVideoTemplateDefaults
  providers: ProviderInfo[]
}

export interface SettingsUpdate {
  llm_provider?: string
  llm_model?: string
  llm_api_key?: string
  llm_base_url?: string
  image_model?: string
  image_api_key?: string
  image_base_url?: string
  prompt_generation_history_limit?: number
  heygen_api_key?: string
  comfyui_base_url?: string
  comfyui_auth_token?: string
  comfyui_min_shot_seconds?: number
  comfyui_max_shot_seconds?: number
  transcription_provider?: TranscriptionProvider
  transcription_model?: string
  transcription_base_url?: string
  transcription_api_key?: string
  transcription_clear_api_key?: boolean
  transcription_max_duration_seconds?: number
  transcription_max_audio_bytes?: number
  speech_provider?: string
  speech_model?: string
  speech_base_url?: string
  speech_api_key?: string
  speech_clear_api_key?: boolean
  speech_default_voice?: string
  youtube_cookies?: string
  rsshub_base?: string
  collection_proxy_url?: string
  github_token?: string
  github_interval_minutes?: number
  github_trending_interval_hours?: number
  camofox_url?: string
  camofox_api_key?: string
  camofox_user_id?: string
  camofox_novnc_url?: string
  x_collect_enabled?: boolean
  x_cookies?: string
  x_collect_interval_minutes?: number
  telegram_bot_token?: string
  telegram_chat_id?: string
  x_follower_threshold?: number
  x_post_window_hours?: number
  x_post_lookback_hours?: number
  x_timeline_scrolls?: number
  twitterapi_io_key?: string
  twitterapi_io_collect_enabled?: boolean
  x_search_queries?: string
  tl1_collect_enabled?: boolean
  tl1_collect_interval_seconds?: number
  tl1_trending_hours?: number
  x_post_classify_enabled?: boolean
  x_post_classify_prompt?: string
  arxiv_categories?: string
  arxiv_collect_interval_hours?: number
  ref_collect_interval_minutes?: number
  ref_classify_interval_minutes?: number
  clean_batch_size?: number
  wechat_tunnel_enabled?: boolean
  wechat_tunnel_ssh_host?: string
  wechat_tunnel_ssh_port?: number
  wechat_tunnel_ssh_user?: string
  wechat_tunnel_ssh_key_path?: string
  wechat_tunnel_local_host?: string
  wechat_tunnel_local_port?: number
  wechat_tunnel_remote_host?: string
  wechat_tunnel_remote_port?: number
  wechat_tunnel_extra_args?: string
  blog_api_base?: string
  blog_api_token?: string
  web_search_providers?: WebSearchProviderConfig[]
  web_fetch_providers?: WebFetchProviderConfig[]
  text_video_template_defaults?: TextVideoTemplateDefaults
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

export async function testTelegramSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings/telegram/test', { method: 'POST' })
}

export async function clearTelegramSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings/telegram', { method: 'DELETE' })
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

export async function testHeyGen(): Promise<{ ok: boolean; error: string }> {
  return apiFetch('/settings/heygen/test', { method: 'POST' })
}

export async function testComfyUI(): Promise<{ ok: boolean; error: string }> {
  return apiFetch('/settings/comfyui/test', { method: 'POST' })
}

export async function testTranscription(): Promise<{ ok: boolean; error: string }> {
  return apiFetch('/settings/transcription/test', { method: 'POST' })
}

export async function getTranscriptionStatus(): Promise<TranscriptionStatus> {
  return apiFetch<TranscriptionStatus>('/settings/transcription/status')
}
