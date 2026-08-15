import { openAsBlob } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { bundle as remotionBundle } from '@remotion/bundler'
import {
  renderMedia as remotionRenderMedia,
  selectComposition as remotionSelectComposition,
} from '@remotion/renderer'

import type { TextVideoProject } from '@/lib/api/text-videos'
import type { TextVideoRenderInput } from '@/remotion/contract'

import { JobFinalizationError } from './digital-human-job'
import {
  apiBase,
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
  type JobStep,
} from './job-client'


const RENDER_STEP = 'render_mp4'

type RenderJobInput = {
  project_id: number
  render_generation: number
  source_hash: string
  composition_id: string
  render_input: TextVideoRenderInput
}

type RenderContext = RenderJobInput & {
  already_saved: false
}

type SavedRenderContext = {
  already_saved: true
  project: TextVideoProject
  asset: {
    id: number
    url: string
  }
}

type RenderResult = {
  project: TextVideoProject
  asset: {
    id: number
    url: string
  }
}

type RenderProgressInput = {
  generation: number
  source_hash: string
  step_id: number
  progress: number
}

type RenderFailureInput = {
  generation: number
  source_hash: string
  error: string
}

type TextVideoRenderApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<{ id: number; attempt?: number }>
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
  getRenderContext(
    projectId: number,
    jobId: number,
  ): Promise<RenderContext | SavedRenderContext>
  updateRenderProgress(
    projectId: number,
    input: RenderProgressInput,
    jobId: number,
  ): Promise<{ progress: number }>
  uploadRenderResult(
    projectId: number,
    outputLocation: string,
    input: Pick<RenderProgressInput, 'generation' | 'source_hash'>,
    jobId: number,
  ): Promise<RenderResult>
  failRender(
    projectId: number,
    input: RenderFailureInput,
    jobId: number,
  ): Promise<TextVideoProject>
}

export type TextVideoRenderJobDeps = {
  api: TextVideoRenderApi
  bundle(options: { entryPoint: string }): Promise<string>
  selectComposition: typeof remotionSelectComposition
  renderMedia(
    options: Parameters<typeof remotionRenderMedia>[0],
  ): Promise<unknown>
  makeTemporaryDirectory(): Promise<string>
  apiUrl(): string
  browserExecutable(): string | undefined
}

let remotionBundlePromise: Promise<string> | undefined

function getRemotionBundle() {
  if (!remotionBundlePromise) {
    remotionBundlePromise = remotionBundle({
      entryPoint: resolve(process.cwd(), 'remotion/index.ts'),
    }).catch(error => {
      remotionBundlePromise = undefined
      throw error
    })
  }
  return remotionBundlePromise
}

function retryableHttpStatus(status: number) {
  return [408, 409, 425, 429].includes(status) || status >= 500
}

async function responseError(
  response: Response,
  fallback: string,
) {
  let detail: unknown = ''
  try {
    detail = (await response.json() as { detail?: unknown }).detail ?? ''
  } catch {
    // Keep the fallback for non-JSON failures.
  }
  const message = typeof detail === 'string'
    ? detail
    : detail
      && typeof detail === 'object'
      && 'message' in detail
      ? String(detail.message)
      : ''
  const retryableHeader = response.headers.get('X-WMS-Retryable')
  const retryable = retryableHeader === null
    ? retryableHttpStatus(response.status)
    : retryableHeader.toLowerCase() === 'true'
  return new ApiRequestError(
    message || `${fallback} (${response.status})`,
    retryable,
    true,
    response.status,
    detail,
  )
}

async function uploadRenderResult(
  projectId: number,
  outputLocation: string,
  input: Pick<RenderProgressInput, 'generation' | 'source_hash'>,
  jobId: number,
) {
  const form = new FormData()
  form.append('generation', String(input.generation))
  form.append('source_hash', input.source_hash)
  form.append(
    'video',
    await openAsBlob(outputLocation, { type: 'video/mp4' }),
    `text-video-${projectId}-g${input.generation}.mp4`,
  )
  let response: Response
  try {
    response = await fetch(
      `${apiBase()}/text-videos/${projectId}/render/worker-result`,
      {
        method: 'POST',
        headers: workerHeaders(jobId),
        body: form,
      },
    )
  } catch (error) {
    throw new ApiRequestError(
      error instanceof Error ? error.message : '文字视频上传连接失败',
      true,
      false,
    )
  }
  if (!response.ok) {
    throw await responseError(response, '文字视频保存失败')
  }
  return response.json() as Promise<RenderResult>
}

const defaultApi: TextVideoRenderApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  getRenderContext: (projectId, jobId) => apiGet(
    `/text-videos/${projectId}/render/worker-context`,
    workerHeaders(jobId),
  ),
  updateRenderProgress: (projectId, input, jobId) => apiPost(
    `/text-videos/${projectId}/render/worker-progress`,
    input,
    workerHeaders(jobId),
  ),
  uploadRenderResult,
  failRender: (projectId, input, jobId) => apiPost(
    `/text-videos/${projectId}/render/worker-failure`,
    input,
    workerHeaders(jobId),
  ),
}

const defaultDeps: TextVideoRenderJobDeps = {
  api: defaultApi,
  bundle: getRemotionBundle,
  selectComposition: remotionSelectComposition,
  renderMedia: remotionRenderMedia,
  makeTemporaryDirectory: () => mkdtemp(
    join(tmpdir(), 'wms-text-video-render-'),
  ),
  apiUrl: apiBase,
  browserExecutable: () => (
    process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || undefined
  ),
}

export function resolveTextVideoAssetUrl(
  url: string,
  apiUrl = apiBase(),
) {
  if (/^https?:\/\//i.test(url)) return url
  const origin = new URL(apiUrl).origin
  return new URL(url, `${origin}/`).toString()
}

function positiveInteger(value: unknown, name: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`文字视频渲染任务缺少有效的 ${name}`)
  }
  return parsed
}

function nonBlankString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`文字视频渲染任务缺少有效的 ${name}`)
  }
  return value
}

function parseJobInput(job: DurableJob): RenderJobInput {
  if (job.flow !== 'text_video_render') {
    throw new Error(`不支持的文字视频渲染任务：${job.flow}`)
  }
  const value = job.input
  if (!value.render_input || typeof value.render_input !== 'object') {
    throw new Error('文字视频渲染任务缺少冻结的 render_input')
  }
  return {
    project_id: positiveInteger(value.project_id, 'project_id'),
    render_generation: positiveInteger(
      value.render_generation,
      'render_generation',
    ),
    source_hash: nonBlankString(value.source_hash, 'source_hash'),
    composition_id: nonBlankString(
      value.composition_id,
      'composition_id',
    ),
    render_input: value.render_input as TextVideoRenderInput,
  }
}

function latestStep(job: DurableJob): JobStep | undefined {
  return job.steps
    .filter(step => step.key === RENDER_STEP)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

async function finishStep(
  jobId: number,
  stepId: number,
  output: Record<string, unknown>,
  deps: TextVideoRenderJobDeps,
) {
  try {
    await deps.api.completeStep(jobId, stepId, output)
  } catch (error) {
    let refreshed: DurableJob
    try {
      refreshed = await deps.api.getJob(jobId)
    } catch (readError) {
      throw new JobFinalizationError('渲染结果已保存，等待任务状态对账', {
        cause: readError,
      })
    }
    if (latestStep(refreshed)?.status === 'succeeded') return
    throw new JobFinalizationError('渲染结果已保存，等待任务状态对账', {
      cause: error,
    })
  }
}

async function finishJob(
  jobId: number,
  deps: TextVideoRenderJobDeps,
) {
  try {
    await deps.api.completeJob(jobId)
  } catch (error) {
    throw new JobFinalizationError('渲染结果已保存，等待任务状态对账', {
      cause: error,
    })
  }
}

function mightHaveSavedResult(error: unknown) {
  return !(error instanceof ApiRequestError)
    || !error.responseReceived
    || (error.status !== undefined && error.status >= 500)
}

async function recoverUploadedResult(
  error: unknown,
  projectId: number,
  jobId: number,
  deps: TextVideoRenderJobDeps,
) {
  try {
    const context = await deps.api.getRenderContext(projectId, jobId)
    if (context.already_saved) return context
  } catch (readError) {
    if (mightHaveSavedResult(error)) {
      throw new JobFinalizationError(
        '渲染文件可能已保存，等待服务端状态对账',
        { cause: readError },
      )
    }
  }
  if (mightHaveSavedResult(error)) {
    throw new JobFinalizationError(
      '渲染文件可能已保存，等待服务端状态对账',
      { cause: error },
    )
  }
  throw error
}

export async function runTextVideoRenderJob(
  jobId: number,
  dependencies: TextVideoRenderJobDeps = defaultDeps,
) {
  const initialJob = await dependencies.api.getJob(jobId)
  const input = parseJobInput(initialJob)
  const previous = latestStep(initialJob)
  if (previous?.status === 'failed') {
    throw new Error('render_mp4 步骤尚未进入重试队列')
  }
  const step = previous?.status === 'running' && previous.id
    ? { id: previous.id }
    : await dependencies.api.startStep(jobId, RENDER_STEP)

  let outputDirectory: string | undefined
  let result: RenderResult | SavedRenderContext
  try {
    const context = await dependencies.api.getRenderContext(
      input.project_id,
      jobId,
    )
    if (context.already_saved) {
      result = context
    } else {
      outputDirectory = await dependencies.makeTemporaryDirectory()
      const outputLocation = join(outputDirectory, 'output.mp4')
      const renderInput = {
        ...context.render_input,
        audio: resolveTextVideoAssetUrl(
          context.render_input.audio,
          dependencies.apiUrl(),
        ),
      }
      const serveUrl = await dependencies.bundle({
        entryPoint: resolve(process.cwd(), 'remotion/index.ts'),
      })
      const browserExecutable = dependencies.browserExecutable()
      const browserOptions = browserExecutable
        ? {
            browserExecutable,
            chromeMode: 'chrome-for-testing' as const,
          }
        : {}
      const composition = await dependencies.selectComposition({
        serveUrl,
        id: context.composition_id,
        inputProps: renderInput,
        ...browserOptions,
      })
      let lastProgress = 0
      let progressWrites = Promise.resolve()
      const writeProgress = (progress: number) => {
        const normalized = Math.max(
          lastProgress,
          Math.min(100, Math.floor(progress * 100)),
        )
        if (normalized <= lastProgress) return
        lastProgress = normalized
        progressWrites = progressWrites.then(async () => {
          await dependencies.api.updateRenderProgress(
            input.project_id,
            {
              generation: input.render_generation,
              source_hash: input.source_hash,
              step_id: step.id,
              progress: normalized,
            },
            jobId,
          )
        })
      }
      await dependencies.renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        audioCodec: 'aac',
        inputProps: renderInput,
        outputLocation,
        overwrite: true,
        onProgress: ({ progress }) => writeProgress(progress),
        ...browserOptions,
      })
      await progressWrites
      if (lastProgress < 100) {
        await dependencies.api.updateRenderProgress(
          input.project_id,
          {
            generation: input.render_generation,
            source_hash: input.source_hash,
            step_id: step.id,
            progress: 100,
          },
          jobId,
        )
      }
      try {
        result = await dependencies.api.uploadRenderResult(
          input.project_id,
          outputLocation,
          {
            generation: input.render_generation,
            source_hash: input.source_hash,
          },
          jobId,
        )
      } catch (error) {
        result = await recoverUploadedResult(
          error,
          input.project_id,
          jobId,
          dependencies,
        )
      }
    }

    await finishStep(jobId, step.id, {
      progress: 100,
      asset_id: result.asset.id,
      output_asset_url: result.asset.url,
    }, dependencies)
    await finishJob(jobId, dependencies)
    return result.project
  } catch (error) {
    if (error instanceof JobFinalizationError) throw error
    const message = error instanceof Error ? error.message : String(error)
    try {
      await dependencies.api.failRender(
        input.project_id,
        {
          generation: input.render_generation,
          source_hash: input.source_hash,
          error: message.slice(0, 500),
        },
        jobId,
      )
    } finally {
      await dependencies.api.failStep(
        jobId,
        step.id,
        error,
        retryableForError(error),
      )
    }
    throw error
  } finally {
    if (outputDirectory) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  }
}
