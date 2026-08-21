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
import {
  openaiProviderFromConfig,
  textModelConfigFromSettings,
  textModelForProvider,
  type TextModelSettings,
} from './runtime-config'


const dimensionSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().min(1),
}).strict()

export const contentResponseAnalysisSchema = z.object({
  content_value_score: z.number().int().min(0).max(100),
  value_dimensions: z.object({
    novelty: dimensionSchema,
    practicality: dimensionSchema,
    credibility: dimensionSchema,
    writing_space: dimensionSchema,
    evergreen_value: dimensionSchema,
  }).strict(),
  summary_cn: z.string().min(1),
  core_thesis: z.string().min(1),
  value_points: z.array(z.string()),
  evidence: z.array(z.object({
    text: z.string().min(1),
    type: z.enum(['fact', 'source_claim', 'model_inference']),
    source: z.string().optional(),
  }).strict()),
  risks: z.array(z.string()),
  verification_items: z.array(z.string()),
  recommended_content_types: z.array(z.enum([
    'tool', 'industry_update', 'case', 'tutorial', 'research',
  ])),
  recommended_disposition: z.enum([
    'worth_writing', 'creative_asset', 'not_processed',
  ]),
  recommendation_reason: z.string().min(1),
  suggested_title: z.string().min(1),
  suggested_angle: z.string().min(1),
  target_reader: z.string().min(1),
  suggested_structure: z.array(z.string().min(1)),
}).strict()

export type ContentResponseAnalysis = z.infer<typeof contentResponseAnalysisSchema>

export function parseContentResponseAnalysis(text: string): ContentResponseAnalysis {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return contentResponseAnalysisSchema.parse(JSON.parse(json))
}

export function contentResponseContractExample(): ContentResponseAnalysis {
  return {
    content_value_score: 70,
    value_dimensions: {
      novelty: { score: 70, reason: '说明新颖性判断' },
      practicality: { score: 70, reason: '说明实用性判断' },
      credibility: { score: 70, reason: '说明可信度判断' },
      writing_space: { score: 70, reason: '说明写作空间判断' },
      evergreen_value: { score: 70, reason: '说明长期价值判断' },
    },
    summary_cn: '中文摘要',
    core_thesis: '核心思想',
    value_points: ['价值点'],
    evidence: [{
      text: '原始内容中的证据或来源说法',
      type: 'source_claim',
      source: '原始内容',
    }],
    risks: [],
    verification_items: [],
    recommended_content_types: ['research', 'tutorial'],
    recommended_disposition: 'worth_writing',
    recommendation_reason: '建议理由',
    suggested_title: '文章标题方向',
    suggested_angle: '可展开的切入角度',
    target_reader: '目标读者',
    suggested_structure: ['开篇', '论证', '结论'],
  }
}

const stepOrder = [
  'prepare_source',
  'extract_content',
  'analyze_value',
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
  const runtime = await apiGet<TextModelSettings>(
    '/settings/ai-runtime',
    workerHeaders(),
  )
  return textModelConfigFromSettings(runtime)
}

async function analyze(context: Record<string, unknown>) {
  const config = await configuredModel()
  const provider = openaiProviderFromConfig(config)
  const instructions = `你是中文内容研究与创作编辑。分析原始内容，判断它是否值得进入内容系统，不发布任何内容。
必须区分事实(fact)、来源观点(source_claim)和模型推断(model_inference)，证据必须标注类型。
即使内容价值低，也要如实输出完整分析。推荐去向只能是 worth_writing、creative_asset、not_processed。
五个价值维度固定为 novelty、practicality、credibility、writing_space、evergreen_value。
内容类型只能从 tool、industry_update、case、tutorial、research 中选择，可多选。
分析、理由、标题、角度和结构使用中文；原文专有名词可保留。只返回严格 JSON，不要 Markdown。`
  const contractExample = contentResponseContractExample()
  const prompt = JSON.stringify({
    task: '分析 source，并严格按 required_output_shape 的字段和嵌套类型返回 JSON。示例值仅用于说明合同，必须替换为真实分析。',
    required_output_shape: contractExample,
    context,
  })
  const first = await generateText({
    model: textModelForProvider(provider, config.modelName, config.protocol),
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
      model: textModelForProvider(provider, config.modelName, config.protocol),
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
      const availableSource = extracted.source as Record<string, unknown>
      if (availableSource.available === false || !String(availableSource.body ?? '').trim()) {
        throw new Error('原文正文不可用，无法进行可靠分析')
      }
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
