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
  workerHeaders,
  type DurableJob,
} from './job-client'
import { createComfyUIClient, ComfyUIError, type ComfyUIClient } from '../comfyui/client'
import { createXiangongyunClient, type XiangongyunClient } from '../xiangongyun/client'
import { buildShotPrompt, H3_REF2VA_META, h3Ref2vaPrompt } from '../comfyui/workflow'
import { safeTrimLeadingTrailingSilence } from '../media/clip-join'


export function resolveWorkerAssetUrl(url: string, base = apiBase()) {
  if (/^https?:\/\//i.test(url)) return url
  return new URL(url, `${base.replace(/\/$/, '')}/`).toString()
}


function resolvedShotSeed(
  shot: { seed?: number | null },
  state: Record<string, unknown>,
): number {
  for (const value of [shot.seed, state.seed]) {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  return Math.floor(Math.random() * 1_000_000_000)
}


type MediaRef = {
  url: string
  media_type: string
  filename: string
}

type ShotContext = {
  project_id: number
  shot: {
    id: string
    duration_sec: number
    framing: string
    spoken_text: string
    motion_prompt: string
    delivery?: string
    presence?: string
    render_prompt?: string
    provider_state: Record<string, unknown>
    seed?: number | null
    clip_asset_id?: number | null
    status: string
  }
  picture_1: MediaRef
  picture_2: MediaRef
  picture_3?: MediaRef | null
  audio_1: MediaRef
}

type ShotJobApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<{ id: number }>
  completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
  failStep(jobId: number, stepId: number, error: unknown, retryable?: boolean): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  getShotContext(projectId: number, shotId: string, jobId: number): Promise<ShotContext>
  updateShot(
    projectId: number,
    shotId: string,
    body: Record<string, unknown>,
    jobId: number,
  ): Promise<unknown>
  fetchLocalAsset(url: string, fallback: { url: string; media_type: string; filename: string }): Promise<{
    bytes: Uint8Array
    mediaType: string
    filename: string
  }>
  saveVideoAsset(jobId: number, filename: string, bytes: Uint8Array): Promise<{ id: number; url: string }>
  trimSilence?(bytes: Uint8Array): Promise<Uint8Array>
}

export type ShotJobDeps = {
  api: ShotJobApi
  comfyui: ComfyUIClient
  sleep(ms: number): Promise<void>
  xiangongyun?: XiangongyunClient
  xiangongyunInstanceId?: string
}


class JobCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'JobCancelledError'
  }
}


function latestStep(job: DurableJob, key: string) {
  return job.steps
    .filter(step => step.key === key)
    .sort((left, right) => right.attempt - left.attempt)[0]
}


async function runStep<T extends Record<string, unknown>>(
  jobId: number,
  key: string,
  deps: ShotJobDeps,
  work: () => Promise<T>,
) {
  const job = await deps.api.getJob(jobId)
  if (job.status === 'cancelled') throw new JobCancelledError()
  const previous = latestStep(job, key)
  if (previous?.status === 'succeeded') return previous.output as T
  const step = previous?.status === 'running' && previous.id
    ? { id: previous.id }
    : await deps.api.startStep(jobId, key)
  try {
    const output = await work()
    await deps.api.completeStep(jobId, step.id, output)
    return output
  } catch (error) {
    if (error instanceof JobCancelledError) throw error
    const retryable = error instanceof ComfyUIError
      ? error.retryable
      : /out of memory|oom|cuda/i.test(String(error))
        ? false
        : retryableForError(error)
    await deps.api.failStep(jobId, step.id, error, retryable)
    throw error
  }
}


function numberInput(value: unknown, name: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`任务缺少有效的 ${name}`)
  }
  return parsed
}


async function pollHistory(
  deps: ShotJobDeps,
  jobId: number,
  promptId: string,
) {
  const deadline = Date.now() + 30 * 60 * 1000
  let interval = 2_000
  for (;;) {
    const job = await deps.api.getJob(jobId)
    if (job.status === 'cancelled') throw new JobCancelledError()
    const history = await deps.comfyui.getHistory(promptId)
    if (history?.status?.completed || history?.status?.status_str === 'success') {
      return history
    }
    const status = history?.status?.status_str || ''
    if (/error|failed/i.test(status)) {
      throw new ComfyUIError({
        message: `ComfyUI 生成失败 (${status})`,
        retryable: /oom|memory/i.test(status),
        code: 'processing_failed',
        status: 422,
      })
    }
    if (Date.now() >= deadline) throw new Error('ComfyUI 处理超时')
    await deps.sleep(interval)
    interval = Math.min(Math.round(interval * 1.5), 15_000)
  }
}


function firstOutputFile(history: {
  outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }>; gifs?: Array<{ filename: string; subfolder: string; type: string }> }>
}) {
  for (const node of Object.values(history.outputs || {})) {
    const file = node.gifs?.[0] || node.images?.[0]
    if (file) return file
  }
  throw new Error('ComfyUI 成片缺少输出文件')
}


const defaultApi: ShotJobApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  getShotContext: (projectId, shotId, jobId) => apiGet(
    `/talking-videos/${projectId}/shots/${shotId}/worker-context`,
    workerHeaders(jobId),
  ),
  updateShot: (projectId, shotId, body, jobId) => apiPost(
    `/talking-videos/${projectId}/shots/${shotId}/worker-progress`,
    body,
    workerHeaders(jobId),
  ),
  async fetchLocalAsset(url, fallback) {
    const response = await fetch(resolveWorkerAssetUrl(url), {
      headers: workerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`无法读取素材 ${fallback.filename} (${response.status})`)
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mediaType: response.headers.get('content-type') || fallback.media_type,
      filename: fallback.filename,
    }
  },
  async saveVideoAsset(jobId, filename, bytes) {
    const body = new FormData()
    const upload = new Uint8Array(bytes.byteLength)
    upload.set(bytes)
    body.set('file', new Blob([upload], { type: 'video/mp4' }), filename)
    const response = await fetch(
      `${apiBase()}/assets/upload?media_kind=video&title=${encodeURIComponent(filename)}`,
      { method: 'POST', headers: workerHeaders(jobId), body },
    )
    if (!response.ok) throw new Error(`口播镜头本地保存失败 (${response.status})`)
    return response.json() as Promise<{ id: number; url: string }>
  },
  trimSilence: safeTrimLeadingTrailingSilence,
}


async function defaultDeps(): Promise<ShotJobDeps> {
  const headers = workerHeaders()
  const [comfyResponse, xiangongyunResponse] = await Promise.all([
    fetch(`${apiBase()}/settings/comfyui-runtime`, {
      cache: 'no-store',
      headers,
    }),
    fetch(`${apiBase()}/settings/xiangongyun-runtime`, {
      cache: 'no-store',
      headers,
    }),
  ])
  if (!comfyResponse.ok) throw new Error(`无法读取 ComfyUI 设置 (${comfyResponse.status})`)
  if (!xiangongyunResponse.ok) {
    throw new Error(`无法读取仙宫云运行环境设置 (${xiangongyunResponse.status})`)
  }
  const config = await comfyResponse.json() as {
    base_url: string
    auth_token: string
  }
  const xiangongyunConfig = await xiangongyunResponse.json() as {
    provider: 'direct' | 'xiangongyun'
    base_url: string
    api_token: string
    default_instance_id: string
  }
  if (!config.base_url) throw new Error('请先在设置中填写 ComfyUI 地址')
  const deps: ShotJobDeps = {
    api: defaultApi,
    comfyui: createComfyUIClient({
      baseUrl: config.base_url,
      authToken: config.auth_token,
    }),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  }
  if (xiangongyunConfig.provider === 'xiangongyun') {
    if (!xiangongyunConfig.api_token) {
      throw new Error('请先在设置中填写仙宫云 API Token')
    }
    if (!xiangongyunConfig.default_instance_id) {
      throw new Error('请先在设置中选择仙宫云默认实例')
    }
    deps.xiangongyun = createXiangongyunClient({
      baseUrl: xiangongyunConfig.base_url,
      apiToken: xiangongyunConfig.api_token,
    })
    deps.xiangongyunInstanceId = xiangongyunConfig.default_instance_id
  }
  return deps
}


export async function runDigitalHumanShotRenderJob(
  jobId: number,
  providedDeps?: ShotJobDeps,
) {
  const deps = providedDeps ?? await defaultDeps()
  const job = await deps.api.getJob(jobId)
  const projectId = numberInput(job.input.project_id, 'project_id')
  const shotId = String(job.input.shot_id || '')
  if (!shotId) throw new Error('任务缺少有效的 shot_id')
  const state: Record<string, unknown> = {}
  try {
    if (deps.xiangongyun && deps.xiangongyunInstanceId) {
      const checkCancelled = async () => {
        const currentJob = await deps.api.getJob(jobId)
        if (currentJob.status === 'cancelled') throw new JobCancelledError()
      }
      await deps.xiangongyun.ensureInstanceRunning(
        deps.xiangongyunInstanceId,
        {
          sleep: deps.sleep,
          checkCancelled,
        },
      )
      await deps.comfyui.waitUntilReady({ sleep: deps.sleep, checkCancelled })
    }
    const context = await deps.api.getShotContext(projectId, shotId, jobId)
    Object.assign(state, context.shot.provider_state)
    const prepared = await runStep(
      jobId,
      'prepare_shot',
      deps,
      async () => {
        const seed = resolvedShotSeed(context.shot, state)
        state.seed = seed
        await deps.api.updateShot(projectId, shotId, {
          status: 'running',
          seed,
          provider_state: state,
        }, jobId)
        return { seed }
      },
    )
    const generated = await runStep(
      jobId,
      'comfyui_ref2va',
      deps,
      async () => {
        let promptId = typeof state.prompt_id === 'string' ? state.prompt_id : ''
        if (!promptId) {
          const [look, environment, voice] = await Promise.all([
            deps.api.fetchLocalAsset(context.picture_1.url, context.picture_1),
            deps.api.fetchLocalAsset(context.picture_2.url, context.picture_2),
            deps.api.fetchLocalAsset(context.audio_1.url, context.audio_1),
          ])
          const pose = context.picture_3
            ? await deps.api.fetchLocalAsset(context.picture_3.url, context.picture_3)
            : look
          const [image1, image2, image3, audio1] = await Promise.all([
            deps.comfyui.uploadImage(look.bytes, `look-${projectId}-${look.filename}`),
            deps.comfyui.uploadImage(environment.bytes, `env-${projectId}-${environment.filename}`),
            deps.comfyui.uploadImage(pose.bytes, `pose-${projectId}-${pose.filename}`),
            deps.comfyui.uploadAudio(voice.bytes, `voice-${projectId}-${voice.filename}`),
          ])
          const storedPrompt = context.shot.render_prompt?.trim() || ''
          const submittedPrompt = storedPrompt && !/last frame of the previous clip|Picture 3 is fully referenced as the first frame/i.test(storedPrompt)
            ? storedPrompt
            : buildShotPrompt({
              framing: context.shot.framing,
              spokenText: context.shot.spoken_text,
              motionPrompt: context.shot.motion_prompt,
              delivery: context.shot.delivery,
              presence: context.shot.presence,
            })
          promptId = await deps.comfyui.queuePrompt(h3Ref2vaPrompt({
            image_1: image1.name,
            image_2: image2.name,
            image_3: image3.name,
            audio_1: audio1.name,
            prompt: submittedPrompt,
            duration: context.shot.duration_sec,
            seed: prepared.seed,
          }))
          state.prompt_id = promptId
          state.submitted_prompt = submittedPrompt
          await deps.api.updateShot(projectId, shotId, {
            status: 'running',
            render_prompt: submittedPrompt,
            provider_state: state,
          }, jobId)
        }
        const history = await pollHistory(deps, jobId, promptId)
        const file = firstOutputFile(history)
        return {
          prompt_id: promptId,
          filename: file.filename,
          subfolder: file.subfolder,
          type: file.type,
        }
      },
    )
    await runStep(
      jobId,
      'save_shot_clip',
      deps,
      async () => {
        if (context.shot.status === 'succeeded' && context.shot.clip_asset_id) {
          return { clip_asset_id: context.shot.clip_asset_id }
        }
        const rawBytes = await deps.comfyui.viewFile(generated)
        const bytes = deps.api.trimSilence
          ? await deps.api.trimSilence(rawBytes)
          : rawBytes
        const asset = await deps.api.saveVideoAsset(
          jobId,
          `talking-shot-${shotId}.mp4`,
          bytes,
        )
        await deps.api.updateShot(projectId, shotId, {
          status: 'succeeded',
          clip_asset_id: asset.id,
          workflow_version: H3_REF2VA_META.workflow_version,
          seed: prepared.seed,
          provider_state: state,
          error: '',
        }, jobId)
        return { clip_asset_id: asset.id }
      },
    )
    await deps.api.completeJob(jobId)
  } catch (error) {
    if (!(error instanceof JobCancelledError)) {
      await deps.api.updateShot(projectId, shotId, {
        status: 'failed',
        provider_state: state,
        error: error instanceof Error ? error.message : String(error),
      }, jobId).catch(() => undefined)
    }
    throw error
  }
}
