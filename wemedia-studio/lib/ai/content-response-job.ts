import { createOpenAI } from '@ai-sdk/openai'
import { generateText, Output } from 'ai'
import { z } from 'zod'

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
  type JobStep,
} from './job-client'


const dimensionSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().min(1),
})

const accountScoreSchema = z.object({
  publish_account_id: z.string().min(1),
  score: z.number().int().min(0).max(100),
  rank: z.number().int().min(1),
  fit_reasons: z.array(z.string()),
  audience_value: z.string(),
  recommended_tone: z.string(),
  recommended_output_types: z.array(z.enum([
    'expanded_article', 'commentary', 'x_share', 'x_reply', 'x_quote',
  ])),
  taboo_risks: z.array(z.string()),
  has_hard_conflict: z.boolean(),
})

export const contentResponseAnalysisSchema = z.object({
  content_value_score: z.number().int().min(0).max(100),
  value_dimensions: z.object({
    novelty: dimensionSchema,
    practicality: dimensionSchema,
    credibility: dimensionSchema,
    discussion_value: dimensionSchema,
    evergreen_value: dimensionSchema,
  }),
  summary_cn: z.string().min(1),
  core_thesis: z.string().min(1),
  key_points: z.array(z.string()),
  evidence: z.array(z.object({
    text: z.string().min(1),
    type: z.enum(['fact', 'source_claim', 'model_inference']),
    source: z.string().optional(),
  })),
  value_points: z.array(z.string()),
  risks: z.array(z.string()),
  verification_items: z.array(z.string()),
  personal_angles: z.array(z.string()),
  article_outlines: z.array(z.object({
    title: z.string(),
    sections: z.array(z.string()),
  })),
  comment_angles: z.array(z.string()),
  recommended_output_types: z.array(z.enum([
    'expanded_article', 'commentary', 'x_share', 'x_reply', 'x_quote',
  ])),
  recommended_action: z.string(),
  recommendation_reason: z.string().min(1),
  recommended_publish_account_id: z.string().nullable(),
  account_scores: z.array(accountScoreSchema),
}).superRefine((value, context) => {
  const ids = new Set(value.account_scores.map(score => score.publish_account_id))
  if (ids.size !== value.account_scores.length) {
    context.addIssue({ code: 'custom', message: 'duplicate account score' })
  }
  const recommended = value.account_scores.find(
    score => score.publish_account_id === value.recommended_publish_account_id,
  )
  if (recommended?.has_hard_conflict) {
    context.addIssue({ code: 'custom', message: 'recommended account has hard conflict' })
  }
  if (value.recommended_publish_account_id && !recommended) {
    context.addIssue({ code: 'custom', message: 'recommended account is not scored' })
  }
})

export type ContentResponseAnalysis = z.infer<typeof contentResponseAnalysisSchema>

export function parseContentResponseAnalysis(text: string): ContentResponseAnalysis {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return contentResponseAnalysisSchema.parse(JSON.parse(json))
}

export function contentResponseContractExample(
  accountIds: string[],
): ContentResponseAnalysis {
  return {
    content_value_score: 70,
    value_dimensions: {
      novelty: { score: 70, reason: '说明新颖性判断' },
      practicality: { score: 70, reason: '说明实用性判断' },
      credibility: { score: 70, reason: '说明可信度判断' },
      discussion_value: { score: 70, reason: '说明讨论价值判断' },
      evergreen_value: { score: 70, reason: '说明长期价值判断' },
    },
    summary_cn: '中文摘要',
    core_thesis: '核心思想',
    key_points: ['关键观点'],
    evidence: [{
      text: '原始内容中的证据或来源说法',
      type: 'source_claim',
      source: '原始内容',
    }],
    value_points: ['价值点'],
    risks: [],
    verification_items: [],
    personal_angles: ['可加入的个人角度'],
    article_outlines: [{
      title: '文章标题方向',
      sections: ['开篇', '论证', '结论'],
    }],
    comment_angles: ['评论角度'],
    recommended_output_types: ['expanded_article'],
    recommended_action: '建议动作',
    recommendation_reason: '建议理由',
    recommended_publish_account_id: null,
    account_scores: accountIds.map((publishAccountId, index) => ({
      publish_account_id: publishAccountId,
      score: 70,
      rank: index + 1,
      fit_reasons: ['适配理由'],
      audience_value: '对该账号受众的价值',
      recommended_tone: '建议语气',
      recommended_output_types: ['expanded_article'],
      taboo_risks: [],
      has_hard_conflict: false,
    })),
  }
}

const stepOrder = [
  'prepare_source',
  'extract_content',
  'analyze_value',
  'score_accounts',
  'persist_response',
] as const
type AnalysisStep = typeof stepOrder[number]

function nextStep(steps: JobStep[]): AnalysisStep | null {
  const latest = new Map<string, JobStep>()
  for (const step of steps) {
    const current = latest.get(step.key)
    if (!current || step.attempt > current.attempt) latest.set(step.key, step)
  }
  return stepOrder.find(step => latest.get(step)?.status !== 'succeeded') ?? null
}

function succeededOutput(
  job: Awaited<ReturnType<typeof getJob>>,
  key: AnalysisStep,
) {
  return [...job.steps]
    .filter(step => step.key === key && step.status === 'succeeded')
    .sort((a, b) => b.attempt - a.attempt)[0]?.output
}

async function configuredModel() {
  const runtime = await apiGet<{ api_key: string; model: string; base_url: string }>(
    '/settings/ai-runtime',
    workerHeaders(),
  )
  const apiKey = runtime.api_key || process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('请先配置 AI 大模型 API Key')
  return {
    apiKey,
    modelName: runtime.model || process.env.WMS_LLM_MODEL || 'gpt-4o-mini',
    baseURL: runtime.base_url || process.env.WMS_LLM_BASE_URL || undefined,
  }
}

async function analyze(context: Record<string, unknown>) {
  const config = await configuredModel()
  const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  const instructions = `你是中文内容研究与创作编辑。分析原始内容，不发布任何内容。
必须区分事实(fact)、来源观点(source_claim)和模型推断(model_inference)。
内容价值与账号适配必须分开打分。即使内容价值低，也要如实输出完整分析。
必须给 accounts 中每个启用账号一条 account_scores；硬禁区冲突时 has_hard_conflict=true，不能推荐该账号。
五个价值维度固定为 novelty、practicality、credibility、discussion_value、evergreen_value。
分析、理由、建议使用中文；原文专有名词可保留。只返回严格 JSON，不要 Markdown。`
  const accountIds = Array.isArray(context.accounts)
    ? context.accounts
      .map(account => (
        account && typeof account === 'object' && 'id' in account
          ? String(account.id)
          : ''
      ))
      .filter(Boolean)
    : []
  const contractExample = contentResponseContractExample(accountIds)
  const prompt = JSON.stringify({
    task: '分析 source，并严格按 required_output_shape 的字段和嵌套类型返回 JSON。示例值仅用于说明合同，必须替换为真实分析。',
    required_output_shape: contractExample,
    context,
  })
  const first = await generateText({
    model: provider.chat(config.modelName),
    instructions,
    output: Output.json(),
    prompt,
  })
  try {
    return {
      analysis: contentResponseAnalysisSchema.parse(first.output),
      model_provider: 'openai-compatible',
      model_name: config.modelName,
      prompt_version: 'content-response-v1',
      policy_version: 'content-response-policy-v1',
    }
  } catch (error) {
    const repair = await generateText({
      model: provider.chat(config.modelName),
      instructions,
      output: Output.json(),
      prompt: JSON.stringify({
        task: '修复 invalid_output，使其严格满足 required_output_shape 的字段和嵌套类型。不得增加原始内容没有的事实，只返回 JSON。',
        validation_error: String(error),
        required_output_shape: contractExample,
        invalid_output: first.output,
        context,
      }),
    })
    return {
      analysis: contentResponseAnalysisSchema.parse(repair.output),
      model_provider: 'openai-compatible',
      model_name: config.modelName,
      prompt_version: 'content-response-v1',
      policy_version: 'content-response-policy-v1',
    }
  }
}

export async function runContentResponseAnalysisJob(jobId: number) {
  let job = await getJob(jobId)
  if (job.status === 'succeeded' || nextStep(job.steps) === null) {
    return succeededOutput(job, 'persist_response') ?? { already_completed: true }
  }
  let activeStep: { id: number } | undefined
  try {
    const itemId = Number(job.input.response_item_id)
    const analysisRunId = Number(job.input.analysis_run_id)
    if (!Number.isSafeInteger(itemId) || !Number.isSafeInteger(analysisRunId)) {
      throw new Error('任务缺少 response_item_id 或 analysis_run_id')
    }

    let context = succeededOutput(job, 'prepare_source')
    if (!context) {
      activeStep = await startStep(job.id, 'prepare_source')
      context = await apiGet<Record<string, unknown>>(
        `/responses/${itemId}/worker-context`,
        workerHeaders(job.id),
      )
      await completeStep(job.id, activeStep.id, context)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let extracted = succeededOutput(job, 'extract_content')
    if (!extracted) {
      activeStep = await startStep(job.id, 'extract_content')
      const item = context.item as Record<string, unknown>
      const source = context.source as Record<string, unknown>
      if (
        item.source_type === 'youtube_video'
        && source.transcript_status !== 'ready'
      ) {
        await apiPost(
          `/youtube/videos/${String(item.source_id)}/extract-transcript`,
          undefined,
          workerHeaders(job.id),
        )
        context = await apiGet<Record<string, unknown>>(
          `/responses/${itemId}/worker-context`,
          workerHeaders(job.id),
        )
      }
      extracted = context
      await completeStep(job.id, activeStep.id, extracted)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let analysisOutput = succeededOutput(job, 'analyze_value')
    if (!analysisOutput) {
      activeStep = await startStep(job.id, 'analyze_value')
      analysisOutput = await analyze(extracted)
      await completeStep(job.id, activeStep.id, analysisOutput)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let accountOutput = succeededOutput(job, 'score_accounts')
    if (!accountOutput) {
      activeStep = await startStep(job.id, 'score_accounts')
      const parsed = analysisOutput as {
        analysis: ContentResponseAnalysis
      }
      const accounts = (extracted.accounts ?? []) as Array<{ id: string }>
      const supplied = new Set(parsed.analysis.account_scores.map(score => score.publish_account_id))
      if (accounts.some(account => !supplied.has(account.id)) || supplied.size !== accounts.length) {
        throw new Error('AI 账号评分未覆盖全部启用账号')
      }
      accountOutput = { account_scores: parsed.analysis.account_scores }
      await completeStep(job.id, activeStep.id, accountOutput)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let persisted = succeededOutput(job, 'persist_response')
    if (!persisted) {
      activeStep = await startStep(job.id, 'persist_response')
      const output = analysisOutput as {
        analysis: ContentResponseAnalysis
        model_provider: string
        model_name: string
        prompt_version: string
        policy_version: string
      }
      const source = extracted.source as Record<string, unknown>
      persisted = await apiPost<Record<string, unknown>>(
        `/responses/${itemId}/worker-analysis`,
        {
          analysis: output.analysis,
          metadata: {
            analysis_run_id: analysisRunId,
            source_content_hash: source.transcript_content_hash ?? '',
            source_snapshot: source,
            model_provider: output.model_provider,
            model_name: output.model_name,
            prompt_version: output.prompt_version,
            policy_version: output.policy_version,
          },
        },
        workerHeaders(job.id),
      )
      await completeStep(job.id, activeStep.id, persisted)
      activeStep = undefined
    }
    await completeJob(job.id)
    return persisted
  } catch (error) {
    if (activeStep) {
      await failStep(job.id, activeStep.id, error, retryableForError(error))
    }
    throw error
  }
}
