import { apiFetch } from './client'
import type { CreativeAsset } from './assets'


export type DigitalHumanStatus =
  | 'processing'
  | 'ready'
  | 'failed'
  | 'archived'

export type RenderStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type DigitalHumanProvider = 'heygen' | 'comfyui'

export interface DigitalHuman {
  id: number
  name: string
  status: DigitalHumanStatus
  provider: DigitalHumanProvider
  portrait_asset_id: number
  voice_sample_asset_id: number | null
  default_environment_asset_id: number
  look_asset_id: number | null
  portrait: CreativeAsset | null
  voice_sample: CreativeAsset | null
  default_environment: CreativeAsset | null
  look: CreativeAsset | null
  heygen_avatar_group_id: string
  heygen_avatar_id: string
  heygen_voice_id: string
  provider_state: Record<string, unknown>
  setup_job_id: number | null
  error: string
  archived_at: string | null
  created_at: string
  updated_at: string
  project_count?: number
}

export type TalkingVideoShot = {
  id: string
  duration_sec: number
  framing: 'wide' | 'medium' | 'close'
  spoken_text: string
  motion_prompt: string
  first_frame_asset_id: number | null
  clip_asset_id: number | null
  status: 'draft' | 'queued' | 'running' | 'succeeded' | 'failed'
  job_id: number | null
  error: string
  workflow_version: string
  seed: number | null
  provider_state: Record<string, unknown>
}

export interface TalkingVideoRender {
  id: number
  project_id: number
  version: number
  status: RenderStatus
  job_id: number | null
  script_snapshot: string
  digital_human_snapshot: {
    id: number
    name: string
    provider?: DigitalHumanProvider
    look_asset_id?: number | null
    heygen_avatar_group_id?: string
    heygen_avatar_id?: string
    heygen_voice_id?: string
  }
  shots_snapshot?: TalkingVideoShot[]
  environment_asset_id: number
  provider_state: Record<string, unknown>
  heygen_environment_asset_id: string
  heygen_video_id: string
  video_asset_id: number | null
  video_asset: CreativeAsset | null
  error: string
  created_at: string
  completed_at: string | null
}

export interface TalkingVideoProject {
  id: number
  title: string
  digital_human_id: number
  script: string
  script_source: 'manual' | 'ai' | 'draft'
  source_draft_id: number | null
  environment_asset_id: number | null
  look_asset_id: number | null
  shots: TalkingVideoShot[]
  effective_environment_asset_id: number
  current_render_id: number | null
  role: Pick<
    DigitalHuman,
    | 'id'
    | 'name'
    | 'status'
    | 'provider'
    | 'portrait_asset_id'
    | 'default_environment_asset_id'
    | 'look_asset_id'
  >
  effective_environment: CreativeAsset | null
  renders: TalkingVideoRender[]
  created_at: string
  updated_at: string
}

export type DigitalHumanCreate = {
  name: string
  provider?: DigitalHumanProvider
  portrait_asset_id: number
  voice_sample_asset_id: number
  default_environment_asset_id: number
}

export type TalkingVideoCreate = {
  title?: string
  digital_human_id: number
  script?: string
  script_source?: 'manual' | 'ai' | 'draft'
  source_draft_id?: number | null
  environment_asset_id?: number | null
}

export type TalkingVideoUpdate = Partial<
  Pick<
    TalkingVideoProject,
    | 'title'
    | 'digital_human_id'
    | 'script'
    | 'script_source'
    | 'source_draft_id'
    | 'environment_asset_id'
  >
>

export type TalkingScriptRequest =
  | { mode: 'generate'; topic: string; instructions?: string }
  | { mode: 'convert_draft'; draftId: number; instructions?: string }
  | { mode: 'rewrite'; script: string; instructions: string }


export const listDigitalHumans = (includeArchived = false) =>
  apiFetch<DigitalHuman[]>(
    `/digital-humans${includeArchived ? '?include_archived=true' : ''}`,
  )

export const getDigitalHuman = (id: number) =>
  apiFetch<DigitalHuman>(`/digital-humans/${id}`)

export const createDigitalHuman = (body: DigitalHumanCreate) =>
  apiFetch<DigitalHuman>('/digital-humans', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const updateDigitalHuman = (
  id: number,
  body: Partial<DigitalHumanCreate>,
) => apiFetch<DigitalHuman>(`/digital-humans/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(body),
})

export const archiveDigitalHuman = (id: number) =>
  apiFetch<DigitalHuman>(`/digital-humans/${id}/archive`, { method: 'POST' })

export const retryDigitalHuman = (id: number) =>
  apiFetch<DigitalHuman>(`/digital-humans/${id}/retry`, { method: 'POST' })

export const deleteDigitalHuman = (id: number) =>
  apiFetch<void>(`/digital-humans/${id}`, { method: 'DELETE' })

export const listTalkingVideos = () =>
  apiFetch<TalkingVideoProject[]>('/talking-videos')

export const getTalkingVideo = (id: number) =>
  apiFetch<TalkingVideoProject>(`/talking-videos/${id}`)

export const createTalkingVideo = (body: TalkingVideoCreate) =>
  apiFetch<TalkingVideoProject>('/talking-videos', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const updateTalkingVideo = (
  id: number,
  body: TalkingVideoUpdate,
) => apiFetch<TalkingVideoProject>(`/talking-videos/${id}`, {
  method: 'PATCH',
  body: JSON.stringify(body),
})

export const deleteTalkingVideo = (id: number) =>
  apiFetch<void>(`/talking-videos/${id}`, { method: 'DELETE' })

export const createTalkingVideoRender = (projectId: number) =>
  apiFetch<TalkingVideoRender>(
    `/talking-videos/${projectId}/renders`,
    { method: 'POST' },
  )

export const saveTalkingVideoShots = (
  projectId: number,
  shots: TalkingVideoShot[],
) => apiFetch<TalkingVideoProject>(`/talking-videos/${projectId}/shots`, {
  method: 'PUT',
  body: JSON.stringify({ shots }),
})

export const renderTalkingVideoShot = (
  projectId: number,
  shotId: string,
) => apiFetch<TalkingVideoProject>(
  `/talking-videos/${projectId}/shots/${shotId}/render`,
  { method: 'POST' },
)

export const renderPendingTalkingVideoShots = (projectId: number) =>
  apiFetch<TalkingVideoProject>(
    `/talking-videos/${projectId}/shots/render-pending`,
    { method: 'POST' },
  )

export const stitchTalkingVideo = (projectId: number) =>
  apiFetch<TalkingVideoRender>(
    `/talking-videos/${projectId}/stitch`,
    { method: 'POST' },
  )

export const selectTalkingVideoRender = (
  projectId: number,
  renderId: number,
) => apiFetch<TalkingVideoProject>(
  `/talking-videos/${projectId}/renders/${renderId}/select`,
  { method: 'POST' },
)

export const deleteTalkingVideoRender = (
  projectId: number,
  renderId: number,
) => apiFetch<void>(
  `/talking-videos/${projectId}/renders/${renderId}`,
  { method: 'DELETE' },
)

export async function generateTalkingScript(body: TalkingScriptRequest) {
  const response = await fetch('/api/digital-human/script', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as {
      error?: string
    }
    throw new Error(payload.error || `脚本生成失败 (${response.status})`)
  }
  return response.json() as Promise<{ script: string }>
}
