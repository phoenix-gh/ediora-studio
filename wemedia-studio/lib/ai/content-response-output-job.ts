import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

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


const stepOrder = ['prepare_output_context', 'generate_output', 'save_output'] as const
type OutputStep = typeof stepOrder[number]

export function outputInstructions(outputType: string) {
  const common = '只生成可编辑草稿，不得发布，不得调用任何发布接口。保留来源归因，不编造原文没有的事实。'
  if (outputType === 'expanded_article') {
    return `${common} 输出一篇中文 Markdown 长文，包含标题、清晰结构、核心思想扩写、个人观点和来源链接。`
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

function latestOutput(job: Awaited<ReturnType<typeof getJob>>, key: OutputStep) {
  return [...job.steps]
    .filter(step => step.key === key && step.status === 'succeeded')
    .sort((a, b) => b.attempt - a.attempt)[0]?.output
}

function nextStep(steps: JobStep[]): OutputStep | null {
  const latest = new Map<string, JobStep>()
  for (const step of steps) {
    const current = latest.get(step.key)
    if (!current || step.attempt > current.attempt) latest.set(step.key, step)
  }
  return stepOrder.find(step => latest.get(step)?.status !== 'succeeded') ?? null
}

async function generate(context: Record<string, unknown>) {
  const runtime = await apiGet<{ api_key: string; model: string; base_url: string }>(
    '/settings/ai-runtime',
    workerHeaders(),
  )
  const apiKey = runtime.api_key || process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('请先配置 AI 大模型 API Key')
  const provider = createOpenAI({
    apiKey,
    baseURL: runtime.base_url || process.env.WMS_LLM_BASE_URL || undefined,
  })
  const output = context.output as { output_type: string }
  const result = await generateText({
    model: provider.chat(runtime.model || process.env.WMS_LLM_MODEL || 'gpt-4o-mini'),
    instructions: outputInstructions(output.output_type),
    prompt: JSON.stringify(context),
  })
  const content = result.text.trim()
  if (!content) throw new Error('AI 没有生成内容')
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''
  return { title, content }
}

export async function runContentResponseOutputJob(jobId: number) {
  let job = await getJob(jobId)
  if (job.status === 'succeeded' || nextStep(job.steps) === null) {
    return latestOutput(job, 'save_output') ?? { already_completed: true }
  }
  let activeStep: { id: number } | undefined
  try {
    const outputId = Number(job.input.response_output_id)
    if (!Number.isSafeInteger(outputId)) throw new Error('任务缺少 response_output_id')

    let context = latestOutput(job, 'prepare_output_context')
    if (!context) {
      activeStep = await startStep(job.id, 'prepare_output_context')
      context = await apiGet<Record<string, unknown>>(
        `/responses/outputs/${outputId}/worker-context`,
        workerHeaders(job.id),
      )
      await completeStep(job.id, activeStep.id, context)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let generated = latestOutput(job, 'generate_output')
    if (!generated) {
      activeStep = await startStep(job.id, 'generate_output')
      generated = await generate(context)
      await completeStep(job.id, activeStep.id, generated)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let saved = latestOutput(job, 'save_output')
    if (!saved) {
      activeStep = await startStep(job.id, 'save_output')
      const item = context.item as { source_url?: string; source_title?: string }
      saved = await apiPost<Record<string, unknown>>(
        `/responses/outputs/${outputId}/worker-result`,
        {
          ...generated,
          source_attribution: {
            url: item.source_url ?? '',
            title: item.source_title ?? '',
          },
        },
        workerHeaders(job.id),
      )
      await completeStep(job.id, activeStep.id, saved)
      activeStep = undefined
    }
    await completeJob(job.id)
    return saved
  } catch (error) {
    if (activeStep) {
      await failStep(job.id, activeStep.id, error, retryableForError(error))
    }
    throw error
  }
}
