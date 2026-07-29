import type { TextVideoRenderInput } from '@/remotion/contract'

import { API_BASE } from './client'

export type TextVideoProjectStatus = 'draft' | 'audio_ready' | 'video_ready' | 'completed' | 'archived'
export type TextVideoStage = 'script' | 'audio' | 'video'
export type SpeechSplitMode = 'single' | 'auto' | 'manual'
export type SpeechStatus = 'draft' | 'generating' | 'ready' | 'confirmed' | 'failed'

export type TextVideoVoiceSettings = {
  voice_id: string
  model: string
  speed: number
  volume: number
  pitch: number
}

export type WordTiming = {
  id: string
  text: string
  start: number
  end: number
}

export type GlobalWordTiming = WordTiming & {
  speech_segment_id: string
}

export type MasterAudioSegmentOffset = {
  segment_id: string
  asset_id?: number
  sample_offset: number
  sample_count: number
}

export type TextVideoParagraph = {
  id: string
  text: string
  duration: number
  status: SpeechStatus
  audio_url: string
  word_timings: WordTiming[]
  source_hash: string
  generation_revision: number
  error: string
  job_id: number | null
}

export type MasterAudioDocument = {
  status: 'missing' | 'building' | 'ready' | 'stale' | 'failed'
  timeline_status: 'missing' | 'aligning' | 'ready' | 'stale' | 'failed'
  asset_id?: number | null
  audio_url: string
  duration: number
  sample_rate?: number
  sample_count?: number
  segment_offsets?: MasterAudioSegmentOffset[]
  source_hash: string
  word_timings: GlobalWordTiming[]
  timeline_source: '' | 'provider' | 'forced-alignment'
  error: string
  timeline_error: string
  job_id: number | null
  repair_generation?: number
}

export type ScenePlanSceneDocument = {
  id: string
  fromWordId: string
  throughWordId: string
  displayText: string
  highlight: string[]
  animation: string
}

export type ScenePlanDocument = {
  status: 'missing' | 'generating' | 'ready' | 'stale' | 'failed'
  generation_revision: number
  master_source_hash: string
  scenes: ScenePlanSceneDocument[]
  job_id: number | null
  error: string
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
  voice_settings: TextVideoVoiceSettings
  paragraphs: TextVideoParagraph[]
  speech_split_mode: SpeechSplitMode
  master_audio: MasterAudioDocument
  scene_plan: ScenePlanDocument
  render_input: TextVideoRenderInput
}

export type TextVideoProjectUpdate = {
  revision: number
  title?: string
  status?: TextVideoProjectStatus
  stage?: TextVideoStage
  script?: string
  voice_settings?: TextVideoVoiceSettings
  paragraphs?: Array<Pick<TextVideoParagraph, 'id' | 'text'>>
  composition?: TextVideoRenderInput['composition']
  template?: {
    templateId: string
    templateVersion: number
    templateProps: Record<string, unknown>
  }
  scene_plan?: { scenes: ScenePlanSceneDocument[] }
  /**
   * Compatibility bridge for the current editor. The API accepts only its
   * visual fields and ignores browser-supplied audio.
   */
  render_input?: TextVideoRenderInput
  cover_asset_url?: string
  output_asset_url?: string
}

export type SpeechSplitProposal = {
  segments: Array<{
    id: string
    text: string
    estimated_duration: number
    reason: string
  }>
  speech_split_mode: 'auto'
}

export type SpeechSplitPreviewJob = {
  id: number
  flow: 'text_video_split_preview'
  target_id: number
}

export type SpeechSplitPreviewResponse = {
  jobs: SpeechSplitPreviewJob[]
  project: TextVideoProject
}

export type TextVideoSpeechJob = {
  id: number
  flow: 'text_video_speech'
  target_id: string
}

export type TextVideoSpeechResponse = {
  jobs: TextVideoSpeechJob[]
  project: TextVideoProject
}

export type TextVideoMasterJob = {
  id: number
  flow: 'text_video_master_audio'
  target_id: number
}

export type TextVideoMasterResponse = {
  jobs: TextVideoMasterJob[]
  project: TextVideoProject
}

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

export function createSpeechSplitPreview(
  projectId: number,
  input: { revision: number; direction: string },
) {
  return textVideoRequest<SpeechSplitPreviewResponse>(
    `/text-videos/${projectId}/speech-split-preview`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function generateTextVideoSpeechSegment(
  projectId: number,
  segmentId: string,
  revision: number,
) {
  return textVideoRequest<TextVideoSpeechResponse>(
    `/text-videos/${projectId}/speech-segments/`
      + `${encodeURIComponent(segmentId)}/generate`,
    { method: 'POST', body: JSON.stringify({ revision }) },
  )
}

export function generatePendingTextVideoSpeech(
  projectId: number,
  revision: number,
) {
  return textVideoRequest<TextVideoSpeechResponse>(
    `/text-videos/${projectId}/speech-segments/generate-pending`,
    { method: 'POST', body: JSON.stringify({ revision }) },
  )
}

export function confirmTextVideoSpeechSegment(
  projectId: number,
  segmentId: string,
  input: {
    revision: number
    generation_revision: number
    source_hash: string
  },
) {
  return textVideoRequest<TextVideoProject>(
    `/text-videos/${projectId}/speech-segments/`
      + `${encodeURIComponent(segmentId)}/confirm`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function buildTextVideoMasterAudio(
  projectId: number,
  revision: number,
) {
  return textVideoRequest<TextVideoMasterResponse>(
    `/text-videos/${projectId}/master-audio/build`,
    { method: 'POST', body: JSON.stringify({ revision }) },
  )
}
