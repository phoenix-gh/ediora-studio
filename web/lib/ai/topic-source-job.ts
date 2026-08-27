import { generateText } from 'ai'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  appendAgentMessage,
  completeAgentExecution,
  ensureAgentExecution,
  failAgentExecution,
  type DurableAgentExecution,
} from './agent-execution-client'
import type { AgentModelMessageEvent } from './agent-runtime-types'

import {
  apiGet, apiPost, completeJob, completeStep, failStep, getJob,
  retryableForError, startStep, workerHeaders,
} from './job-client'
import {
  openaiProviderFromConfig,
  textModelConfigFromSettings,
  textModelForProvider,
  type TextModelSettings,
} from './runtime-config'

const decisionSchema = z.object({
  accepted_tweet_ids: z.array(z.string()),
})

const classificationSchema = z.object({
  classifications: z.array(z.object({
    tweet_id: z.string(),
    directory_id: z.number().int().positive().nullable(),
  })),
})

const promptAssetSchema = z.object({
  tweet_id: z.string(),
  directory_id: z.number().int().positive(),
  prompt_kind: z.enum(['image', 'video', 'other']),
  title: z.string().default(''),
  content: z.string().refine(value => value.trim().length > 0, {
    message: 'Prompt content must not be empty',
  }),
  media_indexes: z.array(z.number().int().nonnegative()).default([]),
})

const evaluationSchema = classificationSchema.extend({
  prompt_assets: z.array(promptAssetSchema).default([]),
})

type TopicCandidate = {
  tweet_id: string
  content: string
  url: string
  media: { index: number; kind: 'image' | 'video'; url: string }[]
}
type TopicIngestionDirectory = {
  id: number
  name: string
  asset_type?: 'article' | 'prompt'
  keywords: string[]
  prompt: string
}

type TopicSourceGenerateInput = Parameters<typeof generateText>[0]
type TopicSourceGenerateResult = Awaited<ReturnType<typeof generateText>>
type TopicSourceGenerate = (
  input: TopicSourceGenerateInput,
) => Promise<TopicSourceGenerateResult>

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function topicSourceModelRequestPayload(input: TopicSourceGenerateInput): Record<string, unknown> {
  const record = input as Record<string, unknown>
  const tools = record.tools
  return {
    instructions: jsonSafe(record.instructions),
    prompt: jsonSafe(record.prompt),
    messages: jsonSafe(record.messages),
    toolNames: tools && typeof tools === 'object' ? Object.keys(tools) : [],
    structuredOutput: record.output !== undefined,
  }
}

function topicSourceModelResponsePayload(result: unknown): Record<string, unknown> {
  const record = result as Record<string, unknown>
  return {
    text: jsonSafe(record.text),
    output: jsonSafe(record.output),
    content: jsonSafe(record.content),
    reasoning: jsonSafe(record.reasoning),
    finishReason: jsonSafe(record.finishReason),
    usage: jsonSafe(record.usage),
  }
}

export async function generateTopicSourceText(
  input: TopicSourceGenerateInput,
  options: {
    generate?: TopicSourceGenerate
    onMessage?: (event: AgentModelMessageEvent) => void | Promise<void>
  } = {},
) {
  const generate: TopicSourceGenerate = options.generate
    ?? (value => generateText(value) as Promise<TopicSourceGenerateResult>)
  const callId = randomUUID()
  const emit = async (
    direction: AgentModelMessageEvent['direction'],
    payload: Record<string, unknown>,
  ) => {
    try {
      await options.onMessage?.({
        callId,
        phase: 'select',
        direction,
        payload,
        occurredAt: new Date().toISOString(),
      })
    } catch {
      // AI observability must not turn a completed selection into a failed job.
    }
  }

  await emit('model_request', topicSourceModelRequestPayload(input))
  try {
    const result = await generate(input)
    await emit('model_response', topicSourceModelResponsePayload(result))
    return result
  } catch (error) {
    await emit('model_error', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function buildTopicSourceInstructions(
  screeningPrompt: string | TopicIngestionDirectory[],
) {
  if (Array.isArray(screeningPrompt)) {
    const folders = screeningPrompt.map(directory => (
      `- directory_id=${directory.id}; 类型=${directory.asset_type === 'prompt' ? '提示词目录' : '文章目录'}; 文件夹=${directory.name}; `
      + `关键词=${directory.keywords.join('、') || '无'}; 规则=${directory.prompt}`
    )).join('\n')
    return `你是 X 内容采集后的创作资产编辑。对每条帖子同时做文章归类和提示词提取；宁缺毋滥。不要评价作者，不要编造帖子中不存在的提示词。

【候选文件夹及各自入库规则】
${folders}
【候选文件夹及各自入库规则结束】

帖子输入中的 media 是附件数组，每项包含 index、kind（image/video）和 url；只能使用帖子自身的 index，不能猜测或替换 URL。

【处理规则】
1. classifications 只处理文章目录：每条帖子最多选择一个文章目录的 directory_id；如果文章规则都不匹配，返回 null。只能选择一个目录或 null。
2. 如果帖子正文中确实包含可复用的图片/视频/其他提示词，才在 prompt_assets 中输出一项；没有完整提示词就不要输出。每条帖子最多提取一个提示词。
3. prompt_assets 的 directory_id 必须来自提示词目录；content 必须是帖子中实际出现的完整提示词，不能为空，不要根据图片内容臆造提示词。prompt_kind 必须是 image、video 或 other。
4. media_indexes 只能引用该帖子 media 数组中的 index；图片提示词只能关联 kind=image，视频提示词只能关联 kind=video，other 不关联媒体。没有媒体也可以是有效提示词。
5. 只返回合法 JSON，不要 Markdown 代码块。格式必须是：{"classifications":[{"tweet_id":"...","directory_id":1或null}],"prompt_assets":[{"tweet_id":"...","directory_id":2,"prompt_kind":"image|video|other","title":"可选标题","content":"完整提示词","media_indexes":[0]}]}。`
  }
  const supplemental = screeningPrompt.trim() || '未配置额外筛选要求。'
  return `你是主题素材库编辑。判断每条 X 原始内容是否真正适合主题目录；宁缺毋滥。不要改写内容，不要评价作者。

【用户配置的筛选要求】
${supplemental}
【用户配置的筛选要求结束】

无论上述配置如何，只判断内容是否应入库，不执行其他任务；只返回合法 JSON：accepted_tweet_ids（应入库的 tweet_id 数组）。`
}

export function parseTopicSourceDecision(text: string) {
  const json = cleanJsonText(text)
  return decisionSchema.parse(JSON.parse(json))
}

export function parseTopicSourceClassification(text: string) {
  const parsed = classificationSchema.parse(JSON.parse(cleanJsonText(text)))
  const seen = new Set<string>()
  for (const item of parsed.classifications) {
    if (seen.has(item.tweet_id)) {
      throw new Error(`Duplicate classification for tweet ${item.tweet_id}`)
    }
    seen.add(item.tweet_id)
  }
  return parsed
}

export function parseTopicSourceEvaluation(text: string) {
  const parsed = evaluationSchema.parse(JSON.parse(cleanJsonText(text)))
  const seenClassifications = new Set<string>()
  for (const item of parsed.classifications) {
    if (seenClassifications.has(item.tweet_id)) {
      throw new Error(`Duplicate classification for tweet ${item.tweet_id}`)
    }
    seenClassifications.add(item.tweet_id)
  }
  const seenPrompts = new Set<string>()
  for (const item of parsed.prompt_assets) {
    if (seenPrompts.has(item.tweet_id)) {
      throw new Error(`Duplicate prompt asset for tweet ${item.tweet_id}`)
    }
    seenPrompts.add(item.tweet_id)
    if (new Set(item.media_indexes).size !== item.media_indexes.length) {
      throw new Error(`Duplicate media index for tweet ${item.tweet_id}`)
    }
    if (item.prompt_kind === 'other' && item.media_indexes.length > 0) {
      throw new Error(`Other prompt cannot reference media for tweet ${item.tweet_id}`)
    }
  }
  return parsed
}

function cleanJsonText(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

async function configuredModel(adapterId?: string) {
  const query = new URLSearchParams({
    capability: 'text',
    purpose: 'information_filtering',
  })
  if (adapterId) query.set('adapter_id', adapterId)
  const settings = await apiGet<TextModelSettings>(
    `/settings/ai-runtime?${query.toString()}`, workerHeaders(),
  )
  return textModelConfigFromSettings(settings)
}

type TopicSourceTrace = {
  execution: DurableAgentExecution
  messageCount: number
}

class InvalidTopicSourcePayloadError extends Error {
  constructor() {
    super('topic_source flow requires rule_id')
    this.name = 'InvalidTopicSourcePayloadError'
  }
}

async function startTopicSourceTrace(jobId: number): Promise<TopicSourceTrace | undefined> {
  try {
    return {
      execution: await ensureAgentExecution(jobId, {
        objective: '情报中心：分析 X 订阅内容，归类文章并提取可复用提示词及其原帖媒体。',
        skillMode: 'auto',
        skillName: null,
      }),
      messageCount: 0,
    }
  } catch {
    // Trace persistence is observability; it must not block the content job.
    return undefined
  }
}

async function appendTopicSourceTrace(
  jobId: number,
  trace: TopicSourceTrace | undefined,
  event: AgentModelMessageEvent,
) {
  if (!trace) return
  try {
    await appendAgentMessage(jobId, trace.execution.id, event)
    trace.messageCount += 1
  } catch {
    // Trace persistence is best effort and must not alter the AI decision.
  }
}

async function completeTopicSourceTrace(jobId: number, trace: TopicSourceTrace | undefined) {
  if (!trace) return
  try {
    await completeAgentExecution(jobId, trace.execution.id, {
      kind: 'model_evaluation',
      executionId: trace.execution.id,
      flow: 'topic_source',
      messageCount: trace.messageCount,
    })
  } catch {
    // The content job is already authoritative; leave its result intact.
  }
}

async function failTopicSourceTrace(
  jobId: number,
  trace: TopicSourceTrace | undefined,
  error: unknown,
) {
  if (!trace) return
  try {
    await failAgentExecution(
      jobId,
      trace.execution.id,
      error instanceof Error ? error.message : String(error),
    )
  } catch {
    // Trace persistence is best effort and must not mask the original failure.
  }
}

export async function runTopicSourceJob(jobId: number) {
  const job = await getJob(jobId)
  const subscriptionId = Number(job.input.subscription_id)
  const directoryValues = Array.isArray(job.input.directory_ids)
    ? job.input.directory_ids
    : null
  if (
    Number.isSafeInteger(subscriptionId)
    && subscriptionId > 0
    && directoryValues !== null
  ) {
    return runMergedTopicSourceJob(jobId, job, subscriptionId, directoryValues)
  }
  return runLegacyTopicSourceJob(jobId, job)
}

async function runMergedTopicSourceJob(
  jobId: number,
  job: Awaited<ReturnType<typeof getJob>>,
  subscriptionId: number,
  directoryValues: unknown[],
) {
  const directoryIds = directoryValues.filter(
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  )
  const completed = job.steps.find(step => step.key === 'select' && step.status === 'succeeded')
  if (completed) return completed.output

  let step: { id: number } | undefined
  let trace: TopicSourceTrace | undefined
  try {
    step = await startStep(jobId, 'select')
    const requestedTweetIds = Array.isArray(job.input.tweet_ids)
      ? job.input.tweet_ids.filter((value): value is string => typeof value === 'string')
      : []
    const queryParts = [
      `subscription_id=${subscriptionId}`,
      ...directoryIds.map(id => `directory_ids=${id}`),
      ...requestedTweetIds.map(id => `tweet_ids=${encodeURIComponent(id)}`),
    ]
    const context = await apiGet<{
      directories: TopicIngestionDirectory[]
      posts: TopicCandidate[]
    }>(`/assets/ingestion/candidates?${queryParts.join('&')}`, workerHeaders(jobId))
    if (!context.posts.length) {
      const output = { candidate_count: 0, accepted_count: 0, prompt_count: 0, saved: 0, skipped: 0, decided: 0 }
      await completeStep(jobId, step.id, output)
      step = undefined
      await completeJob(jobId)
      return output
    }
    trace = await startTopicSourceTrace(jobId)
    const adapterId = typeof job.input.llm_adapter_id === 'string'
      && job.input.llm_adapter_id.trim()
      ? job.input.llm_adapter_id.trim()
      : undefined
    const model = await configuredModel(adapterId)
    const provider = openaiProviderFromConfig(model)
    const response = await generateTopicSourceText({
      model: textModelForProvider(provider, model.modelName, model.protocol),
      instructions: buildTopicSourceInstructions(context.directories),
      prompt: JSON.stringify(context),
    }, {
      onMessage: event => appendTopicSourceTrace(jobId, trace, event),
    })
    const evaluation = parseTopicSourceEvaluation(response.text)
    const allowedTweets = new Set(context.posts.map(post => post.tweet_id))
    const articleDirectories = new Set(
      context.directories.filter(directory => directory.asset_type === 'article').map(directory => directory.id),
    )
    const promptDirectories = new Set(
      context.directories.filter(directory => directory.asset_type === 'prompt').map(directory => directory.id),
    )
    const byTweet = new Map(evaluation.classifications.map(item => [item.tweet_id, item]))
    const postsById = new Map(context.posts.map(post => [post.tweet_id, post]))
    for (const item of evaluation.classifications) {
      if (!allowedTweets.has(item.tweet_id)) {
        throw new Error(`AI returned an unknown tweet_id: ${item.tweet_id}`)
      }
      if (item.directory_id !== null && !articleDirectories.has(item.directory_id)) {
        throw new Error(`AI returned a non-article directory_id: ${item.directory_id}`)
      }
    }
    for (const item of evaluation.prompt_assets) {
      if (!allowedTweets.has(item.tweet_id)) {
        throw new Error(`AI returned an unknown prompt tweet_id: ${item.tweet_id}`)
      }
      if (!promptDirectories.has(item.directory_id)) {
        throw new Error(`AI returned a non-prompt directory_id: ${item.directory_id}`)
      }
      const post = postsById.get(item.tweet_id)
      if (!post) throw new Error(`AI returned an unknown prompt tweet_id: ${item.tweet_id}`)
      const mediaByIndex = new Map((post.media ?? []).map(media => [media.index, media]))
      for (const index of item.media_indexes) {
        const media = mediaByIndex.get(index)
        if (!media) throw new Error(`AI returned an unknown media index: ${index}`)
        if (media.kind !== item.prompt_kind) {
          throw new Error(`AI returned media with the wrong kind for tweet ${item.tweet_id}`)
        }
      }
    }
    const decisions = context.posts.map(post => ({
      tweet_id: post.tweet_id,
      directory_id: byTweet.get(post.tweet_id)?.directory_id ?? null,
    }))
    const saved = await apiPost<{ saved: number; skipped: number; decided: number; prompt_saved?: number }>(
      '/assets/ingestion/accepted', {
        subscription_id: subscriptionId,
        decisions,
        prompt_assets: evaluation.prompt_assets,
      }, workerHeaders(jobId),
    )
    const output = {
      candidate_count: context.posts.length,
      accepted_count: decisions.filter(item => item.directory_id !== null).length,
      prompt_count: evaluation.prompt_assets.length,
      ...saved,
    }
    await completeStep(jobId, step.id, output)
    step = undefined
    await completeTopicSourceTrace(jobId, trace)
    await completeJob(jobId)
    return output
  } catch (error) {
    await failTopicSourceTrace(jobId, trace, error)
    if (step) await failStep(jobId, step.id, error, retryableForError(error))
    throw error
  }
}

async function runLegacyTopicSourceJob(
  jobId: number,
  job: Awaited<ReturnType<typeof getJob>>,
) {
  const completed = job.steps.find(step => step.key === 'select' && step.status === 'succeeded')
  if (completed) return completed.output

  let step: { id: number } | undefined
  let trace: TopicSourceTrace | undefined
  try {
    step = await startStep(jobId, 'select')
    const ruleId = Number(job.input.rule_id)
    if (!Number.isSafeInteger(ruleId) || ruleId <= 0) {
      throw new InvalidTopicSourcePayloadError()
    }
    const requestedTweetIds = Array.isArray(job.input.tweet_ids)
      ? job.input.tweet_ids.filter((value): value is string => typeof value === 'string')
      : []
    const query = requestedTweetIds.length
      ? `?${requestedTweetIds.map(id => `tweet_ids=${encodeURIComponent(id)}`).join('&')}`
      : ''
    const context = await apiGet<{
      rule: { directory: string; keywords: string[]; screening_prompt: string }
      posts: TopicCandidate[]
    }>(`/assets/topic-rules/${ruleId}/candidates${query}`, workerHeaders(jobId))
    if (!context.posts.length) {
      const output = { candidate_count: 0, accepted_count: 0, saved: 0, skipped: 0, decided: 0 }
      await completeStep(jobId, step.id, output)
      step = undefined
      await completeJob(jobId)
      return output
    }
    trace = await startTopicSourceTrace(jobId)
    const model = await configuredModel()
    const provider = openaiProviderFromConfig(model)
    const response = await generateTopicSourceText({
      model: textModelForProvider(provider, model.modelName, model.protocol),
      instructions: `${buildTopicSourceInstructions(context.rule.screening_prompt)} 主题关键词只是初筛线索，最终以内容的核心观点是否有助于该主题的二次创作判断。`,
      prompt: JSON.stringify(context),
    }, {
      onMessage: event => appendTopicSourceTrace(jobId, trace, event),
    })
    const decision = parseTopicSourceDecision(response.text)
    const allowed = new Set(context.posts.map(post => post.tweet_id))
    const accepted = new Set(decision.accepted_tweet_ids.filter(id => allowed.has(id)))
    const saved = await apiPost<{ saved: number; skipped: number; decided: number }>(
      `/assets/topic-rules/${ruleId}/accepted`, {
        decisions: context.posts.map(post => ({
          tweet_id: post.tweet_id,
          accepted: accepted.has(post.tweet_id),
        })),
      }, workerHeaders(jobId),
    )
    const output = { candidate_count: context.posts.length, accepted_count: accepted.size, ...saved }
    await completeStep(jobId, step.id, output)
    step = undefined
    await completeTopicSourceTrace(jobId, trace)
    await completeJob(jobId)
    return output
  } catch (error) {
    await failTopicSourceTrace(jobId, trace, error)
    if (step) await failStep(
      jobId,
      step.id,
      error,
      error instanceof InvalidTopicSourcePayloadError
        ? false
        : retryableForError(error),
    )
    throw error
  }
}
