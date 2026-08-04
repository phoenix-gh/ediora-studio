import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

import {
  checkpointAgentExecution,
  claimAgentToolCall,
  completeAgentExecution,
  completeAgentToolCall,
  ensureAgentExecution,
  failAgentToolCall,
  listAgentToolCalls,
  type AgentExecutionCheckpoint,
  type DurableAgentToolCall,
  type DurableAgentExecution,
} from './agent-execution-client'
import {
  agentSkillRunAudit,
  openAgentRuntime,
  type AgentRuntime,
  type OpenAgentRuntimeOptions,
} from './agent-runtime'
import type {
  AgentCompletionEvidence,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'
import {
  apiGet,
  completeJob,
  completeStep,
  failStep,
  getJob,
  retryableForError,
  startStep,
  workerHeaders,
  type DurableJob,
} from './job-client'

export type DailyCreationAgentContext = {
  id: number
  status: string
  requested_count: number
  rule: {
    name: string
    asset_type: 'article' | 'media'
    directory?: string
    directories?: string[]
    output_type: 'x_short_post'
    target_count: number
    lookback_days: number
    delivery_mode: 'drafts' | 'plan_items'
    account_id?: string | null
    instructions?: string
    skill_mode: 'auto' | 'manual'
    skill_name?: string | null
  }
}

type ObjectiveContext = DailyCreationAgentContext & { executionId?: number }

export function buildDailyCreationAgentObjective(context: ObjectiveContext) {
  const directories = context.rule.directories?.length
    ? context.rule.directories
    : context.rule.directory ? [context.rule.directory] : []
  const executionLine = context.executionId
    ? `固定执行标识：run_id=${context.id}，execution_id=${context.executionId}。`
    : `固定运行标识：run_id=${context.id}；execution_id 将在执行记录创建后提供。`
  return `你是 WeMediaStudio 的后台创作 Agent。完整负责这一次创作任务，并自行决定合理工作方式。

任务：从素材目录 ${directories.join('、')} 中创作 ${context.requested_count} 条中文 X 短帖。输出到${context.rule.delivery_mode === 'drafts' ? '创作草稿' : '每日计划'}。${context.rule.account_id ? `账号为 ${context.rule.account_id}。` : ''}
语义去重范围：最近 ${context.rule.lookback_days} 天。你必须调用 list_creative_asset_candidates 获取目录内候选，并调用 get_recent_content_usage 获取近期全局使用记录；需要完整内容时调用 get_creative_asset。所有引用的素材 ID 和历史 usage ID 必须来自本次执行成功的工具结果。
${executionLine}
可使用所有全局工具与当前启用的 Skill。${context.rule.instructions ? `用户补充要求：${context.rule.instructions}` : ''}
你必须自行校验最终短帖的事实依据、彼此差异、近期语义重复和规则符合性。最终只能调用 save_daily_creation_outputs 一次性原子落库，参数必须使用上述 run_id、execution_id，并附带 passed=true 的 self_validation。每条 post 至少提供 source_asset_ids、text、reuse_decision、reuse_explanation、compared_usage_ids；不要臆造素材或用量记录。
只有该工具返回的真实 ID 才表示完成。仅输出说明、草稿文本或“已完成”都不算完成。`
}

const positiveIds = z.array(z.number().int().positive())
const saveOutputSchema = z.object({
  execution_id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  created_count: z.number().int().positive(),
  output_ids: positiveIds,
  usage_ids: positiveIds,
}).passthrough()

const completionEvidenceSchema = z.object({
  toolName: z.literal('save_daily_creation_outputs'),
  toolCallId: z.string().min(1),
  runId: z.number().int().positive(),
  createdCount: z.number().int().positive(),
  outputIds: positiveIds,
  usageIds: positiveIds,
})

function parseJsonText(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const text = value.find(item => (
    item && typeof item === 'object' && item.type === 'text'
    && typeof item.text === 'string'
  )) as { text?: string } | undefined
  if (!text?.text) return undefined
  try { return JSON.parse(text.text) as unknown } catch { return undefined }
}

function unwrapMcpOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (record.structuredContent !== undefined) {
    const structured = record.structuredContent
    if (structured && typeof structured === 'object' && 'result' in structured) {
      return (structured as Record<string, unknown>).result
    }
    return structured
  }
  const fromText = parseJsonText(record.content)
  if (fromText !== undefined) return unwrapMcpOutput(fromText)
  if ('result' in record) return record.result
  return value
}

export function completionEvidenceFromAudit(
  event: AgentToolAudit,
  expected: { executionId: number; runId: number; requestedCount: number },
): AgentCompletionEvidence | null {
  if (event.status !== 'succeeded' || event.toolName !== 'save_daily_creation_outputs') {
    return null
  }
  const parsed = saveOutputSchema.safeParse(unwrapMcpOutput(event.output))
  if (!parsed.success) return null
  const value = parsed.data
  if (
    value.execution_id !== expected.executionId
    || value.run_id !== expected.runId
    || value.created_count > expected.requestedCount
    || value.output_ids.length !== value.created_count
    || value.usage_ids.length !== value.created_count
    || new Set(value.output_ids).size !== value.output_ids.length
    || new Set(value.usage_ids).size !== value.usage_ids.length
  ) return null
  return {
    toolName: 'save_daily_creation_outputs',
    toolCallId: event.toolCallId,
    runId: value.run_id,
    createdCount: value.created_count,
    outputIds: value.output_ids,
    usageIds: value.usage_ids,
  }
}

type Model = OpenAgentRuntimeOptions['model']

export type DailyCreationAgentJobDependencies = {
  getJob(jobId: number): Promise<DurableJob>
  getContext(runId: number, jobId: number): Promise<DailyCreationAgentContext>
  loadModel(jobId: number): Promise<Model>
  ensureExecution(jobId: number, request: {
    objective: string
    skillMode: 'auto' | 'manual'
    skillName: string | null
  }): Promise<DurableAgentExecution>
  checkpointExecution(
    jobId: number, executionId: number, expectedVersion: number,
    update: AgentExecutionCheckpoint,
  ): Promise<DurableAgentExecution>
  claimToolCall(
    jobId: number, executionId: number, event: AgentToolAudit,
  ): Promise<AgentToolDecision>
  listToolCalls(jobId: number, executionId: number): Promise<DurableAgentToolCall[]>
  completeToolCall(jobId: number, executionId: number, toolCallId: string, output: unknown): Promise<unknown>
  failToolCall(jobId: number, executionId: number, toolCallId: string, error: string, uncertain: boolean): Promise<unknown>
  completeExecution(jobId: number, executionId: number, evidence: AgentCompletionEvidence): Promise<unknown>
  startStep(jobId: number, key: string): Promise<{ id: number; attempt: number }>
  completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
  failStep(jobId: number, stepId: number, error: unknown, retryable: boolean): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  openRuntime(options: OpenAgentRuntimeOptions): Promise<AgentRuntime>
  apiRoot(): string
}

function defaultApiRoot() {
  return (process.env.WMS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api')
    .replace(/\/api\/?$/, '')
}

async function configuredModel(jobId: number): Promise<Model> {
  const settings = await apiGet<{ api_key: string; model: string; base_url: string }>(
    '/settings/ai-runtime', workerHeaders(jobId),
  )
  const apiKey = settings.api_key || process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('No LLM API key is configured')
  return createOpenAI({
    apiKey,
    baseURL: settings.base_url || process.env.WMS_LLM_BASE_URL || undefined,
  }).chat(settings.model || process.env.WMS_LLM_MODEL || 'gpt-4o-mini')
}

const defaultDependencies: DailyCreationAgentJobDependencies = {
  getJob,
  getContext: (runId, jobId) => apiGet(
    `/daily-plan/creation-runs/${runId}/context`, workerHeaders(jobId),
  ),
  loadModel: configuredModel,
  ensureExecution: ensureAgentExecution,
  checkpointExecution: checkpointAgentExecution,
  claimToolCall: claimAgentToolCall,
  listToolCalls: listAgentToolCalls,
  completeToolCall: completeAgentToolCall,
  failToolCall: failAgentToolCall,
  completeExecution: completeAgentExecution,
  startStep,
  completeStep,
  failStep,
  completeJob,
  openRuntime: openAgentRuntime,
  apiRoot: defaultApiRoot,
}

function completedStepEvidence(job: DurableJob) {
  const output = [...job.steps]
    .filter(step => step.key === 'agent' && step.status === 'succeeded')
    .sort((left, right) => right.attempt - left.attempt)[0]?.output
  const parsed = completionEvidenceSchema.safeParse(output)
  return parsed.success ? parsed.data : undefined
}

export async function runDailyCreationAgentJob(
  jobId: number,
  deps: DailyCreationAgentJobDependencies = defaultDependencies,
): Promise<AgentCompletionEvidence> {
  const job = await deps.getJob(jobId)
  const previousEvidence = completedStepEvidence(job)
  if (previousEvidence) {
    if (job.status !== 'succeeded') await deps.completeJob(jobId)
    return previousEvidence
  }
  if (job.status === 'succeeded' || job.status === 'cancelled') {
    throw new Error(`daily creation Agent job is terminal without completion evidence: ${job.status}`)
  }
  const runId = Number(job.input.run_id)
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('daily_creation agent flow requires run_id')
  }

  const runningStep = [...job.steps]
    .filter(item => item.key === 'agent' && item.status === 'running' && item.id)
    .sort((left, right) => right.attempt - left.attempt)[0]
  const step = runningStep?.id
    ? { id: runningStep.id, attempt: runningStep.attempt }
    : await deps.startStep(jobId, 'agent')
  let runtime: AgentRuntime | undefined
  try {
    const context = await deps.getContext(runId, jobId)
    const provisionalObjective = buildDailyCreationAgentObjective(context)
    let execution = await deps.ensureExecution(jobId, {
      objective: provisionalObjective,
      skillMode: context.rule.skill_mode,
      skillName: context.rule.skill_name ?? null,
    })
    const objective = buildDailyCreationAgentObjective({
      ...context,
      executionId: execution.id,
    })
    const recordedCalls = await deps.listToolCalls(jobId, execution.id)
    const recoveredEvidence = recordedCalls.reduce<AgentCompletionEvidence | null>(
      (found, call) => found ?? completionEvidenceFromAudit({
        toolName: call.tool_name,
        toolCallId: call.tool_call_id,
        sideEffecting: call.side_effecting ?? false,
        autoApproved: call.auto_approved ?? false,
        status: call.status === 'succeeded' ? 'succeeded' : 'failed',
        inputSummary: call.input_summary ?? {},
        output: call.output,
        error: call.error,
        occurredAt: new Date().toISOString(),
      }, {
        executionId: execution.id,
        runId,
        requestedCount: context.requested_count,
      }),
      null,
    )
    if (recoveredEvidence) {
      await deps.completeExecution(jobId, execution.id, recoveredEvidence)
      await deps.completeStep(jobId, step.id, recoveredEvidence)
      await deps.completeJob(jobId)
      return recoveredEvidence
    }
    const model = await deps.loadModel(jobId)
    const audits: AgentToolAudit[] = []
    let completionEvidence: AgentCompletionEvidence | null = null

    const checkpoint = async (
      phase: string,
      state: Record<string, unknown>,
      audit: Record<string, unknown>,
    ) => {
      execution = await deps.checkpointExecution(
        jobId, execution.id, execution.version,
        { phase, checkpoint: state, audit },
      )
    }

    runtime = await deps.openRuntime({
      apiBase: deps.apiRoot(),
      model,
      approvalPolicy: 'automatic',
      skillMode: context.rule.skill_mode,
      skillName: context.rule.skill_name ?? undefined,
      beforeToolExecute: event => deps.claimToolCall(jobId, execution.id, event),
      onToolAudit: async event => {
        audits.push(event)
        if (event.status === 'succeeded') {
          await deps.completeToolCall(
            jobId, execution.id, event.toolCallId, event.output,
          )
          completionEvidence = completionEvidenceFromAudit(event, {
            executionId: execution.id,
            runId,
            requestedCount: context.requested_count,
          }) ?? completionEvidence
        } else if (event.status === 'failed' || event.status === 'uncertain') {
          await deps.failToolCall(
            jobId, execution.id, event.toolCallId,
            event.error || 'tool execution failed',
            event.status === 'uncertain' || event.sideEffecting,
          )
        }
      },
    })

    await checkpoint('prepared', { objective }, {
      skill: runtime.snapshot(), toolCalls: audits,
    })
    const result = await runtime.run({
      objective,
      modelMessages: [{ role: 'user', content: objective }],
      selectedContext: JSON.stringify(context.rule),
      maxSteps: 30,
      requiredTools: [
        'list_creative_asset_candidates',
        'get_recent_content_usage',
        'save_daily_creation_outputs',
      ],
      onStep: event => checkpoint(event.phase, {
        objective,
        latestStep: event,
      }, {
        skill: runtime?.snapshot(),
        toolCalls: audits,
      }),
    })
    await checkpoint('finalizing', {
      objective,
      result: { kind: result.kind, text: result.text, parts: result.parts },
    }, {
      skill: runtime.snapshot(),
      skillRun: agentSkillRunAudit(result),
      toolCalls: audits,
    })

    if (!completionEvidence) {
      throw new Error('missing valid save_daily_creation_outputs evidence')
    }
    await deps.completeExecution(jobId, execution.id, completionEvidence)
    await deps.completeStep(jobId, step.id, completionEvidence)
    await deps.completeJob(jobId)
    return completionEvidence
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const deterministic = message.includes('missing valid save_daily_creation_outputs evidence')
      || message.includes('Selected skill is unavailable')
    await deps.failStep(
      jobId, step.id, error,
      deterministic ? false : retryableForError(error, true),
    )
    throw error
  } finally {
    await runtime?.close()
  }
}
