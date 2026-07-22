import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

const apiBase = () => (process.env.WMS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')

export type ContentStep = 'brief' | 'draft' | 'cover' | 'illustrations'

const stepToolNames: Record<ContentStep, string[]> = {
  brief: ['loadSource', 'loadAccountContext', 'saveBrief'],
  draft: ['getBrief', 'loadWritingContext', 'saveDraft'],
  cover: ['getDraft', 'loadCoverContext', 'saveCoverAsset'],
  illustrations: ['getDraft', 'loadImageContext', 'saveInlineAsset'],
}

export function toolsForContentStep(step: ContentStep): string[] {
  return stepToolNames[step]
}

async function getJob(jobId: number) {
  const response = await fetch(`${apiBase()}/jobs/${jobId}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load content job (${response.status})`)
  return response.json() as Promise<{ id: number; title: string; input: Record<string, unknown>; steps: Array<{ key: string; output: Record<string, unknown> }> }>
}

async function saveDraft(jobId: number, title: string, content: string) {
  const response = await fetch(`${apiBase()}/write/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Content-Job-Id': String(jobId) },
    body: JSON.stringify({ topic_id: `job:${jobId}`, title, content, status: 'drafting' }),
  })
  if (!response.ok) throw new Error('Draft save failed')
  const draft = await response.json() as { id: number }
  return { draftId: draft.id }
}

export async function runContentJob(jobId: number) {
  const apiKey = process.env.WMS_LLM_API_KEY
  const modelName = process.env.WMS_LLM_MODEL ?? 'gpt-4o-mini'
  if (!apiKey) throw new Error('WMS_LLM_API_KEY is not configured')

  const job = await getJob(jobId)
  const draftStep = job.steps.find(step => step.key === 'draft')
  if (draftStep?.output?.draft_id) return draftStep.output

  const openai = createOpenAI({ apiKey, baseURL: process.env.WMS_LLM_BASE_URL })
  const result = await generateText({
    model: openai(modelName),
    instructions: '你是内容写作助手。只能使用提供的工具保存完整 Markdown 草稿；不得发布内容。',
    prompt: `为以下任务写作：${JSON.stringify({ title: job.title, input: job.input })}`,
    stopWhen: stepCountIs(4),
    tools: {
      getBrief: tool({
        description: '读取本次任务已生成的 brief。',
        inputSchema: z.object({}),
        execute: async () => job.steps.find(step => step.key === 'brief')?.output ?? {},
      }),
      loadWritingContext: tool({
        description: '读取账号、素材和写作约束。',
        inputSchema: z.object({}),
        execute: async () => job.input,
      }),
      saveDraft: tool({
        description: '保存完整草稿。必须调用一次作为最终输出。',
        inputSchema: z.object({ title: z.string().min(1), content: z.string().min(1) }),
        execute: async ({ title, content }) => saveDraft(job.id, title, content),
      }),
    },
  })
  return { text: result.text, steps: result.steps.length }
}
