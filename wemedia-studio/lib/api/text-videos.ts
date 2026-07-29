import type { TextVideoRenderInput } from '@/remotion/contract'

import { API_BASE } from './client'

export type TextVideoProjectStatus = 'draft' | 'audio_ready' | 'video_ready' | 'completed' | 'archived'
export type TextVideoStage = 'script' | 'audio' | 'video'

export type TextVideoParagraph = {
  id: string
  text: string
  duration: number
  status: 'draft' | 'ready' | 'confirmed'
  audio_url: string
  word_timings: Array<Record<string, unknown>>
}

export type TextVideoProjectSummary = {
  id: number
  title: string
  status: TextVideoProjectStatus
  stage: TextVideoStage
  cover_asset_url: string
  output_asset_url: string
  revision: number
  duration: number
  aspect_ratio: string
  created_at: string
  updated_at: string
}

export type TextVideoProject = TextVideoProjectSummary & {
  script: string
  voice_settings: Record<string, unknown>
  paragraphs: TextVideoParagraph[]
  render_input: TextVideoRenderInput
}

export type TextVideoProjectUpdate = Partial<Pick<
  TextVideoProject,
  | 'title'
  | 'status'
  | 'stage'
  | 'script'
  | 'voice_settings'
  | 'paragraphs'
  | 'render_input'
  | 'cover_asset_url'
  | 'output_asset_url'
>> & { revision: number }

export class TextVideoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message)
  }
}

async function textVideoRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: init?.cache ?? 'no-store',
  })
  if (!response.ok) {
    let detail: unknown = ''
    try {
      detail = (await response.json()).detail
    } catch {
      detail = ''
    }
    const message = typeof detail === 'string'
      ? detail
      : typeof detail === 'object' && detail && 'message' in detail
        ? String(detail.message)
        : `文字视频 API 请求失败（${response.status}）`
    throw new TextVideoApiError(message, response.status, detail)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function listTextVideoProjects(status?: TextVideoProjectStatus) {
  const query = status ? `?project_status=${status}` : ''
  return textVideoRequest<TextVideoProjectSummary[]>(`/text-videos${query}`)
}

export function createTextVideoProject(title = '未命名文字视频') {
  return textVideoRequest<TextVideoProject>('/text-videos', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export function getTextVideoProject(projectId: number) {
  return textVideoRequest<TextVideoProject>(`/text-videos/${projectId}`)
}

export function updateTextVideoProject(projectId: number, update: TextVideoProjectUpdate) {
  return textVideoRequest<TextVideoProject>(`/text-videos/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
  })
}

export function deleteTextVideoProject(projectId: number) {
  return textVideoRequest<void>(`/text-videos/${projectId}`, {
    method: 'DELETE',
  })
}
