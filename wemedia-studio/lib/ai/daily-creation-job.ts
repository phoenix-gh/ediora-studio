import { createMCPClient } from '@ai-sdk/mcp'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

import {
  dailyCreationSelectionSchema,
  dailyCreationValidationSchema,
  validateDailyCreationSelection,
  validateXPostBatch,
  xPostBatchSchema,
} from './content-job'
import {
  apiGet,
  apiPost,
  completeJob,
  completeStep,
  failStep,
  getJob,
  startStep,
  workerHeaders,
  type DurableJob,
} from './job-client'

type RunContext = {
  id: number
  status: string
  requested_count: number
  rule: {
    name: string
    asset_type: 'article' | 'media'
    directory: string
    output_type: 'x_short_post'
    target_count: number
    lookback_days: number
    account_id?: string | null
    instructions?: string
  }
}

type Candidate = { id: number; title: string; summary: string; tags: string[]; source_url: string; created_at: string; content_length: number }
type Usage = { id: number; asset_id: number; rule_name: string; topic: string; angle: string; excerpt: string; reuse_decision: string; reuse_explanation: string; created_at: string }

const creationSteps = ['loadCandidates', 'loadUsage', 'select', 'generate', 'validate', 'persist'] as const
export const dailyCreationStepKeys = [...creationSteps]

function apiRoot() {
  return (process.env.WMS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/api\/?$/, '')
}

function parseJson(text: string) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as unknown
}

function mcpValue(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const value = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> }
    if (value.structuredContent !== undefined) {
      const structured = value.structuredContent as { result?: unknown }
      return structured && typeof structured === 'object' && 'result' in structured ? structured.result : structured
    }
    const text = value.content?.find(item => item.type === 'text')?.text
    if (text) return parseJson(text)
  }
  return result
}

async function modelConfig() {
  try {
    const settings = await apiGet<{ api_key: string; model: string; base_url: string }>('/settings/ai-runtime', workerHeaders())
    if (settings.api_key) return { apiKey: settings.api_key, model: settings.model || 'gpt-4o-mini', baseURL: settings.base_url || undefined }
  } catch {
    // Environment configuration remains the disconnected-development fallback.
  }
  const apiKey = process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('No LLM API key is configured')
  return { apiKey, model: process.env.WMS_LLM_MODEL ?? 'gpt-4o-mini', baseURL: process.env.WMS_LLM_BASE_URL }
}

async function runRecordedStep<T extends Record<string, unknown>>(
  job: DurableJob,
  key: string,
  execute: () => Promise<T>,
) {
  const completed = job.steps.find(step => step.key === key && step.status === 'succeeded')
  if (completed) return completed.output as T
  const step = await startStep(job.id, key)
  try {
    const output = await execute()
    await completeStep(job.id, step.id, output)
    return output
  } catch (error) {
    await failStep(job.id, step.id, error, true)
    throw error
  }
}

export async function runDailyCreationJob(jobId: number) {
  const job = await getJob(jobId)
  if (job.status === 'succeeded' || job.status === 'cancelled') return
  const runId = Number(job.input.run_id)
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('daily_creation flow requires run_id')
  const context = await apiGet<RunContext>(`/daily-plan/creation-runs/${runId}/context`, workerHeaders())
  const config = await modelConfig()
  const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  const model = provider.chat(config.model)
  const client = await createMCPClient({ transport: { type: 'http', url: new URL('/mcp', apiRoot()).toString() } })
  try {
    const candidatesOutput = await runRecordedStep(job, 'loadCandidates', async () => {
      const result = await client.callTool({ name: 'list_creative_asset_candidates', arguments: {
        asset_type: context.rule.asset_type, directory: context.rule.directory,
        query: '', limit: Math.min(50, Math.max(context.requested_count * 5, context.requested_count)),
      } })
      return { candidates: mcpValue(result) as Candidate[] }
    })
    const usageOutput = await runRecordedStep(job, 'loadUsage', async () => {
      const result = await client.callTool({ name: 'get_recent_content_usage', arguments: {
        lookback_days: context.rule.lookback_days,
        output_type: context.rule.output_type, limit: 100,
      } })
      return { usage: mcpValue(result) as Usage[] }
    })
    const candidates = candidatesOutput.candidates as Candidate[]
    const usage = usageOutput.usage as Usage[]
    const selectionOutput = await runRecordedStep(job, 'select', async () => {
      const result = await generateText({
        model,
        instructions: '你负责通用内容选材和语义去重。只能引用给定候选和历史 ID。已使用素材只有在角度实质不同并说明差异时才可复用。候选不足就少选，不得凑数。只返回 JSON。',
        prompt: JSON.stringify({ requested_count: context.requested_count, rule: context.rule, candidates, recent_global_usage: usage }),
      })
      const selection = validateDailyCreationSelection(
        dailyCreationSelectionSchema.parse(parseJson(result.text)),
        candidates.map(item => item.id), usage.map(item => item.id),
      )
      return { selection }
    })
    const selection = dailyCreationSelectionSchema.parse(selectionOutput.selection)
    const selectedAssets: Array<{ selection: typeof selection.selected[number]; asset: unknown }> = []
    for (const selected of selection.selected.slice(0, context.requested_count)) {
      const result = await client.callTool({ name: 'get_creative_asset', arguments: { asset_id: selected.asset_id } })
      selectedAssets.push({ selection: selected, asset: mcpValue(result) })
    }
    const generatedOutput = await runRecordedStep(job, 'generate', async () => {
      const result = await generateText({
        model,
        instructions: '把素材改写为彼此独立的中文 X 短帖，不写线程，不虚构亲身经历、客户或收益。只返回 JSON 数组。',
        prompt: JSON.stringify({ rule: context.rule, selected_assets: selectedAssets }),
      })
      const generated = xPostBatchSchema.parse(parseJson(result.text))
      const selectedIds = new Set(selection.selected.map(item => item.asset_id))
      for (const post of generated) {
        if (!selectedIds.has(post.asset_id)) throw new Error(`invented asset id: ${post.asset_id}`)
      }
      return { posts: generated }
    })
    let posts = xPostBatchSchema.parse(generatedOutput.posts)
    const validationOutput = await runRecordedStep(job, 'validate', async () => {
      const deterministic = validateXPostBatch(posts)
      const result = await generateText({
        model,
        instructions: '比较候选短帖彼此之间及近期全局历史的语义重复。接受安全且角度清晰的条目，只返回 JSON。',
        prompt: JSON.stringify({ posts, recent_global_usage: usage, deterministic_issues: deterministic }),
      })
      const validation = dailyCreationValidationSchema.parse(parseJson(result.text))
      const rejected = [...deterministic, ...validation.rejected]
      let finalRejected = rejected
      if (rejected.length) {
        const revision = await generateText({
          model,
          instructions: '只修订被拒绝条目一次；无法安全修订就省略。返回完整 JSON 数组。',
          prompt: JSON.stringify({ posts, rejected, recent_global_usage: usage }),
        })
        posts = xPostBatchSchema.parse(parseJson(revision.text))
        const secondPass = await generateText({
          model,
          instructions: '这是唯一一次修订后的最终复核。比较条目彼此及近期历史，只返回 JSON；仍重复或不可信的条目必须拒绝。',
          prompt: JSON.stringify({ posts, recent_global_usage: usage }),
        })
        const secondValidation = dailyCreationValidationSchema.parse(parseJson(secondPass.text))
        finalRejected = secondValidation.rejected
      }
      const finalIssues = validateXPostBatch(posts)
      const rejectedIndexes = new Set([...finalRejected, ...finalIssues].map(issue => issue.index))
      return { posts: posts.filter((_post, index) => !rejectedIndexes.has(index)), rejected: [...rejected, ...finalRejected, ...finalIssues] }
    })
    const accepted = xPostBatchSchema.parse(validationOutput.posts)
    const persistedOutput = await runRecordedStep(job, 'persist', async () => {
      const outputs: unknown[] = []
      for (const post of accepted) {
        outputs.push(await apiPost(`/daily-plan/creation-runs/${runId}/outputs`, post, workerHeaders()))
      }
      const createdCount = outputs.length
      const status = createdCount === 0 ? 'failed' : createdCount < context.requested_count ? 'partial' : 'succeeded'
      await apiPost(`/daily-plan/creation-runs/${runId}/complete`, {
        status, created_count: createdCount,
        detail: { excluded: selection.excluded, rejected: validationOutput.rejected },
      }, workerHeaders())
      return { created_count: createdCount, outputs }
    })
    await completeJob(job.id)
    return persistedOutput
  } finally {
    await client.close()
  }
}
