import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { z } from 'zod'

import {
  apiGet, apiPost, completeJob, completeStep, failStep, getJob,
  retryableForError, startStep, workerHeaders,
} from './job-client'

const decisionSchema = z.object({
  accepted_tweet_ids: z.array(z.string()),
})

type TopicCandidate = { tweet_id: string; content: string; url: string }

export function parseTopicSourceDecision(text: string) {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return decisionSchema.parse(JSON.parse(json))
}

async function configuredModel() {
  const settings = await apiGet<{ api_key: string; model: string; base_url: string }>(
    '/settings/ai-runtime', workerHeaders(),
  )
  const apiKey = settings.api_key || process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('No LLM API key is configured')
  return {
    apiKey,
    modelName: settings.model || process.env.WMS_LLM_MODEL || 'gpt-4o-mini',
    baseURL: settings.base_url || process.env.WMS_LLM_BASE_URL || undefined,
  }
}

export async function runTopicSourceJob(jobId: number) {
  const job = await getJob(jobId)
  const ruleId = Number(job.input.rule_id)
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) {
    throw new Error('topic_source flow requires rule_id')
  }
  const completed = job.steps.find(step => step.key === 'select' && step.status === 'succeeded')
  if (completed) return completed.output

  let step: { id: number } | undefined
  try {
    step = await startStep(jobId, 'select')
    const requestedTweetIds = Array.isArray(job.input.tweet_ids)
      ? job.input.tweet_ids.filter((value): value is string => typeof value === 'string')
      : []
    const query = requestedTweetIds.length
      ? `?${requestedTweetIds.map(id => `tweet_ids=${encodeURIComponent(id)}`).join('&')}`
      : ''
    const context = await apiGet<{
      rule: { directory: string; keywords: string[] }
      posts: TopicCandidate[]
    }>(`/assets/topic-rules/${ruleId}/candidates${query}`, workerHeaders(jobId))
    if (!context.posts.length) {
      const output = { candidate_count: 0, accepted_count: 0, saved: 0, skipped: 0, decided: 0 }
      await completeStep(jobId, step.id, output)
      step = undefined
      await completeJob(jobId)
      return output
    }
    const model = await configuredModel()
    const provider = createOpenAI({ apiKey: model.apiKey, baseURL: model.baseURL })
    const response = await generateText({
      model: provider.chat(model.modelName),
      instructions: `你是主题素材库编辑。判断每条 X 原始内容是否真正适合主题目录；宁缺毋滥。不要改写内容，不要评价作者。只返回合法 JSON：accepted_tweet_ids（应入库的 tweet_id 数组）。主题关键词只是初筛线索，最终以内容的核心观点是否有助于该主题的二次创作判断。`,
      prompt: JSON.stringify(context),
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
    await completeJob(jobId)
    return output
  } catch (error) {
    if (step) await failStep(jobId, step.id, error, retryableForError(error))
    throw error
  }
}
