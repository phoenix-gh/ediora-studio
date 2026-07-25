import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { z } from 'zod'

import {
  apiGet, apiPost, completeJob, completeStep, failStep, getJob, startStep,
  type JobStep,
} from './job-client'


const CJK = /[\u3400-\u9fff]/
const stepOrder = ['qualify', 'verify_links', 'decide', 'persist', 'notify'] as const
type XResponseStep = typeof stepOrder[number]

const claimSchema = z.object({
  text: z.string(),
  source_url: z.string().default(''),
  verified: z.boolean().default(false),
})

export const xResponseDecisionSchema = z.object({
  action: z.enum(['comment', 'translate_quote', 'watch', 'ignore']),
  score: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
  summary_cn: z.string().min(1),
  comment_draft: z.string().nullable(),
  quote_draft: z.string().nullable(),
  claims: z.array(claimSchema).default([]),
}).superRefine((value, context) => {
  if (value.action === 'comment' && !value.comment_draft) {
    context.addIssue({ code: 'custom', message: 'comment_draft is required' })
  }
  if (value.action === 'translate_quote' && !value.quote_draft) {
    context.addIssue({ code: 'custom', message: 'quote_draft is required' })
  }
  const publishable = [value.comment_draft, value.quote_draft].filter(Boolean) as string[]
  if (publishable.some(draft => !CJK.test(draft))) {
    context.addIssue({ code: 'custom', message: 'Publishable drafts must contain Chinese' })
  }
  if (['watch', 'ignore'].includes(value.action) && publishable.length) {
    context.addIssue({ code: 'custom', message: 'watch/ignore cannot contain publishable drafts' })
  }
})

export type XResponseDecision = z.infer<typeof xResponseDecisionSchema>

export function parseXResponseDecisionText(text: string): XResponseDecision {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return xResponseDecisionSchema.parse(JSON.parse(json))
}

export function nextResponseStep(steps: JobStep[]): XResponseStep | null {
  const latest = new Map<string, JobStep>()
  for (const step of steps) {
    const current = latest.get(step.key)
    if (!current || step.attempt > current.attempt) latest.set(step.key, step)
  }
  return stepOrder.find(key => latest.get(key)?.status !== 'succeeded') ?? null
}

export function nextDigestStep(steps: JobStep[]): 'notify' | null {
  return steps.some(step => step.key === 'notify' && step.status === 'succeeded')
    ? null
    : 'notify'
}

function succeededOutput(job: Awaited<ReturnType<typeof getJob>>, key: XResponseStep) {
  return [...job.steps]
    .filter(step => step.key === key && step.status === 'succeeded')
    .sort((a, b) => b.attempt - a.attempt)[0]?.output
}

async function configuredModel() {
  const response = await apiGet<{ api_key: string; model: string; base_url: string }>('/settings/ai-runtime')
  const apiKey = response.api_key || process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('No LLM API key is configured')
  return {
    apiKey,
    modelName: response.model || process.env.WMS_LLM_MODEL || 'gpt-4o-mini',
    baseURL: response.base_url || process.env.WMS_LLM_BASE_URL || undefined,
  }
}

async function decide(context: unknown, verification: unknown) {
  const modelConfig = await configuredModel()
  const provider = createOpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL })
  const instructions = `你是中文科技账号的即时响应编辑。只能判断并起草，绝不能发布内容。
主要动作只能是 comment、translate_quote、watch、ignore。
comment 和 translate_quote 的可发布草稿必须使用中文，产品名、模型名、API 名保留英文。
翻译引用稿必须忠实转述证据，不得加入来源没有的结论。watch 和 ignore 不得带草稿。
只返回合法 JSON：action、score(0-100)、confidence(0-1)、reason、summary_cn、comment_draft、quote_draft、claims。`
  const prompt = JSON.stringify({ context, verification })
  const first = await generateText({ model: provider.chat(modelConfig.modelName), instructions, prompt })
  try {
    return {
      decision: parseXResponseDecisionText(first.text),
      model_provider: 'openai-compatible',
      model_name: modelConfig.modelName,
    }
  } catch (error) {
    const repair = await generateText({
      model: provider.chat(modelConfig.modelName),
      instructions,
      prompt: `修复以下 JSON，使其严格满足合同。错误：${String(error)}\n原始输出：${first.text}`,
    })
    return {
      decision: parseXResponseDecisionText(repair.text),
      model_provider: 'openai-compatible',
      model_name: modelConfig.modelName,
    }
  }
}

export async function runXResponseJob(jobId: number) {
  let job = await getJob(jobId)
  if (job.status === 'succeeded' || nextResponseStep(job.steps) === null) {
    return succeededOutput(job, 'persist') ?? { already_completed: true }
  }
  let activeStep: { id: number } | undefined
  try {
    let context = succeededOutput(job, 'qualify')
    if (!context) {
      activeStep = await startStep(job.id, 'qualify')
      context = await apiGet<Record<string, unknown>>(`/x/responses/internal/${String(job.input.tweet_id)}/context`)
      await completeStep(job.id, activeStep.id, context)
      activeStep = undefined
      if (context.eligible !== true) {
        await completeJob(job.id)
        return context
      }
      job = await getJob(job.id)
    } else if (context.eligible !== true) {
      await completeJob(job.id)
      return context
    }

    let verification = succeededOutput(job, 'verify_links')
    if (!verification) {
      activeStep = await startStep(job.id, 'verify_links')
      verification = await apiPost<Record<string, unknown>>(`/x/responses/internal/${String(job.input.tweet_id)}/verify-links`)
      await completeStep(job.id, activeStep.id, verification)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let decisionOutput = succeededOutput(job, 'decide')
    if (!decisionOutput) {
      activeStep = await startStep(job.id, 'decide')
      decisionOutput = await decide(context, verification)
      await completeStep(job.id, activeStep.id, decisionOutput)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let persisted = succeededOutput(job, 'persist')
    if (!persisted) {
      activeStep = await startStep(job.id, 'persist')
      const modelDecision = decisionOutput as { decision: XResponseDecision; model_provider: string; model_name: string }
      persisted = await apiPost<Record<string, unknown>>(
        `/x/responses/internal/${String(job.input.tweet_id)}/decision`,
        {
          ...modelDecision.decision,
          verification_status: verification.verification_status ?? 'not_required',
          verified_urls: verification.links ?? [],
          model_provider: modelDecision.model_provider,
          model_name: modelDecision.model_name,
          prompt_version: 'x-response-prompt-v1',
        },
      )
      await completeStep(job.id, activeStep.id, persisted)
      activeStep = undefined
      job = await getJob(job.id)
    }

    let notified = succeededOutput(job, 'notify')
    if (!notified) {
      activeStep = await startStep(job.id, 'notify')
      notified = persisted.notification_tier === 'immediate'
        ? await apiPost<Record<string, unknown>>(`/x/responses/${String(persisted.id)}/notify`)
        : { skipped: true, tier: persisted.notification_tier }
      await completeStep(job.id, activeStep.id, notified)
      activeStep = undefined
    }
    await completeJob(job.id)
    return persisted
  } catch (error) {
    if (activeStep) await failStep(job.id, activeStep.id, error, true)
    throw error
  }
}

export async function runXResponseDigestJob(jobId: number) {
  const job = await getJob(jobId)
  if (job.status === 'succeeded' || nextDigestStep(job.steps) === null) {
    return succeededOutput(job, 'notify') ?? { already_completed: true }
  }
  const step = await startStep(job.id, 'notify')
  try {
    const output = await apiPost<Record<string, unknown>>('/x/responses/digest/send', job.input)
    await completeStep(job.id, step.id, output)
    await completeJob(job.id)
    return output
  } catch (error) {
    await failStep(job.id, step.id, error, true)
    throw error
  }
}
