import {
  createMiMoSpeechProvider,
  type SpeechProvider,
  type SpeechProviderResult,
} from '@/lib/mimo/speech-client'

import { JobFinalizationError } from './digital-human-job'
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
  type JobStep,
} from './job-client'


type SavedSpeechResult = {
  asset_id: number
  audio_url: string
  duration: number
  sample_count?: number
  sample_rate?: number
}

type SpeechContext = {
  project_id: number
  segment_id: string
  text: string
  generation_revision: number
  source_hash: string
  speech_model: string
  voice_settings: {
    voice_id: string
    speed: number
    volume: number
    pitch: number
  }
  runtime: { default_voice: string }
}

type SavedSpeechContext = {
  already_saved: SavedSpeechResult
}

type SpeechProgressApi = {
  getJob(jobId: number): Promise<DurableJob>
  getSpeechContext(
    projectId: number,
    segmentId: string,
    jobId: number,
  ): Promise<SpeechContext | SavedSpeechContext>
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
  saveSpeechResult(
    context: SpeechContext,
    result: SpeechProviderResult,
    jobId: number,
  ): Promise<SavedSpeechResult>
  postSpeechFailure(
    context: SpeechContext,
    error: unknown,
    jobId: number,
  ): Promise<unknown>
}

export type TextVideoSpeechJobDeps = {
  api: SpeechProgressApi
  speech: SpeechProvider
}

function latestStep(steps: JobStep[], key: string) {
  return steps
    .filter(step => step.key === key)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

function resultFromOutput(output: Record<string, unknown>): SavedSpeechResult {
  const assetId = Number(output.asset_id)
  const audioUrl = output.audio_url
  const duration = Number(output.duration)
  if (
    !Number.isSafeInteger(assetId)
    || assetId <= 0
    || typeof audioUrl !== 'string'
    || !audioUrl
    || !Number.isFinite(duration)
    || duration < 0
  ) throw new Error('已完成的配音结果无效')
  return {
    asset_id: assetId,
    audio_url: audioUrl,
    duration,
    ...(Number.isSafeInteger(Number(output.sample_count))
      ? { sample_count: Number(output.sample_count) }
      : {}),
    ...(Number.isSafeInteger(Number(output.sample_rate))
      ? { sample_rate: Number(output.sample_rate) }
      : {}),
  }
}

function jobTarget(job: DurableJob) {
  const projectId = Number(job.input.project_id)
  const segmentId = String(job.input.segment_id ?? '')
  if (
    job.flow !== 'text_video_speech'
    || !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !segmentId
  ) throw new Error('文字视频配音任务缺少有效快照')
  return { projectId, segmentId }
}

async function multipartRequest<T>(
  path: string,
  form: FormData,
  jobId: number,
): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: workerHeaders(jobId),
    body: form,
  })
  if (!response.ok) {
    let detail = ''
    try {
      const payload = await response.json() as { detail?: unknown }
      detail = typeof payload.detail === 'string'
        ? payload.detail
        : JSON.stringify(payload.detail ?? '')
    } catch {
      // A bounded status-based message is enough for non-JSON failures.
    }
    const error = new Error(
      detail || `配音结果保存失败（HTTP ${response.status}）`,
    ) as Error & { retryable?: boolean; stale?: boolean }
    error.retryable = response.headers.get('X-WMS-Retryable') !== 'false'
    error.stale = response.status === 409 && error.retryable === false
    throw error
  }
  return response.json() as Promise<T>
}

async function saveSpeechResult(
  context: SpeechContext,
  result: SpeechProviderResult,
  jobId: number,
) {
  const form = new FormData()
  form.append(
    'audio',
    new Blob([Uint8Array.from(result.bytes).buffer], {
      type: result.mediaType,
    }),
    'provider-audio',
  )
  form.append('generation_revision', String(context.generation_revision))
  form.append('source_hash', context.source_hash)
  form.append('provider_request_id', result.providerRequestId ?? '')
  form.append('media_type', result.mediaType)
  if (result.wordTimings) {
    form.append('word_timings', JSON.stringify(result.wordTimings))
  }
  return multipartRequest<SavedSpeechResult>(
    `/text-videos/${context.project_id}/speech-segments/`
      + `${encodeURIComponent(context.segment_id)}/worker-result`,
    form,
    jobId,
  )
}

async function defaultDeps(jobId: number): Promise<TextVideoSpeechJobDeps> {
  let jobPromise: Promise<DurableJob> | undefined
  const loadJob = () => {
    jobPromise ??= getJob(jobId)
    return jobPromise
  }
  return {
    api: {
      getJob: currentJobId => {
        const request = getJob(currentJobId)
        if (currentJobId === jobId) jobPromise ??= request
        return request
      },
      getSpeechContext: (projectId, segmentId, currentJobId) => apiGet(
        `/text-videos/${projectId}/speech-segments/`
          + `${encodeURIComponent(segmentId)}/worker-context`,
        workerHeaders(currentJobId),
      ),
      startStep,
      completeStep,
      failStep,
      completeJob,
      saveSpeechResult,
      postSpeechFailure: (context, error, currentJobId) => apiPost(
        `/text-videos/${context.project_id}/speech-segments/`
          + `${encodeURIComponent(context.segment_id)}/worker-failure`,
        {
          generation_revision: context.generation_revision,
          source_hash: context.source_hash,
          error: error instanceof Error ? error.message : String(error),
        },
        workerHeaders(currentJobId),
      ),
    },
    speech: {
      async generate(request) {
        const [runtime, frozenJob] = await Promise.all([
          apiGet<{
            provider: string
            model: string
            base_url: string
            api_key: string
            default_voice: string
          }>('/settings/speech-runtime', workerHeaders(jobId)),
          loadJob(),
        ])
        if (runtime.provider !== 'mimo') {
          throw new Error(`不支持的语音供应商：${runtime.provider}`)
        }
        return createMiMoSpeechProvider({
          apiKey: runtime.api_key,
          baseUrl: runtime.base_url,
          model: typeof frozenJob.input.speech_model === 'string'
            && frozenJob.input.speech_model
            ? frozenJob.input.speech_model
            : runtime.model,
          defaultVoice: runtime.default_voice,
        }).generate(request)
      },
    },
  }
}

async function finalizeJob(
  jobId: number,
  deps: TextVideoSpeechJobDeps,
) {
  try {
    await deps.api.completeJob(jobId)
  } catch (error) {
    throw new JobFinalizationError(
      '配音结果已保存，等待任务状态对账',
      { cause: error },
    )
  }
}

async function completePersistedResult(
  jobId: number,
  stepId: number,
  saved: SavedSpeechResult,
  deps: TextVideoSpeechJobDeps,
): Promise<SavedSpeechResult> {
  try {
    await deps.api.completeStep(jobId, stepId, { ...saved })
  } catch (error) {
    try {
      const refreshed = await deps.api.getJob(jobId)
      const completed = latestStep(refreshed.steps, 'generate_speech')
      if (completed?.status !== 'succeeded') throw error
    } catch (reconcileError) {
      throw new JobFinalizationError(
        '配音素材已保存，等待步骤状态对账',
        { cause: reconcileError },
      )
    }
  }
  await finalizeJob(jobId, deps)
  return saved
}

async function recoverSavedResult(
  projectId: number,
  segmentId: string,
  jobId: number,
  error: unknown,
  deps: TextVideoSpeechJobDeps,
): Promise<SavedSpeechResult> {
  try {
    const current = await deps.api.getSpeechContext(
      projectId,
      segmentId,
      jobId,
    )
    if ('already_saved' in current) return current.already_saved
  } catch {
    // Preserve the original persistence failure when reconciliation is down.
  }
  throw error
}

function errorRetryable(error: unknown) {
  if (
    error
    && typeof error === 'object'
    && 'retryable' in error
    && typeof error.retryable === 'boolean'
  ) return error.retryable
  return retryableForError(error)
}

export async function runTextVideoSpeechJob(
  jobId: number,
  providedDeps?: TextVideoSpeechJobDeps,
): Promise<SavedSpeechResult> {
  const deps = providedDeps ?? await defaultDeps(jobId)
  const job = await deps.api.getJob(jobId)
  const existing = latestStep(job.steps, 'generate_speech')
  if (job.status === 'cancelled') throw new Error('任务已取消')
  if (existing?.status === 'succeeded') {
    const output = resultFromOutput(existing.output)
    await finalizeJob(jobId, deps)
    return output
  }
  const { projectId, segmentId } = jobTarget(job)
  const step = existing?.status === 'running' && existing.id
    ? { id: existing.id }
    : await deps.api.startStep(jobId, 'generate_speech')
  let context: SpeechContext | undefined
  try {
    const current = await deps.api.getSpeechContext(
      projectId,
      segmentId,
      jobId,
    )
    if ('already_saved' in current) {
      const saved = current.already_saved
      return completePersistedResult(jobId, step.id, saved, deps)
    }
    context = current
    const result = await deps.speech.generate({
      text: context.text,
      voiceId: context.voice_settings.voice_id
        || context.runtime.default_voice,
      speed: context.voice_settings.speed,
      volume: context.voice_settings.volume,
      pitch: context.voice_settings.pitch,
      audio: {
        sampleRate: 44100,
        bitrate: 128000,
        format: 'mp3',
        channels: 1,
      },
    })
    let saved: SavedSpeechResult
    try {
      saved = await deps.api.saveSpeechResult(context, result, jobId)
    } catch (error) {
      saved = await recoverSavedResult(
        projectId,
        segmentId,
        jobId,
        error,
        deps,
      )
    }
    return completePersistedResult(jobId, step.id, saved, deps)
  } catch (error) {
    if (error instanceof JobFinalizationError) throw error
    const stale = Boolean(
      error
      && typeof error === 'object'
      && 'stale' in error
      && error.stale,
    )
    if (context && !stale) {
      try {
        await deps.api.postSpeechFailure(context, error, jobId)
      } catch {
        // Step failure remains necessary even when domain failure reporting
        // races a persisted result or the backend is temporarily unavailable.
      }
    }
    await deps.api.failStep(
      jobId,
      step.id,
      error,
      errorRetryable(error),
    )
    throw error
  }
}
