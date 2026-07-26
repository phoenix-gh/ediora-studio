import {
  apiBase,
  apiGet,
  apiPost,
  completeJob,
  completeStep,
  failStep,
  getJob,
  retryableForError,
  startStep,
  type DurableJob,
} from './job-client'
import {
  createHeyGenClient,
  HeyGenError,
  type HeyGenClient,
} from '../heygen/client'


type LocalAsset = {
  url: string
  media_type: string
  filename: string
}

type DownloadedAsset = {
  bytes: Uint8Array
  mediaType: string
  filename: string
}

type RoleContext = {
  id: number
  name: string
  status: string
  portrait: LocalAsset
  voice_sample: LocalAsset
  provider_state: Record<string, unknown>
  heygen_avatar_group_id: string
  heygen_avatar_id: string
  heygen_voice_id: string
}

type RenderContext = {
  id: number
  project_id: number
  version: number
  status: string
  script: string
  digital_human: {
    name: string
    heygen_avatar_id: string
    heygen_voice_id: string
  }
  environment: LocalAsset
  provider_state: Record<string, unknown>
  heygen_environment_asset_id: string
  heygen_video_id: string
}

type ProgressApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<{ id: number }>
  completeStep(
    jobId: number,
    stepId: number,
    output: Record<string, unknown>,
  ): Promise<unknown>
  failStep(
    jobId: number,
    stepId: number,
    error: unknown,
    retryable?: boolean,
  ): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  getRoleContext(roleId: number): Promise<RoleContext>
  updateRole(roleId: number, body: Record<string, unknown>): Promise<unknown>
  getRenderContext(renderId: number): Promise<RenderContext>
  updateRender(renderId: number, body: Record<string, unknown>): Promise<unknown>
  fetchLocalAsset(url: string, fallback: LocalAsset): Promise<DownloadedAsset>
  saveVideoAsset(
    jobId: number,
    render: RenderContext,
    asset: DownloadedAsset,
  ): Promise<{ id: number; url: string }>
}


export type DigitalHumanJobDeps = {
  api: ProgressApi
  heygen: HeyGenClient
  sleep(ms: number): Promise<void>
}


const sleep = (ms: number) => new Promise<void>(
  resolve => setTimeout(resolve, ms),
)


function absoluteUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url
  return new URL(url, `${apiBase()}/`).toString()
}


async function fetchAsset(
  url: string,
  fallback: LocalAsset,
): Promise<DownloadedAsset> {
  const response = await fetch(absoluteUrl(url), { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`素材下载失败 (${response.status})`)
  }
  const mediaType = response.headers.get('Content-Type')?.split(';')[0]
    || fallback.media_type
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength) throw new Error('素材文件为空')
  return { bytes, mediaType, filename: fallback.filename }
}


async function saveVideoAsset(
  jobId: number,
  render: RenderContext,
  asset: DownloadedAsset,
) {
  const upload = new Uint8Array(asset.bytes.byteLength)
  upload.set(asset.bytes)
  const filename = `talking-video-${render.id}-v${render.version}.mp4`
  const form = new FormData()
  form.append('file', new Blob([upload], { type: 'video/mp4' }), filename)
  const title = `${render.digital_human.name} · V${render.version}`
  const response = await fetch(
    `${apiBase()}/assets/upload?media_kind=video&title=${encodeURIComponent(title)}`,
    {
      method: 'POST',
      headers: { 'X-Content-Job-Id': String(jobId) },
      body: form,
    },
  )
  if (!response.ok) {
    throw new Error(`口播视频本地保存失败 (${response.status})`)
  }
  return response.json() as Promise<{ id: number; url: string }>
}


const defaultApi: ProgressApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  getRoleContext: roleId => apiGet(`/digital-humans/${roleId}/worker-context`),
  updateRole: (roleId, body) => apiPost(
    `/digital-humans/${roleId}/worker-progress`,
    body,
  ),
  getRenderContext: renderId => apiGet(
    `/talking-videos/renders/${renderId}/worker-context`,
  ),
  updateRender: (renderId, body) => apiPost(
    `/talking-videos/renders/${renderId}/worker-progress`,
    body,
  ),
  fetchLocalAsset: fetchAsset,
  saveVideoAsset,
}


async function defaultDeps(): Promise<DigitalHumanJobDeps> {
  const response = await fetch(`${apiBase()}/settings/heygen-runtime`, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`无法读取 HeyGen 设置 (${response.status})`)
  }
  const config = await response.json() as {
    api_key: string
    base_url: string
  }
  if (!config.api_key) throw new Error('请先在设置中填写 HeyGen API Key')
  return {
    api: defaultApi,
    heygen: createHeyGenClient({
      apiKey: config.api_key,
      baseUrl: config.base_url,
    }),
    sleep,
  }
}


function numberInput(value: unknown, name: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`任务缺少有效的 ${name}`)
  }
  return parsed
}


function stringState(state: Record<string, unknown>, key: string) {
  const value = state[key]
  return typeof value === 'string' ? value : ''
}


function latestStep(job: DurableJob, key: string) {
  return job.steps
    .filter(step => step.key === key)
    .sort((left, right) => right.attempt - left.attempt)[0]
}


async function runStep<T extends Record<string, unknown>>(
  jobId: number,
  key: string,
  deps: DigitalHumanJobDeps,
  work: () => Promise<T>,
) {
  const job = await deps.api.getJob(jobId)
  if (job.status === 'cancelled') throw new Error('任务已取消')
  const previous = latestStep(job, key)
  if (previous?.status === 'succeeded') return previous.output as T
  if (previous?.status === 'failed') {
    throw new Error(`${key} 步骤尚未进入重试队列`)
  }
  const step = await deps.api.startStep(jobId, key)
  try {
    const output = await work()
    await deps.api.completeStep(jobId, step.id, output)
    return output
  } catch (error) {
    const retryable = error instanceof HeyGenError
      ? error.retryable
      : retryableForError(error)
    await deps.api.failStep(jobId, step.id, error, retryable)
    throw error
  }
}


async function poll<T>(
  jobId: number,
  deps: DigitalHumanJobDeps,
  load: () => Promise<T>,
  statusOf: (result: T) => string,
  errorOf: (result: T) => string | undefined,
) {
  const deadline = Date.now() + 30 * 60 * 1000
  let interval = 2_000
  for (;;) {
    const job = await deps.api.getJob(jobId)
    if (job.status === 'cancelled') throw new Error('任务已取消')
    const result = await load()
    const providerStatus = statusOf(result).toLowerCase()
    if (['ready', 'complete', 'completed', 'succeeded'].includes(providerStatus)) {
      return result
    }
    if (['failed', 'error', 'cancelled'].includes(providerStatus)) {
      throw new Error(errorOf(result) || `HeyGen 处理失败 (${providerStatus})`)
    }
    if (Date.now() >= deadline) throw new Error('HeyGen 处理超时')
    await deps.sleep(interval)
    interval = Math.min(Math.round(interval * 1.5), 15_000)
  }
}


export async function runDigitalHumanSetupJob(
  jobId: number,
  providedDeps?: DigitalHumanJobDeps,
) {
  const deps = providedDeps ?? await defaultDeps()
  const job = await deps.api.getJob(jobId)
  const roleId = numberInput(job.input.digital_human_id, 'digital_human_id')
  const context = await deps.api.getRoleContext(roleId)
  const state = { ...context.provider_state }
  try {
    const avatar = await runStep(
      jobId,
      'heygen_avatar',
      deps,
      async () => {
        let avatarId = stringState(state, 'avatar_id')
          || context.heygen_avatar_id
        let groupId = stringState(state, 'avatar_group_id')
          || context.heygen_avatar_group_id
        if (!avatarId) {
          let portraitAssetId = stringState(state, 'portrait_asset_id')
          if (!portraitAssetId) {
            const portrait = await deps.api.fetchLocalAsset(
              context.portrait.url,
              context.portrait,
            )
            const uploaded = await deps.heygen.uploadAsset(
              portrait.bytes,
              portrait.mediaType,
              portrait.filename,
              `digital-human:${roleId}:portrait`,
            )
            portraitAssetId = uploaded.asset_id
            state.portrait_asset_id = portraitAssetId
            await deps.api.updateRole(roleId, {
              status: 'processing',
              provider_state: state,
            })
          }
          const created = await deps.heygen.createPhotoAvatar({
            name: context.name,
            assetId: portraitAssetId,
            idempotencyKey: `digital-human:${roleId}:avatar`,
          })
          avatarId = created.avatarId
          groupId = created.groupId
          state.avatar_id = avatarId
          state.avatar_group_id = groupId
          await deps.api.updateRole(roleId, {
            status: 'processing',
            provider_state: state,
          })
        }
        const completed = await poll(
          jobId,
          deps,
          () => deps.heygen.getAvatar(groupId, avatarId),
          value => value.status,
          value => value.error,
        )
        return {
          avatar_id: completed.avatarId,
          avatar_group_id: completed.groupId,
        }
      },
    )
    state.avatar_id = avatar.avatar_id
    state.avatar_group_id = avatar.avatar_group_id

    const voice = await runStep(
      jobId,
      'heygen_voice',
      deps,
      async () => {
        let voiceId = stringState(state, 'voice_id')
          || context.heygen_voice_id
        if (!voiceId) {
          let voiceAssetId = stringState(state, 'voice_asset_id')
          if (!voiceAssetId) {
            const sample = await deps.api.fetchLocalAsset(
              context.voice_sample.url,
              context.voice_sample,
            )
            const uploaded = await deps.heygen.uploadAsset(
              sample.bytes,
              sample.mediaType,
              sample.filename,
              `digital-human:${roleId}:voice-sample`,
            )
            voiceAssetId = uploaded.asset_id
            state.voice_asset_id = voiceAssetId
            await deps.api.updateRole(roleId, {
              status: 'processing',
              provider_state: state,
            })
          }
          const cloned = await deps.heygen.cloneVoice({
            name: context.name,
            assetId: voiceAssetId,
          })
          voiceId = cloned.voiceId
          state.voice_id = voiceId
          await deps.api.updateRole(roleId, {
            status: 'processing',
            provider_state: state,
          })
        }
        const completed = await poll(
          jobId,
          deps,
          () => deps.heygen.getVoice(voiceId),
          value => value.status,
          value => value.error,
        )
        return { voice_id: completed.voiceId }
      },
    )
    state.voice_id = voice.voice_id

    await runStep(
      jobId,
      'finalize_digital_human',
      deps,
      async () => {
        await deps.api.updateRole(roleId, {
          status: 'ready',
          heygen_avatar_group_id: avatar.avatar_group_id,
          heygen_avatar_id: avatar.avatar_id,
          heygen_voice_id: voice.voice_id,
          provider_state: state,
          error: '',
        })
        return { digital_human_id: roleId }
      },
    )
    await deps.api.completeJob(jobId)
  } catch (error) {
    await deps.api.updateRole(roleId, {
      status: 'failed',
      provider_state: state,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
    throw error
  }
}


export async function runDigitalHumanRenderJob(
  jobId: number,
  providedDeps?: DigitalHumanJobDeps,
) {
  const deps = providedDeps ?? await defaultDeps()
  const job = await deps.api.getJob(jobId)
  const renderId = numberInput(job.input.render_id, 'render_id')
  const context = await deps.api.getRenderContext(renderId)
  const state = { ...context.provider_state }
  try {
    const result = await runStep(
      jobId,
      'heygen_render',
      deps,
      async () => {
        let environmentAssetId = stringState(state, 'environment_asset_id')
          || context.heygen_environment_asset_id
        if (!environmentAssetId) {
          const environment = await deps.api.fetchLocalAsset(
            context.environment.url,
            context.environment,
          )
          const uploaded = await deps.heygen.uploadAsset(
            environment.bytes,
            environment.mediaType,
            environment.filename,
            `talking-render:${renderId}:environment`,
          )
          environmentAssetId = uploaded.asset_id
          state.environment_asset_id = environmentAssetId
          await deps.api.updateRender(renderId, {
            status: 'running',
            heygen_environment_asset_id: environmentAssetId,
            provider_state: state,
          })
        }
        let videoId = stringState(state, 'video_id')
          || context.heygen_video_id
        if (!videoId) {
          const created = await deps.heygen.createVideo({
            title: `${context.digital_human.name} V${context.version}`,
            avatarId: context.digital_human.heygen_avatar_id,
            voiceId: context.digital_human.heygen_voice_id,
            script: context.script,
            backgroundAssetId: environmentAssetId,
            idempotencyKey: `talking-render:${renderId}:video`,
          })
          videoId = created.videoId
          state.video_id = videoId
          await deps.api.updateRender(renderId, {
            status: 'running',
            heygen_environment_asset_id: environmentAssetId,
            heygen_video_id: videoId,
            provider_state: state,
          })
        }
        const completed = await poll(
          jobId,
          deps,
          () => deps.heygen.getVideo(videoId),
          value => value.status,
          value => value.error,
        )
        if (!completed.videoUrl) throw new Error('HeyGen 成片缺少下载地址')
        return {
          video_id: completed.videoId,
          video_url: completed.videoUrl,
          environment_asset_id: environmentAssetId,
        }
      },
    )
    state.video_id = result.video_id
    state.environment_asset_id = result.environment_asset_id

    await runStep(
      jobId,
      'save_talking_video',
      deps,
      async () => {
        const downloaded = await deps.api.fetchLocalAsset(
          result.video_url,
          {
            url: result.video_url,
            media_type: 'video/mp4',
            filename: `talking-video-${renderId}-v${context.version}.mp4`,
          },
        )
        if (downloaded.mediaType !== 'video/mp4') {
          throw new Error(`HeyGen 成片格式异常 (${downloaded.mediaType})`)
        }
        const asset = await deps.api.saveVideoAsset(
          jobId,
          context,
          downloaded,
        )
        await deps.api.updateRender(renderId, {
          status: 'succeeded',
          heygen_environment_asset_id: result.environment_asset_id,
          heygen_video_id: result.video_id,
          video_asset_id: asset.id,
          provider_state: state,
          error: '',
        })
        return { video_asset_id: asset.id, url: asset.url }
      },
    )
    await deps.api.completeJob(jobId)
  } catch (error) {
    await deps.api.updateRender(renderId, {
      status: 'failed',
      provider_state: state,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
    throw error
  }
}
