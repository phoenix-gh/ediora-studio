import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

import {
  appendAgentMessage,
  checkpointAgentExecution,
  claimAgentToolCall,
  completeAgentExecution,
  completeAgentToolCall,
  ensureAgentExecution,
  failAgentExecution,
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
import { createDirectImageGenerator, mcpUrl } from './global-chat-tools'
import type {
  AgentCompletionEvidence,
  AgentModelMessageEvent,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'
import {
  apiGet,
  apiBase,
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

export type ResponseArticleContext = {
  output: {
    id: number
    output_type: string
    status: string
    [key: string]: unknown
  }
  item: {
    id: number
    source_url?: string | null
    source_title?: string | null
    source_author?: string | null
    analysis?: Record<string, unknown> | null
    [key: string]: unknown
  }
  source?: Record<string, unknown> | null
  account?: Record<string, unknown> | null
  [key: string]: unknown
}

const responseWritingTargets: Record<string, { label: string; draftType: string }> = {
  x_short_post: { label: 'X 短帖', draftType: 'x' },
  x_article: { label: 'X Article', draftType: 'x_article' },
  wechat_article: { label: '公众号文章', draftType: 'mp' },
  expanded_article: { label: '通用文章', draftType: 'article' },
  commentary: { label: '评论文章', draftType: 'article' },
}

export function responseWritingTarget(outputType: string) {
  return responseWritingTargets[outputType] ?? {
    label: outputType || '通用文章',
    draftType: 'article',
  }
}

export function outputInstructions(outputType: string) {
  const common = '只生成可编辑草稿，不得发布，不得调用任何发布接口。保留来源归因，不编造原文没有的事实。'
  if (outputType === 'expanded_article') {
    return `${common} 输出一篇中文 Markdown 完整文章，必须交付展开后的正文段落；不得只输出提纲、要点、分析摘要或写作建议。文章包含标题、清晰结构、核心思想扩写、个人观点和来源链接。`
  }
  if (outputType === 'commentary') {
    return `${common} 输出中文 Markdown 评论文章，明确区分原作者观点与自己的个人判断，可赞同、补充或反驳。`
  }
  if (outputType === 'x_reply') {
    return `${common} 输出简洁中文 X 回复，只输出正文。`
  }
  if (outputType === 'x_quote') {
    return `${common} 输出忠实转述且有信息增量的中文 X 引用帖，只输出正文。`
  }
  return `${common} 输出适合 X 分享的中文帖子，只输出正文，突出一个价值点和自己的观点。`
}

const responseArticleToolAllowlist = [
  'web_search',
  'fetch_url',
  'get_content_directions',
  'list_drafts',
  'get_draft',
  'search_creative_assets',
  'get_creative_asset',
  'list_creative_asset_candidates',
  'get_recent_content_usage',
  'list_writing_plans',
  'get_writing_plan',
  'search_writing_plans',
  'list_publish_accounts',
  'get_account_profile',
  'loadSkill',
  'readSkillReference',
  'save_draft',
] as const

export const RESPONSE_AGENT_TOOL_ALLOWLIST = responseArticleToolAllowlist

type ObjectiveContext = ResponseArticleContext & { executionId?: number }

export function buildResponseArticleAgentObjective(
  context: ObjectiveContext,
  executionId?: number,
) {
  const item = context.item
  const responseItemId = item.id
  const source = context.source ?? {}
  const analysis = item.analysis ?? {}
  const target = responseWritingTarget(context.output.output_type)
  const fullArticleRequirement = context.output.output_type === 'expanded_article'
    ? '必须交付完整中文 Markdown 文章，而不是提纲、摘要、分析报告、写作建议或待补充模板。文章需要有明确标题、完整正文、清晰结构和有信息增量的个人判断。'
    : '必须交付该目标内容形态的完整成稿，而不是提纲、摘要、分析报告、写作建议或待补充模板。'
  const executionLine = executionId
    ? `固定执行标识：job_id 将由运行框架提供，execution_id=${executionId}，response_item_id=${responseItemId}。`
    : `固定 response_item_id=${responseItemId}；execution_id 将由运行框架提供。`

  return `你是 Ediora 情报中心的写作 Agent。你要把一条已经被人工判定为“值得写”的情报，创作成可以直接进入草稿箱的成稿。

目标内容形态：${target.label}

交付要求：${fullArticleRequirement}只能使用工作上下文中的原文和 AI评价作为事实依据，不得臆造原文没有的事实。成稿应保留来源归因和原文链接。不得发布、不得调用任何发布接口。

你可以自主判断是否使用 Skill，并应根据目标内容形态和上下文自主判断并加载相关 Skill；只有相关时才调用 loadSkill，并遵循所加载 Skill 的要求，不要把 Skill 当成完成任务的硬性前置条件。平台的篇幅、结构、语气、标题和排版由相关 Skill 决定。你可以使用允许的只读工具补充必要信息，但最终交付必须由真实的 save_draft 工具完成。

最终保存时必须只调用一次 save_draft，参数必须满足：topic_id=response:${responseItemId}、status="drafting"、draft_type="${target.draftType}"；title 是便于在草稿箱识别的标题，content 是完整成稿。不要调用不存在的 save_response_article，也不要把成稿只放在模型回复中。只有 save_draft 返回的真实草稿 id 才表示写作完成。

${executionLine}

原文（完整上下文）：
${JSON.stringify(source, null, 2)}

AI评价：
${JSON.stringify(analysis, null, 2)}

来源条目元数据：
${JSON.stringify({
    source_url: item.source_url ?? '',
    source_title: item.source_title ?? '',
    source_author: item.source_author ?? '',
  }, null, 2)}`
}

const positiveId = z.number().int().positive()
const savedDraftSchema = z.object({
  id: positiveId,
  title: z.string().trim().min(1),
  status: z.literal('drafting'),
}).passthrough()

const responseCompletionEvidenceSchema = z.object({
  toolName: z.literal('save_draft'),
  toolCallId: z.string().min(1),
  draftId: positiveId,
  responseItemId: positiveId,
})

export type ResponseArticleCompletionEvidence = {
  toolName: 'save_draft'
  toolCallId: string
  draftId: number
  responseItemId: number
}

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

export function responseArticleCompletionEvidenceFromAudit(
  event: AgentToolAudit,
  expected: { responseItemId: number },
): ResponseArticleCompletionEvidence | null {
  if (event.status !== 'succeeded' || event.toolName !== 'save_draft') return null
  const parsed = savedDraftSchema.safeParse(unwrapMcpOutput(event.output))
  if (!parsed.success) return null
  return {
    toolName: 'save_draft',
    toolCallId: event.toolCallId,
    draftId: parsed.data.id,
    responseItemId: expected.responseItemId,
  }
}

export const completionEvidenceFromAudit = responseArticleCompletionEvidenceFromAudit

type Model = OpenAgentRuntimeOptions['model']

export type ContentResponseOutputAgentJobDependencies = {
  getJob(jobId: number): Promise<DurableJob>
  getContext(outputId: number, jobId: number): Promise<ResponseArticleContext>
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
  appendMessage?(jobId: number, executionId: number, event: AgentModelMessageEvent): Promise<unknown>
  claimToolCall(
    jobId: number, executionId: number, event: AgentToolAudit,
  ): Promise<AgentToolDecision>
  listToolCalls(jobId: number, executionId: number): Promise<DurableAgentToolCall[]>
  completeToolCall(jobId: number, executionId: number, toolCallId: string, output: unknown): Promise<unknown>
  failToolCall(jobId: number, executionId: number, toolCallId: string, error: string, uncertain: boolean): Promise<unknown>
  completeExecution(jobId: number, executionId: number, evidence: AgentCompletionEvidence): Promise<unknown>
  failExecution(jobId: number, executionId: number, error: string): Promise<unknown>
  startStep(jobId: number, key: string): Promise<{ id: number; attempt: number }>
  completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
  failStep(jobId: number, stepId: number, error: unknown, retryable: boolean): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  linkDraft(jobId: number, outputId: number, draftId: number): Promise<Record<string, unknown>>
  openRuntime(options: OpenAgentRuntimeOptions): Promise<AgentRuntime>
  apiRoot(): string
}

function defaultApiRoot() {
  return apiBase()
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

const defaultDependencies: ContentResponseOutputAgentJobDependencies = {
  getJob,
  getContext: (outputId, jobId) => apiGet(
    `/responses/outputs/${outputId}/worker-context`, workerHeaders(jobId),
  ),
  loadModel: configuredModel,
  ensureExecution: ensureAgentExecution,
  checkpointExecution: checkpointAgentExecution,
  appendMessage: appendAgentMessage,
  claimToolCall: claimAgentToolCall,
  listToolCalls: listAgentToolCalls,
  completeToolCall: completeAgentToolCall,
  failToolCall: failAgentToolCall,
  completeExecution: completeAgentExecution,
  failExecution: failAgentExecution,
  startStep,
  completeStep,
  failStep,
  completeJob,
  linkDraft: (jobId, outputId, draftId) => apiPost(
    `/responses/outputs/${outputId}/worker-link`,
    { article_draft_id: draftId },
    workerHeaders(jobId),
  ),
  openRuntime: openAgentRuntime,
  apiRoot: defaultApiRoot,
}

function latestOutput(job: DurableJob, key: string) {
  return [...job.steps]
    .filter(step => step.key === key && step.status === 'succeeded')
    .sort((left, right) => right.attempt - left.attempt)[0]?.output
}

function runningStep(job: DurableJob, key: string) {
  return [...job.steps]
    .filter(step => step.key === key && step.status === 'running' && step.id)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

function completedAgentEvidence(job: DurableJob): ResponseArticleCompletionEvidence | undefined {
  const output = latestOutput(job, 'agent')
  const parsed = responseCompletionEvidenceSchema.safeParse(output)
  return parsed.success ? parsed.data : undefined
}

function auditFromPersistedToolCall(call: DurableAgentToolCall): AgentToolAudit {
  return {
    toolName: call.tool_name,
    toolCallId: call.tool_call_id,
    sideEffecting: call.side_effecting ?? true,
    autoApproved: call.auto_approved ?? true,
    status: call.status === 'succeeded' ? 'succeeded' : 'failed',
    inputSummary: call.input_summary ?? {},
    output: call.output,
    error: call.error,
    occurredAt: new Date().toISOString(),
  }
}

export async function runContentResponseOutputJob(
  jobId: number,
  deps: ContentResponseOutputAgentJobDependencies = defaultDependencies,
): Promise<Record<string, unknown> | AgentCompletionEvidence> {
  let job = await deps.getJob(jobId)
  const legacySaved = latestOutput(job, 'save_output')
  const alreadyLinked = latestOutput(job, 'link_draft')
  if (alreadyLinked) {
    if (job.status !== 'succeeded') await deps.completeJob(jobId)
    return alreadyLinked
  }
  if (job.status === 'succeeded') return legacySaved ?? { already_completed: true }
  if (legacySaved) {
    if (job.status !== 'succeeded') await deps.completeJob(jobId)
    return legacySaved
  }

  const outputId = Number(job.input.response_output_id)
  if (!Number.isSafeInteger(outputId) || outputId <= 0) {
    throw new Error('任务缺少 response_output_id')
  }

  let activeStep: { id: number; key: string } | undefined
  let execution: DurableAgentExecution | undefined
  let executionCompleted = false
  let runtime: AgentRuntime | undefined
  let evidence: ResponseArticleCompletionEvidence | undefined = completedAgentEvidence(job)

  try {
    let context = latestOutput(job, 'prepare_output_context') as ResponseArticleContext | undefined
    if (!context && !evidence) {
      const existing = runningStep(job, 'prepare_output_context')
      const started = existing?.id
        ? { id: existing.id, attempt: existing.attempt }
        : await deps.startStep(jobId, 'prepare_output_context')
      activeStep = { id: started.id, key: 'prepare_output_context' }
      context = await deps.getContext(outputId, jobId)
      await deps.completeStep(jobId, started.id, context as unknown as Record<string, unknown>)
      activeStep = undefined
      job = await deps.getJob(jobId)
    }

    if (!evidence) {
      if (!context) throw new Error('情报文章 Agent 缺少写作上下文')
      const existing = runningStep(job, 'agent')
      const started = existing?.id
        ? { id: existing.id, attempt: existing.attempt }
        : await deps.startStep(jobId, 'agent')
      activeStep = { id: started.id, key: 'agent' }
      const provisionalObjective = buildResponseArticleAgentObjective(context)
      execution = await deps.ensureExecution(jobId, {
        objective: provisionalObjective,
        skillMode: 'auto',
        skillName: null,
      })
      const currentExecution = () => {
        if (!execution) throw new Error('content response Agent execution was not initialized')
        return execution
      }
      const objective = buildResponseArticleAgentObjective(context, currentExecution().id)
      const recordedCalls = await deps.listToolCalls(jobId, currentExecution().id)
      const recoveredEvidence = recordedCalls.reduce<ResponseArticleCompletionEvidence | null>(
        (found, call) => found ?? responseArticleCompletionEvidenceFromAudit(
          auditFromPersistedToolCall(call),
          { responseItemId: context.item.id },
        ),
        null,
      )
      if (recoveredEvidence) {
        evidence = recoveredEvidence
        await deps.completeExecution(jobId, currentExecution().id, recoveredEvidence)
        executionCompleted = true
        await deps.completeStep(jobId, started.id, recoveredEvidence)
        activeStep = undefined
      } else {
        const model = await deps.loadModel(jobId)
        const audits: AgentToolAudit[] = []
        let completionEvidence: ResponseArticleCompletionEvidence | null = null
        const checkpoint = async (
          phase: string,
          state: Record<string, unknown>,
          audit: Record<string, unknown>,
        ) => {
          execution = await deps.checkpointExecution(
            jobId, currentExecution().id, currentExecution().version,
            { phase, checkpoint: state, audit },
          )
        }

        const apiRoot = deps.apiRoot()
        runtime = await deps.openRuntime({
          mcpEndpoint: mcpUrl(apiRoot),
          imageGenerator: createDirectImageGenerator(apiRoot, jobId),
          model,
          approvalPolicy: 'automatic',
          automaticSelection: false,
          skillMode: 'auto',
          allowedToolNames: RESPONSE_AGENT_TOOL_ALLOWLIST,
          beforeToolExecute: async event => {
            const decision = await deps.claimToolCall(jobId, currentExecution().id, event)
            if (event.toolName === 'save_draft' && completionEvidence) {
              return { action: 'uncertain', error: 'save_draft may only be called once' }
            }
            return decision
          },
          onMessage: async event => {
            try {
              await deps.appendMessage?.(jobId, currentExecution().id, event)
            } catch {
              // Message logging is best effort and must not fail the content task.
            }
          },
          onToolAudit: async event => {
            audits.push(event)
            if (event.status === 'succeeded') {
              await deps.completeToolCall(
                jobId, currentExecution().id, event.toolCallId, event.output,
              )
              completionEvidence = responseArticleCompletionEvidenceFromAudit(event, {
                responseItemId: context.item.id,
              }) ?? completionEvidence
            } else if (event.status === 'failed' || event.status === 'uncertain') {
              await deps.failToolCall(
                jobId, currentExecution().id, event.toolCallId,
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
          modelMessages: [{
            role: 'user',
            content: `${objective}\n\n完整工作上下文：\n${JSON.stringify(context, null, 2)}`,
          }],
          selectedContext: JSON.stringify(context),
          maxSteps: 30,
          requiredTools: ['save_draft'],
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

        if (!completionEvidence) throw new Error('missing valid save_draft evidence')
        evidence = completionEvidence
        await deps.completeExecution(jobId, currentExecution().id, completionEvidence)
        executionCompleted = true
        await deps.completeStep(jobId, started.id, completionEvidence)
        activeStep = undefined
      }
    }

    if (!evidence) throw new Error('missing valid save_draft evidence')
    job = await deps.getJob(jobId)
    const linked = latestOutput(job, 'link_draft')
    if (linked) {
      await deps.completeJob(jobId)
      return linked
    }
    const existing = runningStep(job, 'link_draft')
    const started = existing?.id
      ? { id: existing.id, attempt: existing.attempt }
      : await deps.startStep(jobId, 'link_draft')
    activeStep = { id: started.id, key: 'link_draft' }
    const linkedDraft = await deps.linkDraft(jobId, outputId, evidence.draftId)
    await deps.completeStep(jobId, started.id, linkedDraft)
    activeStep = undefined
    await deps.completeJob(jobId)
    return linkedDraft
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const deterministic = message.includes('missing valid save_draft evidence')
      || message.includes('Selected skill is unavailable')
      || message.includes('requires response_output_id')
    try {
      if (execution && !executionCompleted) await deps.failExecution(jobId, execution.id, message)
    } catch {
      // Preserve the original job failure if the auxiliary status update fails.
    }
    if (activeStep) {
      await deps.failStep(
        jobId,
        activeStep.id,
        error,
        deterministic ? false : retryableForError(error, true),
      )
    }
    throw error
  } finally {
    await runtime?.close()
  }
}
