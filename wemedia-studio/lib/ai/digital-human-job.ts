import {
  apiBase,
  apiDelete,
  apiGet,
  apiPost,
  ApiRequestError,
  completeJob,
  completeStep,
  failStep,
  getJob,
  retryableForError,
  startStep,
  workerHeaders,
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
  video_asset_id?: number | null
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
  getRoleContext(roleId: number, jobId: number): Promise<RoleContext>
  updateRole(
    roleId: number,
    body: Record<string, unknown>,
    jobId: number,
  ): Promise<Record<string, unknown>>
  getRenderContext(renderId: number, jobId: number): Promise<RenderContext>
  updateRender(
    renderId: number,
    body: Record<string, unknown>,
    jobId: number,
  ): Promise<Record<string, unknown>>
  fetchLocalAsset(url: string, fallback: LocalAsset): Promise<DownloadedAsset>
  saveVideoAsset(
    jobId: number,
    render: RenderContext,
    asset: DownloadedAsset,
  ): Promise<{ id: number; url: string }>
  deleteAsset(assetId: number): Promise<unknown>
}


export type DigitalHumanJobDeps = {
  api: ProgressApi
  heygen: HeyGenClient
  sleep(ms: number): Promise<void>
}


class JobCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'JobCancelledError'
  }
}

export class JobFinalizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JobFinalizationError'
  }
}

export function retryableHttpStatus(status: number) {
  return [408, 409, 425, 429].includes(status) || status >= 500
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
    throw new ApiRequestError(
      `素材下载失败 (${response.status})`,
      retryableHttpStatus(response.status),
    )
  }
  const mediaType = response.headers.get('Content-Type')?.split(';')[0]
    || fallback.media_type
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength) {
    throw new ApiRequestError('素材文件为空', false)
  }
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
      headers: workerHeaders(jobId),
      body: form,
    },
  )
  if (!response.ok) {
    throw new ApiRequestError(
      `口播视频本地保存失败 (${response.status})`,
      retryableHttpStatus(response.status),
    )
  }
  return response.json() as Promise<{ id: number; url: string }>
}


const defaultApi: ProgressApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  getRoleContext: (roleId, jobId) => apiGet(
    `/digital-humans/${roleId}/worker-context`,
    workerHeaders(jobId),
  ),
  updateRole: (roleId, body, jobId) => apiPost(
    `/digital-humans/${roleId}/worker-progress`,
    body,
    workerHeaders(jobId),
  ),
  getRenderContext: (renderId, jobId) => apiGet(
    `/talking-videos/renders/${renderId}/worker-context`,
    workerHeaders(jobId),
  ),
  updateRender: (renderId, body, jobId) => apiPost(
    `/talking-videos/renders/${renderId}/worker-progress`,
    body,
    workerHeaders(jobId),
  ),
  fetchLocalAsset: fetchAsset,
  saveVideoAsset,
  deleteAsset: assetId => apiDelete(`/assets/${assetId}`),
}


async function defaultDeps(): Promise<DigitalHumanJobDeps> {
  const response = await fetch(`${apiBase()}/settings/heygen-runtime`, {
    cache: 'no-store',
    headers: workerHeaders(),
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
  if (job.status === 'cancelled') throw new JobCancelledError()
  const previous = latestStep(job, key)
  if (previous?.status === 'succeeded') return previous.output as T
  if (previous?.status === 'failed') {
    throw new Error(`${key} 步骤尚未进入重试队列`)
  }
  const step = previous?.status === 'running' && previous.id
    ? { id: previous.id }
    : await deps.api.startStep(jobId, key)
  try {
    const output = await work()
    await ensureNotCancelled(jobId, deps)
    try {
      await deps.api.completeStep(jobId, step.id, output)
    } catch (error) {
      let refreshed: DurableJob
      try {
        refreshed = await deps.api.getJob(jobId)
      } catch (readError) {
        throw new JobFinalizationError('步骤结果已保存，等待任务状态对账', {
          cause: readError,
        })
      }
      if (latestStep(refreshed, key)?.status === 'succeeded') return output
      throw error
    }
    return output
  } catch (error) {
    if (
      error instanceof JobCancelledError
      || error instanceof JobFinalizationError
    ) throw error
    const latest = await deps.api.getJob(jobId)
    if (latest.status === 'cancelled') throw new JobCancelledError()
    const retryable = error instanceof HeyGenError
      ? error.retryable
      : retryableForError(error)
    await deps.api.failStep(jobId, step.id, error, retryable)
    throw error
  }
}

async function ensureNotCancelled(
  jobId: number,
  deps: DigitalHumanJobDeps,
) {
  const job = await deps.api.getJob(jobId)
  if (job.status === 'cancelled') throw new JobCancelledError()
}

async function finalizeJob(jobId: number, deps: DigitalHumanJobDeps) {
  try {
    await deps.api.completeJob(jobId)
  } catch (error) {
    throw new JobFinalizationError('任务结果已保存，等待任务状态对账', {
      cause: error,
    })
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
    if (job.status === 'cancelled') throw new JobCancelledError()
    const result = await load()
    const providerStatus = statusOf(result).toLowerCase()
    if (['ready', 'complete', 'completed', 'succeeded'].includes(providerStatus)) {
      return result
    }
    if (['failed', 'error', 'cancelled'].includes(providerStatus)) {
      throw new HeyGenError({
        message: errorOf(result) || `HeyGen 处理失败 (${providerStatus})`,
        retryable: false,
        code: 'processing_failed',
        status: 422,
      })
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
  const context = await deps.api.getRoleContext(roleId, jobId)
  const state = { ...context.provider_state }
  let domainSucceeded = context.status === 'ready'
  try {
    const avatar = await runStep(
      jobId,
      'heygen_avatar',
      deps,
      async () => {
        let avatarId = stringState(state, 'avatar_id')
        let groupId = stringState(state, 'avatar_group_id')
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
              `digital-human:${roleId}:setup:${jobId}:portrait`,
            )
            portraitAssetId = uploaded.asset_id
            state.portrait_asset_id = portraitAssetId
            await deps.api.updateRole(roleId, {
              status: 'processing',
              provider_state: state,
            }, jobId)
          }
          const created = await deps.heygen.createPhotoAvatar({
            name: context.name,
            assetId: portraitAssetId,
            idempotencyKey: `digital-human:${roleId}:setup:${jobId}:avatar`,
          })
          avatarId = created.avatarId
          groupId = created.groupId
          state.avatar_id = avatarId
          state.avatar_group_id = groupId
          await deps.api.updateRole(roleId, {
            status: 'processing',
            provider_state: state,
          }, jobId)
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
              `digital-human:${roleId}:setup:${jobId}:voice-sample`,
            )
            voiceAssetId = uploaded.asset_id
            state.voice_asset_id = voiceAssetId
            await deps.api.updateRole(roleId, {
              status: 'processing',
              provider_state: state,
            }, jobId)
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
          }, jobId)
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
        let updated: Record<string, unknown>
        try {
          updated = await deps.api.updateRole(roleId, {
            status: 'ready',
            heygen_avatar_group_id: avatar.avatar_group_id,
            heygen_avatar_id: avatar.avatar_id,
            heygen_voice_id: voice.voice_id,
            provider_state: state,
            error: '',
          }, jobId)
        } catch (error) {
          let current: RoleContext
          try {
            current = await deps.api.getRoleContext(roleId, jobId)
          } catch (readError) {
            throw new JobFinalizationError(
              '数字人结果可能已保存，等待任务状态对账',
              { cause: readError },
            )
          }
          if (
            current.status !== 'ready'
            || current.heygen_avatar_id !== avatar.avatar_id
            || current.heygen_voice_id !== voice.voice_id
          ) throw error
          updated = current as unknown as Record<string, unknown>
        }
        if (updated?.status === 'failed') throw new JobCancelledError()
        domainSucceeded = true
        return { digital_human_id: roleId }
      },
    )
    await finalizeJob(jobId, deps)
  } catch (error) {
    if (!domainSucceeded && !(error instanceof JobFinalizationError)) {
      await deps.api.updateRole(roleId, {
        status: 'failed',
        provider_state: state,
        error: error instanceof Error ? error.message : String(error),
      }, jobId).catch(() => undefined)
    }
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
  const context = await deps.api.getRenderContext(renderId, jobId)
  const state = { ...context.provider_state }
  let domainSucceeded = context.status === 'succeeded'
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
          }, jobId)
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
          }, jobId)
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
        if (context.status === 'succeeded' && context.video_asset_id) {
          domainSucceeded = true
          return {
            video_asset_id: context.video_asset_id,
            url: '',
          }
        }
        await ensureNotCancelled(jobId, deps)
        const refreshed = await poll(
          jobId,
          deps,
          () => deps.heygen.getVideo(result.video_id),
          value => value.status,
          value => value.error,
        )
        if (!refreshed.videoUrl) throw new Error('HeyGen 成片缺少下载地址')
        await ensureNotCancelled(jobId, deps)
        const downloaded = await deps.api.fetchLocalAsset(
          refreshed.videoUrl,
          {
            url: refreshed.videoUrl,
            media_type: 'video/mp4',
            filename: `talking-video-${renderId}-v${context.version}.mp4`,
          },
        )
        if (downloaded.mediaType !== 'video/mp4') {
          throw new ApiRequestError(
            `HeyGen 成片格式异常 (${downloaded.mediaType})`,
            false,
          )
        }
        await ensureNotCancelled(jobId, deps)
        const asset = await deps.api.saveVideoAsset(
          jobId,
          context,
          downloaded,
        )
        try {
          await ensureNotCancelled(jobId, deps)
        } catch (error) {
          if (error instanceof JobCancelledError) {
            await deps.api.deleteAsset(asset.id).catch(() => undefined)
          }
          throw error
        }
        let updated: Record<string, unknown>
        try {
          updated = await deps.api.updateRender(renderId, {
            status: 'succeeded',
            heygen_environment_asset_id: result.environment_asset_id,
            heygen_video_id: result.video_id,
            video_asset_id: asset.id,
            provider_state: state,
            error: '',
          }, jobId)
        } catch (error) {
          let current: RenderContext
          try {
            current = await deps.api.getRenderContext(renderId, jobId)
          } catch (readError) {
            throw new JobFinalizationError(
              '成片结果可能已保存，等待任务状态对账',
              { cause: readError },
            )
          }
          if (
            current.status !== 'succeeded'
            || current.video_asset_id !== asset.id
          ) {
            if (current.status === 'cancelled') {
              await deps.api.deleteAsset(asset.id).catch(() => undefined)
              throw new JobCancelledError()
            }
            throw error
          }
          updated = current as unknown as Record<string, unknown>
        }
        if (updated?.status === 'cancelled') {
          await deps.api.deleteAsset(asset.id).catch(() => undefined)
          throw new JobCancelledError()
        }
        domainSucceeded = true
        return { video_asset_id: asset.id, url: asset.url }
      },
    )
    await finalizeJob(jobId, deps)
  } catch (error) {
    if (!domainSucceeded && !(error instanceof JobFinalizationError)) {
      await deps.api.updateRender(renderId, {
        status: error instanceof JobCancelledError ? 'cancelled' : 'failed',
        provider_state: state,
        error: error instanceof Error ? error.message : String(error),
      }, jobId).catch(() => undefined)
    }
    throw error
  }
}
