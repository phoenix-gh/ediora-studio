import { apiFetch } from './client'

export interface YoutubeChannel {
  id: string
  name: string
  avatar_url: string
  description: string
  description_cn: string
  note: string
  group: string
  muted: boolean
  auto_analyze_new_videos: boolean
  analysis_enabled_at: string | null
  last_collected_at: string | null
  created_at: string
}

export interface YoutubeVideo {
  id: string
  channel_id: string
  channel_name: string
  title: string
  url: string
  thumbnail_url: string
  description: string
  views: number
  published_at: string
  updated_at: string
  collected_at: string
  transcript_status: string
  transcript_source: string
  transcript_language: string
  transcript_error_code: string
  transcript_error: string
  response_item_id: number | null
  analysis_status: string | null
}

export async function getYoutubeChannels(): Promise<YoutubeChannel[]> {
  return apiFetch<YoutubeChannel[]>('/youtube/channels')
}

export async function addYoutubeChannel(channel_id: string, group = '未分组'): Promise<YoutubeChannel> {
  return apiFetch<YoutubeChannel>('/youtube/channels', {
    method: 'POST',
    body: JSON.stringify({ channel_id, group }),
  })
}

export async function updateYoutubeChannel(
  id: string,
  body: { group?: string; muted?: boolean; note?: string; auto_analyze_new_videos?: boolean },
): Promise<YoutubeChannel> {
  return apiFetch<YoutubeChannel>(`/youtube/channels/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteYoutubeChannel(id: string): Promise<void> {
  await apiFetch(`/youtube/channels/${id}`, { method: 'DELETE' })
}

export async function getYoutubeVideos(params?: {
  channel_id?: string
  days?: number
  limit?: number
  search?: string
}): Promise<YoutubeVideo[]> {
  const p = new URLSearchParams()
  if (params?.channel_id) p.set('channel_id', params.channel_id)
  if (params?.days) p.set('days', String(params.days))
  if (params?.limit) p.set('limit', String(params.limit))
  if (params?.search) p.set('search', params.search)
  return apiFetch<YoutubeVideo[]>(`/youtube/videos?${p}`)
}

export async function collectYoutube(): Promise<{ ok: boolean; message: string }> {
  return apiFetch('/youtube/collect', { method: 'POST' })
}

export async function collectYoutubeChannel(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/youtube/channels/${id}/collect`, { method: 'POST' })
}

export async function analyzeYoutubeVideo(id: string, force = false): Promise<{
  response_item_id: number
  analysis_run_id: number
  job_id: number
  created: boolean
}> {
  return apiFetch(`/youtube/videos/${id}/analyze?force=${force ? 'true' : 'false'}`, {
    method: 'POST',
  })
}
