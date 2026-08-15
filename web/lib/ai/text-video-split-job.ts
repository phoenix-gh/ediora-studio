import { createOpenAI } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'

import type { SpeechSplitProposal } from '@/lib/api/text-videos'

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


export const splitSchema = z.object({
  boundaries: z.array(z.object({
    id: z.string().min(1),
    reason: z.string().max(120),
  })),
})

type Boundary = {
  id: string
  kind: string
  context: string
}

type SplitContext = {
  projectId: number
  script: string
  scriptHash: string
  direction: string
  candidates: Boundary[]
}

type SplitProgressApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<{ id: number }>
  completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
  failStep(jobId: number, stepId: number, error: unknown, retryable?: boolean): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  validateProposal(
    projectId: number,
    jobId: number,
    body: { boundary_ids: string[]; script_hash: string },
  ): Promise<SpeechSplitProposal>
}

export type TextVideoSplitJobDeps = {
  api: SplitProgressApi
  generateBoundaries(context: Omit<SplitContext, 'projectId' | 'scriptHash'>): Promise<z.infer<typeof splitSchema>>
}

function asContext(job: DurableJob): SplitContext {
  const projectId = Number(job.input.project_id)
  const script = typeof job.input.script === 'string' ? job.input.script : ''
  const scriptHash = typeof job.input.script_hash === 'string' ? job.input.script_hash : ''
  const direction = typeof job.input.direction === 'string' ? job.input.direction : ''
  const candidates = Array.isArray(job.input.candidates)
    ? job.input.candidates.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const candidate = item as Record<string, unknown>
      if (
        typeof candidate.id !== 'string'
        || typeof candidate.kind !== 'string'
        || typeof candidate.context !== 'string'
      ) return []
      return [{ id: candidate.id, kind: candidate.kind, context: candidate.context }]
    })
    : []
  if (
    job.flow !== 'text_video_split_preview'
    || !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !script.trim()
    || !/^[a-f0-9]{64}$/i.test(scriptHash)
  ) throw new Error('口播分段预览任务缺少有效快照')
  return { projectId, script, scriptHash, direction, candidates }
}

function latestStep(steps: JobStep[], key: string) {
  return steps
    .filter(step => step.key === key)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

function proposalFromOutput(output: Record<string, unknown>): SpeechSplitProposal {
  const parsed = z.object({
    segments: z.array(z.object({
      id: z.string().min(1),
      text: z.string(),
      estimated_duration: z.number().nonnegative(),
      reason: z.string(),
    })),
    speech_split_mode: z.literal('auto'),
  }).safeParse(output)
  if (!parsed.success) throw new Error('已完成的口播分段预览结果无效')
  return parsed.data
}

function withAiReasons(
  proposal: SpeechSplitProposal,
  boundaries: z.infer<typeof splitSchema>['boundaries'],
): SpeechSplitProposal {
  const reasons = new Map(boundaries.map(boundary => [boundary.id, boundary.reason]))
  return {
    ...proposal,
    segments: proposal.segments.map((segment, index) => ({
      ...segment,
      reason: reasons.get(boundaries[index]?.id) || '完整口播段',
    })),
  }
}

async function configuredModel(jobId: number) {
  const runtime = await apiGet<{ api_key: string; model: string; base_url: string }>(
    '/settings/ai-runtime',
    workerHeaders(jobId),
  )
  const apiKey = runtime.api_key || process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('请先配置 AI 大模型 API Key')
  return {
    apiKey,
    modelName: runtime.model || process.env.WMS_LLM_MODEL || 'gpt-4o-mini',
    baseURL: runtime.base_url || process.env.WMS_LLM_BASE_URL || undefined,
  }
}

async function generateBoundariesWithAi(
  context: Omit<SplitContext, 'projectId' | 'scriptHash'>,
  jobId: number,
) {
  const config = await configuredModel(jobId)
  const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  const result = await generateObject({
    model: provider.chat(config.modelName),
    schema: splitSchema,
    prompt: [
      '你是中文口播分段助手。不得改写、删减、补充或重排稿件文本。',
      '只能返回候选边界 ID 与简短理由，不得返回字符位置、文本片段或其他字段。',
      '优先选择语义完整、适合实际 TTS 长度的句群；没有必要时可以不选择边界。',
      `用户方向：${context.direction || '未提供额外方向'}`,
      `完整稿件：\n${context.script}`,
      `有序候选边界：\n${JSON.stringify(context.candidates)}`,
    ].join('\n\n'),
  })
  return splitSchema.parse(result.object)
}

const defaultApi: SplitProgressApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  validateProposal: (projectId, jobId, body) => apiPost(
    `/text-videos/${projectId}/speech-split-preview/worker-validate`,
    body,
    workerHeaders(jobId),
  ),
}

async function defaultDeps(jobId: number): Promise<TextVideoSplitJobDeps> {
  return {
    api: defaultApi,
    generateBoundaries: context => generateBoundariesWithAi(context, jobId),
  }
}

async function finalizeJob(jobId: number, deps: TextVideoSplitJobDeps) {
  try {
    await deps.api.completeJob(jobId)
  } catch (error) {
    throw new JobFinalizationError('步骤结果已保存，等待任务状态对账', {
      cause: error,
    })
  }
}

export async function runTextVideoSplitJob(
  jobId: number,
  providedDeps?: TextVideoSplitJobDeps,
): Promise<SpeechSplitProposal> {
  const deps = providedDeps ?? await defaultDeps(jobId)
  const job = await deps.api.getJob(jobId)
  const existing = latestStep(job.steps, 'propose_boundaries')
  if (job.status === 'cancelled') {
    if (existing?.status === 'succeeded') {
      return proposalFromOutput(existing.output)
    }
    throw new Error('任务已取消')
  }
  if (existing?.status === 'succeeded') {
    const proposal = proposalFromOutput(existing.output)
    await finalizeJob(jobId, deps)
    return proposal
  }
  const context = asContext(job)
  const step = existing?.status === 'running' && existing.id
    ? { id: existing.id }
    : await deps.api.startStep(jobId, 'propose_boundaries')
  try {
    const aiResult = await deps.generateBoundaries({
      script: context.script,
      direction: context.direction,
      candidates: context.candidates,
    })
    const validated = await deps.api.validateProposal(context.projectId, jobId, {
      boundary_ids: aiResult.boundaries.map(boundary => boundary.id),
      script_hash: context.scriptHash,
    })
    const proposal = withAiReasons(validated, aiResult.boundaries)
    await deps.api.completeStep(jobId, step.id, proposal)
    await finalizeJob(jobId, deps)
    return proposal
  } catch (error) {
    if (error instanceof JobFinalizationError) throw error
    await deps.api.failStep(jobId, step.id, error, retryableForError(error))
    throw error
  }
}
