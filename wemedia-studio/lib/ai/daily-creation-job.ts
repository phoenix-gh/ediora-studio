import { createMCPClient } from '@ai-sdk/mcp'
import { createOpenAI } from '@ai-sdk/openai'
import { generateObject, generateText } from 'ai'
import { z, type ZodType } from 'zod'

import {
  dailyCreationSelectionSchema,
  dailyCreationValidationSchema,
  parseDailyCreationSelection,
  parseDailyCreationValidation,
  parseXPostBatch,
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
    directory?: string
    directories?: string[]
    output_type: 'x_short_post'
    target_count: number
    lookback_days: number
    account_id?: string | null
    instructions?: string
  }
}

type Candidate = { id: number; title: string; summary: string; tags: string[]; source_url: string; created_at: string; content_length: number }
type Usage = { id: number; asset_id: number; rule_name: string; topic: string; angle: string; excerpt: string; reuse_decision: string; reuse_explanation: string; created_at: string }

export function normalizeRunDirectories(rule: { directories?: string[]; directory?: string }) {
  const values = rule.directories?.length ? rule.directories : rule.directory ? [rule.directory] : []
  const directories = [...new Set(values.map(value => value.trim()).filter(Boolean))]
  if (directories.length === 0) throw new Error('at least one directory is required for daily creation')
  return directories
}

type DailyCreationSelectionPromptInput = {
  requested_count: number
  rule: unknown
  candidates: unknown[]
  recent_global_usage: unknown[]
}

export function buildDailyCreationSelectionPrompt(input: DailyCreationSelectionPromptInput) {
  return JSON.stringify({
    output_rules: [
      '只返回一个 JSON 对象，不要 Markdown 或解释。',
      '顶层只能包含 selected 和 excluded，禁止使用任何别名。',
      'selected 和 excluded 必须始终返回数组；没有排除项时 excluded 返回空数组。',
      '所有 ID 必须来自给定候选或历史用量。',
    ],
    output_schema: z.toJSONSchema(dailyCreationSelectionSchema),
    ...input,
  })
}

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

async function generateJson<T>(options: { model: Parameters<typeof generateText>[0]['model']; schema: ZodType<T>; system: string; prompt: string }): Promise<unknown> {
  try {
    const result = await generateObject(options)
    return result.object
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('response_format')) throw error
    const result = await generateText({ model: options.model, system: `${options.system}\n只返回有效 JSON，不要 Markdown 代码块或解释。`, prompt: options.prompt })
    return parseJson(result.text)
  }
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
  const directories = normalizeRunDirectories(context.rule)
  const config = await modelConfig()
  const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  const model = provider.chat(config.model)
  const client = await createMCPClient({ transport: { type: 'http', url: new URL('/mcp', apiRoot()).toString() } })
  try {
    const candidatesOutput = await runRecordedStep(job, 'loadCandidates', async () => {
      const result = await client.callTool({ name: 'list_creative_asset_candidates', arguments: {
        asset_type: context.rule.asset_type, directories,
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
      const result = await generateJson({
        model,
        schema: dailyCreationSelectionSchema,
        system: '严格按照 prompt 中的 output_schema 和 output_rules 完成通用内容选材与语义去重。字段名、层级和类型必须完全一致。已使用素材只有在角度实质不同并说明差异时才可复用；候选不足就少选，不得凑数。',
        prompt: buildDailyCreationSelectionPrompt({
          requested_count: context.requested_count,
          rule: context.rule,
          candidates,
          recent_global_usage: usage,
        }),
      })
      const selection = validateDailyCreationSelection(
        parseDailyCreationSelection(result),
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
      const result = await generateJson({
        model,
        schema: xPostBatchSchema,
        system: '把素材改写为彼此独立的中文 X 短帖，不写线程，不虚构亲身经历、客户或收益。每项必须包含 asset_id、title、text、topic、angle、reuse_decision、reuse_explanation。',
        prompt: JSON.stringify({ rule: context.rule, selected_assets: selectedAssets }),
      })
      const generated = parseXPostBatch(result, selection.selected)
      const selectedIds = new Set(selection.selected.map(item => item.asset_id))
      for (const post of generated) {
        if (!selectedIds.has(post.asset_id)) throw new Error(`invented asset id: ${post.asset_id}`)
      }
      return { posts: generated }
    })
    let posts = xPostBatchSchema.parse(generatedOutput.posts)
    const validationOutput = await runRecordedStep(job, 'validate', async () => {
      const deterministic = validateXPostBatch(posts)
      const result = await generateJson({
        model,
        schema: dailyCreationValidationSchema,
        system: '比较候选短帖彼此之间及近期全局历史的语义重复。接受安全且角度清晰的条目。返回 accepted_indices 数组和 rejected 数组；rejected 每项只含 index 与 reason。',
        prompt: JSON.stringify({ posts, recent_global_usage: usage, deterministic_issues: deterministic }),
      })
      const validation = parseDailyCreationValidation(result, posts.length)
      const rejected = [...deterministic, ...validation.rejected]
      let finalRejected = rejected
      if (rejected.length) {
        const revision = await generateJson({
          model,
          schema: xPostBatchSchema,
          system: '只修订被拒绝条目一次；无法安全修订就省略。',
          prompt: JSON.stringify({ posts, rejected, recent_global_usage: usage }),
        })
        posts = parseXPostBatch(revision, selection.selected)
        const secondPass = await generateJson({
          model,
          schema: dailyCreationValidationSchema,
          system: '这是唯一一次修订后的最终复核。比较条目彼此及近期历史；仍重复或不可信的条目必须拒绝。返回 accepted_indices 数组和 rejected 数组；rejected 每项只含 index 与 reason。',
          prompt: JSON.stringify({ posts, recent_global_usage: usage }),
        })
        const secondValidation = parseDailyCreationValidation(secondPass, posts.length)
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
