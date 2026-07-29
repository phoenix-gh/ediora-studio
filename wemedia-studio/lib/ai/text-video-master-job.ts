import { randomUUID } from 'node:crypto'

import type { TextVideoProject } from '@/lib/api/text-videos'

import { JobFinalizationError } from './digital-human-job'
import {
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


const ASSEMBLE_STEP = 'assemble_master_audio'
const ALIGN_STEP = 'align_master_timeline'

type MasterStep = typeof ASSEMBLE_STEP | typeof ALIGN_STEP

export type MasterSegmentOffset = {
  segment_id: string
  asset_id?: number
  sample_offset: number
  sample_count: number
}

export type MasterAssemblyResult = {
  source_hash: string
  asset_id: number
  audio_url: string
  duration: number
  sample_rate: number
  sample_count: number
  segment_offsets: MasterSegmentOffset[]
  owns_asset: boolean
}

type MasterFailure = {
  source_hash: string
  phase: MasterStep
  error: string
  step_id?: number
  attempt?: number
  claim_token?: string
}

type RunningStep = {
  id: number
  attempt: number
}

type StepFailureResolution<T> =
  | { kind: 'failed'; error: unknown }
  | { kind: 'recovered'; output: T }

type MasterProgressApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<RunningStep>
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
  postMasterAssemble(
    projectId: number,
    jobId: number,
  ): Promise<MasterAssemblyResult>
  postMasterAlign(
    projectId: number,
    input: {
      source_hash: string
      step_id: number
      attempt: number
      claim_token: string
    },
    jobId: number,
  ): Promise<TextVideoProject>
  postMasterFailure(
    projectId: number,
    failure: MasterFailure,
    jobId: number,
  ): Promise<{ failure_applied?: unknown }>
}

export type TextVideoMasterJobDeps = {
  api: MasterProgressApi
}

class MasterJobCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'MasterJobCancelledError'
  }
}

function latestStep(steps: JobStep[], key: MasterStep) {
  return steps
    .filter(step => step.key === key)
    .sort((left, right) => (
      right.attempt - left.attempt
      || Number(right.id ?? 0) - Number(left.id ?? 0)
    ))[0]
}

function positiveInteger(value: unknown) {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
  )
    ? value
    : undefined
}

function nonnegativeInteger(value: unknown) {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  )
    ? value
    : undefined
}

function assemblyFromOutput(
  output: Record<string, unknown>,
  expectedSourceHash: string,
): MasterAssemblyResult {
  const sourceHash = output.source_hash
  const assetId = positiveInteger(output.asset_id)
  const audioUrl = output.audio_url
  const duration = output.duration
  const sampleRate = positiveInteger(output.sample_rate)
  const sampleCount = positiveInteger(output.sample_count)
  const offsets = output.segment_offsets
  if (
    typeof sourceHash !== 'string'
    || !/^[a-f0-9]{64}$/iu.test(sourceHash)
    || sourceHash !== expectedSourceHash
    || assetId === undefined
    || typeof audioUrl !== 'string'
    || !audioUrl
    || typeof duration !== 'number'
    || !Number.isFinite(duration)
    || duration <= 0
    || sampleRate === undefined
    || sampleCount === undefined
    || duration !== sampleCount / sampleRate
    || !Array.isArray(offsets)
    || typeof output.owns_asset !== 'boolean'
  ) {
    throw new ApiRequestError('已完成的主音频拼接结果无效', false)
  }

  const seenSegmentIds = new Set<string>()
  let expectedSampleOffset = 0
  const segmentOffsets = offsets.map(item => {
    if (!item || typeof item !== 'object') {
      throw new ApiRequestError('已完成的主音频拼接结果无效', false)
    }
    const value = item as Record<string, unknown>
    const segmentId = value.segment_id
    const sampleOffset = nonnegativeInteger(value.sample_offset)
    const segmentSampleCount = positiveInteger(value.sample_count)
    const segmentAssetId = value.asset_id === undefined
      ? undefined
      : positiveInteger(value.asset_id)
    if (
      typeof segmentId !== 'string'
      || !segmentId
      || seenSegmentIds.has(segmentId)
      || sampleOffset === undefined
      || sampleOffset !== expectedSampleOffset
      || segmentSampleCount === undefined
      || (value.asset_id !== undefined && segmentAssetId === undefined)
    ) {
      throw new ApiRequestError('已完成的主音频拼接结果无效', false)
    }
    seenSegmentIds.add(segmentId)
    expectedSampleOffset += segmentSampleCount
    if (!Number.isSafeInteger(expectedSampleOffset)) {
      throw new ApiRequestError('已完成的主音频拼接结果无效', false)
    }
    return {
      segment_id: segmentId,
      ...(segmentAssetId === undefined ? {} : { asset_id: segmentAssetId }),
      sample_offset: sampleOffset,
      sample_count: segmentSampleCount,
    }
  })
  if (expectedSampleOffset !== sampleCount) {
    throw new ApiRequestError('已完成的主音频拼接结果无效', false)
  }

  return {
    source_hash: sourceHash,
    asset_id: assetId,
    audio_url: audioUrl,
    duration,
    sample_rate: sampleRate,
    sample_count: sampleCount,
    segment_offsets: segmentOffsets,
    owns_asset: output.owns_asset,
  }
}

function alignmentFromOutput(
  output: Record<string, unknown>,
  sourceHash: string,
): TextVideoProject {
  const master = (
    output.master_audio
    && typeof output.master_audio === 'object'
  )
    ? output.master_audio as Record<string, unknown>
    : undefined
  const renderInput = (
    output.render_input
    && typeof output.render_input === 'object'
  )
    ? output.render_input as Record<string, unknown>
    : undefined
  if (
    positiveInteger(output.id) === undefined
    || !master
    || master.status !== 'ready'
    || master.timeline_status !== 'ready'
    || master.source_hash !== sourceHash
    || !Array.isArray(master.word_timings)
    || master.word_timings.length === 0
    || !renderInput
    || typeof renderInput.audio !== 'string'
    || !renderInput.audio
  ) {
    throw new ApiRequestError('已完成的主音频时间轴结果无效', false)
  }
  return output as unknown as TextVideoProject
}

function jobContext(job: DurableJob) {
  const projectId = positiveInteger(job.input.project_id)
  const sourceHash = job.input.source_hash
  if (
    job.flow !== 'text_video_master_audio'
    || projectId === undefined
    || typeof sourceHash !== 'string'
    || !/^[a-f0-9]{64}$/iu.test(sourceHash)
  ) {
    throw new Error('文字视频主音频任务缺少有效快照')
  }
  return { projectId, sourceHash }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

async function reportFailure(
  jobId: number,
  projectId: number,
  sourceHash: string,
  phase: MasterStep,
  error: unknown,
  deps: TextVideoMasterJobDeps,
  claim?: RunningStep & { claim_token: string },
) {
  try {
    const result = await deps.api.postMasterFailure(
      projectId,
      {
        source_hash: sourceHash,
        phase,
        error: errorMessage(error),
        ...(claim
          ? {
              step_id: claim.id,
              attempt: claim.attempt,
              claim_token: claim.claim_token,
            }
          : {}),
      },
      jobId,
    )
    return { acknowledged: true as const, result }
  } catch {
    return { acknowledged: false as const }
  }
}

async function persistedStepOutput<T extends Record<string, unknown>>(
  jobId: number,
  key: MasterStep,
  deps: TextVideoMasterJobDeps,
  parse: (output: Record<string, unknown>) => T,
  cause: unknown,
): Promise<T> {
  let refreshed: DurableJob
  try {
    refreshed = await deps.api.getJob(jobId)
  } catch (readError) {
    throw new JobFinalizationError(
      '步骤结果可能已保存，等待任务状态对账',
      { cause: readError },
    )
  }
  if (refreshed.status === 'cancelled') {
    throw new MasterJobCancelledError()
  }
  const persisted = latestStep(refreshed.steps, key)
  if (persisted?.status !== 'succeeded') {
    throw new JobFinalizationError(
      '步骤结果可能已保存，等待任务状态对账',
      { cause: cause instanceof Error ? cause : undefined },
    )
  }
  try {
    return parse(persisted.output)
  } catch (parseError) {
    throw new JobFinalizationError(
      '已保存的步骤结果无效，等待任务状态对账',
      { cause: parseError },
    )
  }
}

async function runStep<T extends Record<string, unknown>>(
  jobId: number,
  key: MasterStep,
  deps: TextVideoMasterJobDeps,
  parse: (output: Record<string, unknown>) => T,
  work: (step: RunningStep) => Promise<T>,
  onFailure: (
    error: unknown,
    step: RunningStep,
  ) => Promise<StepFailureResolution<T>>,
): Promise<T> {
  const job = await deps.api.getJob(jobId)
  if (job.status === 'cancelled') throw new MasterJobCancelledError()
  const previous = latestStep(job.steps, key)
  if (previous?.status === 'succeeded') {
    try {
      return parse(previous.output)
    } catch (error) {
      throw new JobFinalizationError(
        '已保存的步骤结果无效，等待任务状态对账',
        { cause: error },
      )
    }
  }
  if (previous?.status === 'failed') {
    throw new Error(`${key} 步骤尚未进入重试队列`)
  }
  const step = previous?.status === 'running' && previous.id
    ? { id: previous.id, attempt: previous.attempt }
    : await deps.api.startStep(jobId, key)

  try {
    const output = parse(await work(step))
    await ensureNotCancelled(jobId, deps)
    try {
      await deps.api.completeStep(jobId, step.id, output)
      return output
    } catch (error) {
      return persistedStepOutput(jobId, key, deps, parse, error)
    }
  } catch (error) {
    if (
      error instanceof MasterJobCancelledError
      || error instanceof JobFinalizationError
    ) {
      throw error
    }
    await ensureNotCancelled(jobId, deps)
    const resolution = await onFailure(error, step)
    if (resolution.kind === 'recovered') {
      const recovered = resolution.output
      await ensureNotCancelled(jobId, deps)
      try {
        await deps.api.completeStep(jobId, step.id, recovered)
        return recovered
      } catch (completionError) {
        return persistedStepOutput(
          jobId,
          key,
          deps,
          parse,
          completionError,
        )
      }
    }
    await deps.api.failStep(
      jobId,
      step.id,
      resolution.error,
      retryableForError(resolution.error),
    )
    throw resolution.error
  }
}

async function ensureNotCancelled(
  jobId: number,
  deps: TextVideoMasterJobDeps,
) {
  let job: DurableJob
  try {
    job = await deps.api.getJob(jobId)
  } catch (error) {
    throw new JobFinalizationError(
      '无法确认任务是否已取消，等待任务状态对账',
      { cause: error },
    )
  }
  if (job.status === 'cancelled') throw new MasterJobCancelledError()
}

const defaultApi: MasterProgressApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  postMasterAssemble: (projectId, jobId) => apiPost(
    `/text-videos/${projectId}/master-audio/worker-assemble`,
    undefined,
    workerHeaders(jobId),
  ),
  postMasterAlign: (projectId, input, jobId) => apiPost(
    `/text-videos/${projectId}/master-audio/worker-align`,
    input,
    workerHeaders(jobId),
  ),
  postMasterFailure: (projectId, input, jobId) => apiPost(
    `/text-videos/${projectId}/master-audio/worker-failure`,
    input,
    workerHeaders(jobId),
  ),
}

async function finalizeJob(
  jobId: number,
  deps: TextVideoMasterJobDeps,
) {
  try {
    await deps.api.completeJob(jobId)
  } catch (error) {
    let durable: DurableJob
    try {
      durable = await deps.api.getJob(jobId)
    } catch (readError) {
      throw new JobFinalizationError(
        '主音频结果已保存，等待任务状态对账',
        { cause: readError },
      )
    }
    if (durable.status === 'cancelled') throw new MasterJobCancelledError()
    if (durable.status === 'succeeded') return
    throw new JobFinalizationError(
      '主音频结果已保存，等待任务状态对账',
      { cause: error },
    )
  }
}

export async function runTextVideoMasterJob(
  jobId: number,
  providedDeps?: TextVideoMasterJobDeps,
): Promise<TextVideoProject> {
  const deps = providedDeps ?? { api: defaultApi }
  const current = await deps.api.getJob(jobId)
  const { projectId, sourceHash: frozenSourceHash } = jobContext(current)

  const assembled = await runStep(
    jobId,
    ASSEMBLE_STEP,
    deps,
    output => assemblyFromOutput(output, frozenSourceHash),
    () => deps.api.postMasterAssemble(projectId, jobId),
    async error => {
      // Assembly has no paid-work claim. Preserve the original behavior:
      // durable step failure remains authoritative even if the best-effort
      // domain failure report is temporarily unavailable.
      await reportFailure(
        jobId,
        projectId,
        frozenSourceHash,
        ASSEMBLE_STEP,
        error,
        deps,
      )
      return { kind: 'failed', error }
    },
  )
  const alignmentClaimToken = randomUUID()
  const aligned = await runStep(
    jobId,
    ALIGN_STEP,
    deps,
    output => alignmentFromOutput(output, assembled.source_hash),
    step => deps.api.postMasterAlign(
      projectId,
      {
        source_hash: assembled.source_hash,
        step_id: step.id,
        attempt: step.attempt,
        claim_token: alignmentClaimToken,
      },
      jobId,
    ),
    async (error, step) => {
      let confirmedError = error
      if (
        !(error instanceof ApiRequestError)
        || !error.responseReceived
      ) {
        try {
          const replay = await deps.api.postMasterAlign(
            projectId,
            {
              source_hash: assembled.source_hash,
              step_id: step.id,
              attempt: step.attempt,
              claim_token: alignmentClaimToken,
            },
            jobId,
          )
          return {
            kind: 'recovered',
            output: alignmentFromOutput(
              replay as unknown as Record<string, unknown>,
              assembled.source_hash,
            ),
          }
        } catch (replayError) {
          if (
            !(replayError instanceof ApiRequestError)
            || !replayError.responseReceived
          ) {
            throw new JobFinalizationError(
              '主音频对齐结果仍不明确，等待任务状态对账',
              {
                cause: replayError instanceof Error
                  ? replayError
                  : undefined,
              },
            )
          }
          confirmedError = replayError
        }
      }
      const report = await reportFailure(
        jobId,
        projectId,
        assembled.source_hash,
        ALIGN_STEP,
        confirmedError,
        deps,
        {
          ...step,
          claim_token: alignmentClaimToken,
        },
      )
      if (!report.acknowledged) {
        throw new JobFinalizationError(
          '无法确认主音频对齐 claim，等待任务状态对账',
          { cause: error instanceof Error ? error : undefined },
        )
      }
      if (report.result.failure_applied === true) {
        return {
          kind: 'failed',
          error: confirmedError,
        }
      }
      try {
        const recoveredProject = {
          ...report.result,
        } as Record<string, unknown>
        delete recoveredProject.failure_applied
        return {
          kind: 'recovered',
          output: alignmentFromOutput(
            recoveredProject,
            assembled.source_hash,
          ),
        }
      } catch (reconcileError) {
        throw new JobFinalizationError(
          '主音频对齐失败状态不明确，等待任务状态对账',
          { cause: reconcileError },
        )
      }
    },
  )
  await finalizeJob(jobId, deps)
  return aligned
}
