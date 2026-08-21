import { randomUUID } from 'node:crypto'

import { generateText } from 'ai'
import { z } from 'zod'

import type {
  GlobalWordTiming,
  ScenePlanSceneDocument,
  TextVideoProject,
} from '@/lib/api/text-videos'

import { JobFinalizationError } from './digital-human-job'
import {
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
import {
  openaiProviderFromConfig,
  textModelConfigFromSettings,
  textModelForProvider,
  type TextModelSettings,
} from './runtime-config'


const sceneSchema = z.object({
  id: z.string().min(1),
  fromWordId: z.string().min(1),
  throughWordId: z.string().min(1),
  displayText: z.string().min(1),
  highlight: z.array(z.string()),
  animation: z.string().min(1),
}).strict()

const motionChunkSchema = z.object({
  id: z.string().min(1),
  fromWordId: z.string().min(1),
  throughWordId: z.string().min(1),
  displayText: z.string().min(1),
  highlight: z.array(z.string()),
  motionPreset: z.enum(['impact', 'reveal', 'contrast']),
  emphasis: z.enum(['normal', 'punch']),
}).strict()

const motionSchema = z.object({
  transition: z.literal('block-wipe'),
  intensity: z.number().min(0).max(1),
  chunks: z.array(motionChunkSchema).min(1),
}).strict()

const motionSceneSchema = z.object({
  id: z.string().min(1),
  fromWordId: z.string().min(1),
  throughWordId: z.string().min(1),
  displayText: z.string().min(1),
  highlight: z.array(z.string()),
  animation: z.enum(['impact', 'reveal', 'contrast']),
  motion: motionSchema,
}).strict()

export const sceneProposalSchema = z.object({
  scenes: z.array(sceneSchema).min(1),
}).strict()

export const motionProposalSchema = z.object({
  scenes: z.array(motionSceneSchema).min(1),
}).strict()

type ProposalSchema = typeof sceneProposalSchema | typeof motionProposalSchema

export type AiSceneProposal = (
  z.infer<typeof sceneProposalSchema>
  | z.infer<typeof motionProposalSchema>
)

export const validatedSceneProposalSchema = z.object({
  scenes: z.array(sceneSchema).min(1),
  validation_token: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict()

export const validatedMotionProposalSchema = z.object({
  scenes: z.array(motionSceneSchema).min(1),
  validation_token: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict()

export type ValidatedSceneProposal = (
  z.infer<typeof validatedSceneProposalSchema>
  | z.infer<typeof validatedMotionProposalSchema>
)

export type SceneWorkerClaim = {
  step_id: number
  attempt: number
  claim_token: string
}

export type SceneJobContext = {
  project_id: number
  master_source_hash: string
  timeline_fingerprint: string
  scene_generation_revision: number
  generation_mode?: 'scene' | 'motion'
  script: string
  words: GlobalWordTiming[]
  speech_segments: Array<{
    id: string
    fromWordId: string
    throughWordId: string
  }>
  template: {
    id: string
    version: number
    animations: string[]
    transitions: string[]
  }
  existing_scenes: ScenePlanSceneDocument[]
  scope: 'all' | 'selected'
  selected_scene_id: string
  direction: string
}

type SceneProgressApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(
    jobId: number,
    key: string,
  ): Promise<{ id: number; attempt: number }>
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
  getSceneContext(
    projectId: number,
    jobId: number,
    claim: SceneWorkerClaim,
  ): Promise<SceneJobContext | { already_saved: TextVideoProject }>
  validateScenePlan(
    projectId: number,
    proposal: unknown,
    jobId: number,
    claim: SceneWorkerClaim,
  ): Promise<ValidatedSceneProposal>
  persistScenePlan(
    projectId: number,
    proposal: ValidatedSceneProposal,
    jobId: number,
    claim: SceneWorkerClaim,
  ): Promise<TextVideoProject>
  failScenePlan(
    projectId: number,
    error: string,
    jobId: number,
    claim: SceneWorkerClaim,
  ): Promise<unknown>
}

export type TextVideoSceneJobDeps = {
  generate(input: {
    schema: ProposalSchema
    prompt: string
  }): Promise<unknown>
  api: SceneProgressApi
  createClaimToken?(): string
}

class ScenePlanValidationError extends Error {
  readonly status = 422
  readonly detail: unknown
  readonly retryable = false

  constructor(message: string, detail: unknown, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScenePlanValidationError'
    this.detail = detail
  }
}

export class SceneJobPendingError extends Error {
  constructor() {
    super('AI 分镜步骤正在由其他 worker 执行，等待状态对账')
    this.name = 'SceneJobPendingError'
  }
}

function latestStep(steps: JobStep[], key: string) {
  return steps
    .filter(step => step.key === key)
    .sort((left, right) => (
      right.attempt - left.attempt
      || Number(right.id ?? 0) - Number(left.id ?? 0)
    ))[0]
}

function projectIdFromJob(job: DurableJob) {
  const projectId = job.input.project_id
  if (
    job.flow !== 'text_video_scene_plan'
    || typeof projectId !== 'number'
    || !Number.isSafeInteger(projectId)
    || projectId <= 0
  ) {
    throw new Error('文字视频 AI 分镜任务缺少有效快照')
  }
  return projectId
}

function projectFromOutput(
  output: Record<string, unknown>,
  job: DurableJob,
) {
  const project = output.project
  const scenePlan = (
    project
    && typeof project === 'object'
    && 'scene_plan' in project
    && project.scene_plan
    && typeof project.scene_plan === 'object'
  )
    ? project.scene_plan as Record<string, unknown>
    : undefined
  const expectedGeneration = Number(job.input.scene_generation_revision) + 1
  if (
    !project
    || typeof project !== 'object'
    || (project as { id?: unknown }).id !== job.input.project_id
    || !scenePlan
    || scenePlan.status !== 'ready'
    || scenePlan.generation_revision !== expectedGeneration
    || scenePlan.master_source_hash !== job.input.master_source_hash
    || scenePlan.job_id !== null
    || scenePlan.applied_job_id !== job.id
    || !Array.isArray(scenePlan.scenes)
    || scenePlan.scenes.length === 0
  ) {
    throw new Error('已完成的 AI 分镜结果无效')
  }
  return project as TextVideoProject
}

function errorStatus(error: unknown) {
  if (
    error
    && typeof error === 'object'
    && 'status' in error
    && typeof error.status === 'number'
  ) return error.status
  return undefined
}

function requestOutcomeIsAmbiguous(error: unknown) {
  const responseReceived = Boolean(
    error
      && typeof error === 'object'
      && 'responseReceived' in error
      && error.responseReceived === true,
  )
  if (!responseReceived) return true
  const status = errorStatus(error)
  return status === 408 || (status !== undefined && status >= 500)
}

function errorDetail(error: unknown) {
  if (error && typeof error === 'object' && 'detail' in error) {
    return error.detail
  }
  return error instanceof Error ? error.message : String(error)
}

function isSceneClaimConflict(error: unknown) {
  if (errorStatus(error) !== 409) return false
  const detail = errorDetail(error)
  return Boolean(
    detail
    && typeof detail === 'object'
    && 'code' in detail
    && detail.code === 'scene_claim_conflict',
  )
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
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

function promptForContext(context: SceneJobContext) {
  const words = context.words.map(word => ({
    id: word.id,
    text: word.text,
    speechSegmentId: word.speech_segment_id,
  }))
  if (context.generation_mode === 'motion') {
    return [
      '你是文字视频动效导演。只返回符合 schema 的 JSON，不得输出秒数、时间戳或额外字段。',
      '顶层分镜字段必须原样保留：id、fromWordId、throughWordId、displayText、highlight、animation 均不得修改。',
      '只能设计 motion；短句必须按有序 word ID 连续、无重叠地覆盖所属分镜，displayText 必须无损覆盖原文。',
      '只可使用 impact、reveal、contrast，转场只能是 block-wipe，强度必须在 0 到 1 之间。',
      `生成范围：${context.scope}`,
      `目标分镜 ID：${context.selected_scene_id || '无'}`,
      `用户方向：${context.direction || '未提供额外方向'}`,
      `模板能力：${JSON.stringify(context.template)}`,
      `有序词 ID 与文本：${JSON.stringify(words)}`,
      `冻结的分镜：${JSON.stringify(context.existing_scenes)}`,
      '返回格式示例：{"scenes":[{"id":"scene-1","fromWordId":"word-1","throughWordId":"word-3","displayText":"示例","highlight":[],"animation":"impact","motion":{"transition":"block-wipe","intensity":0.8,"chunks":[{"id":"scene-1-chunk-1","fromWordId":"word-1","throughWordId":"word-3","displayText":"示例","highlight":[],"motionPreset":"impact","emphasis":"punch"}]}}]}',
    ].join('\n\n')
  }
  return [
    '你是文字视频分镜导演。只返回符合 schema 的 JSON，不得输出秒数、时间戳或额外字段。',
    '每个分镜只能使用 fromWordId 和 throughWordId 表达范围。',
    'scope=all 时必须从第一个词到最后一个词完整、连续、无重叠地覆盖。',
    'scope=selected 时只返回目标分镜一个 proposal，且词边界与原分镜完全一致，只修改视觉字段。',
    `生成范围：${context.scope}`,
    `目标分镜 ID：${context.selected_scene_id || '无'}`,
    `用户方向：${context.direction || '未提供额外方向'}`,
    `模板能力：${JSON.stringify(context.template)}`,
    `稿件：${context.script}`,
    `有序词 ID 与文本：${JSON.stringify(words)}`,
    `口播语义段：${JSON.stringify(context.speech_segments)}`,
    `已有分镜视觉意图：${JSON.stringify(context.existing_scenes)}`,
    '返回格式示例：{"scenes":[{"id":"scene-1","fromWordId":"word-1","throughWordId":"word-3","displayText":"示例","highlight":[],"animation":"fade-up"}]}',
  ].join('\n\n')
}

function repairPrompt(
  originalPrompt: string,
  invalid: unknown,
  validationError: unknown,
) {
  return [
    originalPrompt,
    '上一次 JSON 未通过服务端校验。你只有这一次修复机会。',
    `服务端确切错误：${JSON.stringify(errorDetail(validationError))}`,
    `上一次无效 JSON：${JSON.stringify(invalid)}`,
    '仅修复上述错误，仍然不得返回秒数、时间戳或额外字段。',
  ].join('\n\n')
}

async function configuredModel(jobId: number) {
  const runtime = await apiGet<TextModelSettings>(
    '/settings/ai-runtime', workerHeaders(jobId),
  )
  return textModelConfigFromSettings(runtime)
}

async function generateScenesWithAi(
  input: { schema: ProposalSchema; prompt: string },
  jobId: number,
) {
  const config = await configuredModel(jobId)
  const provider = openaiProviderFromConfig(config)
  const result = await generateText({
    model: textModelForProvider(provider, config.modelName, config.protocol),
    prompt: input.prompt,
  })
  const json = result.text
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
  return input.schema.parse(JSON.parse(json))
}

const defaultApi: SceneProgressApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  getSceneContext: (projectId, jobId, claim) => apiGet(
    `/text-videos/${projectId}/scene-plan/worker-context`,
    sceneWorkerHeaders(jobId, claim),
  ),
  validateScenePlan: (projectId, proposal, jobId, claim) => apiPost(
    `/text-videos/${projectId}/scene-plan/worker-validate`,
    proposal,
    sceneWorkerHeaders(jobId, claim),
  ),
  persistScenePlan: (projectId, proposal, jobId, claim) => apiPost(
    `/text-videos/${projectId}/scene-plan/worker-result`,
    proposal,
    sceneWorkerHeaders(jobId, claim),
  ),
  failScenePlan: (projectId, error, jobId, claim) => apiPost(
    `/text-videos/${projectId}/scene-plan/worker-failure`,
    { error },
    sceneWorkerHeaders(jobId, claim),
  ),
}

function sceneWorkerHeaders(
  jobId: number,
  claim: SceneWorkerClaim,
) {
  return {
    ...workerHeaders(jobId),
    'X-Content-Step-Id': String(claim.step_id),
    'X-Content-Step-Attempt': String(claim.attempt),
    'X-Content-Step-Claim': claim.claim_token,
  }
}

async function finalizeJob(jobId: number, deps: TextVideoSceneJobDeps) {
  try {
    await deps.api.completeJob(jobId)
  } catch (error) {
    let current: DurableJob
    try {
      current = await deps.api.getJob(jobId)
    } catch (readError) {
      throw new JobFinalizationError(
        'AI 分镜结果已保存，等待任务状态对账',
        { cause: readError },
      )
    }
    if (current.status === 'succeeded') return
    throw new JobFinalizationError(
      'AI 分镜结果已保存，等待任务状态对账',
      { cause: error },
    )
  }
}

async function completeSceneStep(
  jobId: number,
  step: { id: number; attempt: number },
  project: TextVideoProject,
  frozenJob: DurableJob,
  deps: TextVideoSceneJobDeps,
) {
  const output = { project }
  try {
    await deps.api.completeStep(jobId, step.id, output)
  } catch (error) {
    let current: DurableJob
    try {
      current = await deps.api.getJob(jobId)
    } catch (readError) {
      throw new JobFinalizationError(
        'AI 分镜步骤结果可能已保存，等待状态对账',
        { cause: readError },
      )
    }
    const persisted = latestStep(current.steps, 'generate_scene_plan')
    if (
      persisted?.id !== step.id
      || persisted.attempt !== step.attempt
      || persisted.status !== 'succeeded'
    ) {
      throw new JobFinalizationError(
        'AI 分镜步骤结果可能已保存，等待状态对账',
        { cause: error },
      )
    }
    project = projectFromOutput(persisted.output, frozenJob)
  }
  await finalizeJob(jobId, deps)
  return project
}

async function startSceneStep(
  jobId: number,
  deps: TextVideoSceneJobDeps,
) {
  try {
    return await deps.api.startStep(
      jobId,
      'generate_scene_plan',
    )
  } catch (error) {
    if (!requestOutcomeIsAmbiguous(error)) throw error
    let current: DurableJob
    try {
      current = await deps.api.getJob(jobId)
    } catch (readError) {
      throw new JobFinalizationError(
        'AI 分镜步骤启动状态无法确认，等待状态对账',
        {
          cause: readError instanceof Error
            ? readError
            : undefined,
        },
      )
    }
    const running = latestStep(
      current.steps,
      'generate_scene_plan',
    )
    if (
      current.status === 'running'
      && running?.status === 'running'
      && Number.isSafeInteger(running.id)
      && Number(running.id) > 0
      && Number.isSafeInteger(running.attempt)
      && running.attempt > 0
    ) {
      return {
        id: Number(running.id),
        attempt: running.attempt,
      }
    }
    throw new JobFinalizationError(
      'AI 分镜步骤启动状态无法确认，等待状态对账',
      { cause: error instanceof Error ? error : undefined },
    )
  }
}

async function validateWithOneRepair(
  projectId: number,
  context: SceneJobContext,
  jobId: number,
  claim: SceneWorkerClaim,
  deps: TextVideoSceneJobDeps,
) {
  const basePrompt = promptForContext(context)
  const proposalSchema = context.generation_mode === 'motion'
    ? motionProposalSchema
    : sceneProposalSchema
  const validatedSchema = context.generation_mode === 'motion'
    ? validatedMotionProposalSchema
    : validatedSceneProposalSchema
  const first = proposalSchema.parse(await deps.generate({
    schema: proposalSchema,
    prompt: basePrompt,
  }))
  try {
    return validatedSchema.parse(
      await deps.api.validateScenePlan(projectId, first, jobId, claim),
    )
  } catch (error) {
    if (errorStatus(error) !== 422) throw error
    const repaired = proposalSchema.parse(await deps.generate({
      schema: proposalSchema,
      prompt: repairPrompt(basePrompt, first, error),
    }))
    try {
      return validatedSchema.parse(
        await deps.api.validateScenePlan(
          projectId,
          repaired,
          jobId,
          claim,
        ),
      )
    } catch (repairError) {
      if (errorStatus(repairError) !== 422) throw repairError
      throw new ScenePlanValidationError(
        'AI 分镜连续两次未通过校验',
        errorDetail(repairError),
        { cause: repairError instanceof Error ? repairError : undefined },
      )
    }
  }
}

export async function runTextVideoSceneJob(
  jobId: number,
  providedDeps?: TextVideoSceneJobDeps,
): Promise<TextVideoProject> {
  const deps = providedDeps ?? {
    api: defaultApi,
    generate: input => generateScenesWithAi(input, jobId),
  }
  const job = await deps.api.getJob(jobId)
  const projectId = projectIdFromJob(job)
  const previous = latestStep(job.steps, 'generate_scene_plan')
  if (job.status === 'cancelled') throw new Error('任务已取消')
  if (previous?.status === 'succeeded') {
    const project = projectFromOutput(previous.output, job)
    await finalizeJob(jobId, deps)
    return project
  }
  if (previous?.status === 'running') {
    throw new SceneJobPendingError()
  }
  if (previous?.status === 'failed') {
    throw new Error('AI 分镜失败步骤尚未进入重试队列')
  }
  const step = await startSceneStep(jobId, deps)
  if (
    !Number.isSafeInteger(step.id)
    || step.id <= 0
    || !Number.isSafeInteger(step.attempt)
    || step.attempt <= 0
  ) throw new Error('AI 分镜步骤 claim 无效')
  const claim = {
    step_id: step.id,
    attempt: step.attempt,
    claim_token: deps.createClaimToken?.() ?? randomUUID(),
  }

  try {
    const loadedContext = await deps.api.getSceneContext(
      projectId,
      jobId,
      claim,
    )
    if ('already_saved' in loadedContext) {
      const saved = projectFromOutput(
        { project: loadedContext.already_saved },
        job,
      )
      return completeSceneStep(
        jobId,
        step,
        saved,
        job,
        deps,
      )
    }
    const context = loadedContext
    const proposal = await validateWithOneRepair(
      projectId,
      context,
      jobId,
      claim,
      deps,
    )
    let project: TextVideoProject
    try {
      project = await deps.api.persistScenePlan(
        projectId,
        proposal,
        jobId,
        claim,
      )
    } catch (persistError) {
      if (!requestOutcomeIsAmbiguous(persistError)) {
        throw persistError
      }
      let reconciled: (
        SceneJobContext
        | { already_saved: TextVideoProject }
      )
      try {
        reconciled = await deps.api.getSceneContext(
          projectId,
          jobId,
          claim,
        )
      } catch (readError) {
        if (isSceneClaimConflict(readError)) {
          throw new SceneJobPendingError()
        }
        throw new JobFinalizationError(
          'AI 分镜结果状态无法确认，等待状态对账',
          {
            cause: readError instanceof Error
              ? readError
              : undefined,
          },
        )
      }
      if (!('already_saved' in reconciled)) throw persistError
      project = projectFromOutput(
        { project: reconciled.already_saved },
        job,
      )
    }
    project = projectFromOutput({ project }, job)
    return completeSceneStep(jobId, step, project, job, deps)
  } catch (error) {
    if (error instanceof SceneJobPendingError) throw error
    if (isSceneClaimConflict(error)) {
      throw new SceneJobPendingError()
    }
    if (error instanceof JobFinalizationError) throw error
    const stale = errorStatus(error) === 409
    if (!stale) {
      try {
        await deps.api.failScenePlan(
          projectId,
          errorMessage(error),
          jobId,
          claim,
        )
      } catch (failureError) {
        try {
          await deps.api.failScenePlan(
            projectId,
            errorMessage(error),
            jobId,
            claim,
          )
        } catch (replayError) {
          throw new JobFinalizationError(
            'AI 分镜失败状态无法确认，等待状态对账',
            {
              cause: replayError instanceof Error
                ? replayError
                : failureError instanceof Error
                  ? failureError
                  : undefined,
            },
          )
        }
      }
    }
    try {
      await deps.api.failStep(
        jobId,
        step.id,
        error,
        stale ? false : errorRetryable(error),
      )
    } catch (stepError) {
      if (!stale) {
        let current: DurableJob
        try {
          current = await deps.api.getJob(jobId)
        } catch (readError) {
          throw new JobFinalizationError(
            'AI 分镜失败步骤状态无法确认，等待状态对账',
            { cause: readError instanceof Error ? readError : undefined },
          )
        }
        const persisted = latestStep(
          current.steps,
          'generate_scene_plan',
        )
        if (
          current.status !== 'failed'
          || persisted?.id !== step.id
          || persisted.attempt !== step.attempt
          || persisted.status !== 'failed'
        ) {
          throw new JobFinalizationError(
            'AI 分镜失败步骤状态无法确认，等待状态对账',
            { cause: stepError instanceof Error ? stepError : undefined },
          )
        }
      }
    }
    throw error
  }
}
