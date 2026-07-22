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
  return response.json() as Promise<{ id: number; flow: string; title: string; input: Record<string, unknown>; steps: Array<{ key: string; output: Record<string, unknown> }> }>
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

async function startStep(jobId: number, step: ContentStep) {
  const response = await fetch(`${apiBase()}/jobs/${jobId}/steps/${step}/start`, { method: 'POST' })
  if (!response.ok) throw new Error(`Unable to start ${step} step`)
  return response.json() as Promise<{ id: number }>
}

async function completeStep(jobId: number, stepId: number, output: Record<string, unknown>) {
  const response = await fetch(`${apiBase()}/jobs/${jobId}/steps/${stepId}/succeed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output }),
  })
  if (!response.ok) throw new Error('Unable to record content step')
}

async function failStep(jobId: number, stepId: number, error: unknown, retryable = true) {
  const message = error instanceof Error ? error.message : String(error)
  const response = await fetch(`${apiBase()}/jobs/${jobId}/steps/${stepId}/fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message.slice(0, 500), retryable }),
  })
  if (!response.ok) throw new Error('Unable to record failed content step')
}

async function completeJob(jobId: number) {
  const response = await fetch(`${apiBase()}/jobs/${jobId}/succeed`, { method: 'POST' })
  if (!response.ok) throw new Error('Unable to complete content job')
}

export async function runContentJob(jobId: number) {
  const job = await getJob(jobId)
  const draftStep = job.steps.find(step => step.key === 'draft')
  if (draftStep?.output?.draft_id) return draftStep.output
  let activeStep: { id: number } | undefined
  try {
    activeStep = await startStep(job.id, 'brief')
    if (job.flow !== 'draft') throw new Error(`Unsupported content flow: ${job.flow}`)
    const apiKey = process.env.WMS_LLM_API_KEY
    if (!apiKey) throw new Error('WMS_LLM_API_KEY is not configured')
    const modelName = process.env.WMS_LLM_MODEL ?? 'gpt-4o-mini'
    const openai = createOpenAI({ apiKey, baseURL: process.env.WMS_LLM_BASE_URL })
    const briefResult = await generateText({
      model: openai(modelName),
      instructions: '根据用户提供的素材和账号约束，生成简洁、可执行的中文写作 brief。不得调用外部工具。',
      prompt: JSON.stringify({ title: job.title, input: job.input }),
    })
    await completeStep(job.id, activeStep.id, { brief: briefResult.text })
    activeStep = await startStep(job.id, 'draft')
    let savedDraft: { draftId: number } | undefined
    const result = await generateText({
      model: openai(modelName),
      instructions: '你是内容写作助手。只能使用提供的工具保存完整 Markdown 草稿；不得发布内容。',
      prompt: `为以下任务写作：${JSON.stringify({ title: job.title, input: job.input })}`,
      stopWhen: stepCountIs(4),
      tools: {
        getBrief: tool({ description: '读取本次任务已生成的 brief。', inputSchema: z.object({}), execute: async () => ({ brief: briefResult.text }) }),
        loadWritingContext: tool({ description: '读取账号、素材和写作约束。', inputSchema: z.object({}), execute: async () => job.input }),
        saveDraft: tool({
          description: '保存完整草稿。必须调用一次作为最终输出。',
          inputSchema: z.object({ title: z.string().min(1), content: z.string().min(1) }),
          execute: async ({ title, content }) => {
            savedDraft = await saveDraft(job.id, title, content)
            return savedDraft
          },
        }),
      },
    })
    const saved = savedDraft ?? await saveDraft(job.id, job.title, result.text)
    await completeStep(job.id, activeStep.id, { draft_id: saved.draftId, text_length: result.text.length })
    activeStep = undefined
    await completeJob(job.id)
    return { ...saved, text: result.text, steps: result.steps.length }
  } catch (error) {
    if (activeStep) await failStep(job.id, activeStep.id, error, true)
    throw error
  }
}
