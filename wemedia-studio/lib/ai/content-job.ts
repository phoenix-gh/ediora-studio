import { createOpenAI } from '@ai-sdk/openai'
import { generateImage, generateText, stepCountIs, tool } from 'ai'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const apiBase = () => (process.env.WMS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')

type ModelConfig = { apiKey: string; modelName: string; baseURL?: string }
type ImageModelConfig = { apiKey: string; modelName: string; baseURL?: string }
type CoverStyle = Record<string, unknown>

export type ContentStep = 'brief' | 'draft' | 'cover' | 'illustrations' | 'daily_plan'

const stepToolNames: Record<ContentStep, string[]> = {
  brief: ['loadSource', 'loadAccountContext', 'saveBrief'],
  draft: ['getBrief', 'loadWritingContext', 'saveDraft'],
  cover: ['getDraft', 'loadCoverContext', 'saveCoverAsset'],
  illustrations: ['getDraft', 'loadImageContext', 'saveInlineAsset'],
  daily_plan: ['loadPlanningContext', 'saveDailyPlan'],
}

export function toolsForContentStep(step: ContentStep): string[] {
  return stepToolNames[step]
}

export function imageToolNamesForSkill(step: 'cover' | 'illustrations'): string[] {
  return ['generateImage']
}

export function textModelForProvider<T>(provider: { chat: (modelName: string) => T }, modelName: string): T {
  return provider.chat(modelName)
}

const dailyPlanSchema = z.object({
  note: z.string(),
  items: z.array(z.object({
    account_id: z.string(), title: z.string(), angle: z.string(), reason: z.string(),
    content_type: z.enum(['long', 'short', 'story', 'share']),
    sources: z.array(z.union([z.record(z.string(), z.unknown()), z.string()])).default([])
      .transform(sources => sources.map(source => typeof source === 'string' ? { url: source } : source)),
    group_key: z.string().default(''), is_primary: z.boolean().default(true),
  })).min(1),
})

export function parseDailyPlanText(text: string) {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return dailyPlanSchema.parse(JSON.parse(json))
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

async function getDraft(draftId: number) {
  const response = await fetch(`${apiBase()}/write/drafts/${draftId}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load draft (${response.status})`)
  return response.json() as Promise<{ id: number; title: string; content: string }>
}

async function saveDraftImage(jobId: number, draftId: number, filename: string, bytes: Uint8Array, mediaType: string) {
  const form = new FormData()
  const data = new Uint8Array(bytes.byteLength)
  data.set(bytes)
  form.append('file', new Blob([data], { type: mediaType }), filename)
  const response = await fetch(`${apiBase()}/write/drafts/${draftId}/images`, {
    method: 'POST', headers: { 'X-Content-Job-Id': String(jobId) }, body: form,
  })
  if (!response.ok) throw new Error(`Image upload failed (${response.status})`)
  return response.json() as Promise<{ id: number; url: string }>
}

async function saveDailyPlan(planId: number, items: unknown[], note: string) {
  const response = await fetch(`${apiBase()}/daily-plan/${planId}/items`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, note }),
  })
  if (!response.ok) throw new Error(`Daily plan save failed (${response.status})`)
  return response.json() as Promise<{ items: Array<{ id: number }> }>
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

async function recordJobEvent(jobId: number, kind: string, payload: Record<string, unknown>) {
  const response = await fetch(`${apiBase()}/jobs/${jobId}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, payload }),
  })
  if (!response.ok) throw new Error(`Unable to record ${kind} event`)
}

async function configuredTextModel(): Promise<ModelConfig> {
  try {
    const response = await fetch(`${apiBase()}/settings/ai-runtime`, { cache: 'no-store' })
    if (response.ok) {
      const settings = await response.json() as { api_key: string; model: string; base_url: string }
      if (settings.api_key) return { apiKey: settings.api_key, modelName: settings.model || 'gpt-4o-mini', baseURL: settings.base_url || undefined }
    }
  } catch {
    // Environment variables keep Docker and disconnected development usable.
  }
  const apiKey = process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('No LLM API key is configured in Settings or WMS_LLM_API_KEY')
  return { apiKey, modelName: process.env.WMS_LLM_MODEL ?? 'gpt-4o-mini', baseURL: process.env.WMS_LLM_BASE_URL }
}

async function configuredImageModel(): Promise<ImageModelConfig> {
  const response = await fetch(`${apiBase()}/settings/ai-runtime`, { cache: 'no-store' })
  if (response.ok) {
    const settings = await response.json() as { image?: { api_key: string; model: string; base_url: string } }
    if (settings.image?.api_key) {
      return { apiKey: settings.image.api_key, modelName: settings.image.model || 'gpt-image-1', baseURL: settings.image.base_url || undefined }
    }
  }
  const apiKey = process.env.WMS_IMAGE_API_KEY
  if (!apiKey) throw new Error('Image model is not configured. Set an image API key in Settings.')
  return { apiKey, modelName: process.env.WMS_IMAGE_MODEL ?? 'gpt-image-1', baseURL: process.env.WMS_IMAGE_BASE_URL }
}

export function baoyuRuntimeInstructions(step: 'cover' | 'illustrations', maxImages: number) {
  const common = `This application has already collected preferences and user confirmation. Work autonomously: do not ask questions, do not perform first-time setup, and do not write prompt files. Use generateImage exactly ${maxImages} time${maxImages === 1 ? '' : 's'}; an image is created only when that tool succeeds. Do not put text in generated images unless the request explicitly asks for it.`
  if (step === 'cover') {
    return `You are the runtime adapter for the vendored baoyu-cover-image skill. Create an elegant raster article cover using its five dimensions: type (hero, conceptual, typography, metaphor, scene, minimal), palette, rendering (flat-vector, hand-drawn, painterly, digital, pixel, chalk, screen-print), text level, and mood. Infer suitable choices from the article and supplied style. Write one complete, concrete image-generation prompt with subject, composition, palette, rendering, aspect ratio, and any explicit no-text instruction. ${common}`
  }
  return `You are the runtime adapter for the vendored baoyu-article-illustrator skill. Analyze the article and choose the most useful ${maxImages} visual explanation point${maxImages === 1 ? '' : 's'}. For each, create a clear 16:9 hand-drawn editorial infographic or conceptual illustration with strong visual hierarchy, ample whitespace, and no photorealism. The images must explain the surrounding content rather than repeat the cover. ${common}`
}

export function coverConstraintsFromStyle(style: CoverStyle) {
  const dimensions = ['type', 'palette', 'rendering', 'text', 'mood', 'aspect_ratio', 'font']
    .flatMap(key => typeof style[key] === 'string' && style[key].trim() ? [`MUST use ${key}: ${style[key].trim()}.`] : [])
  const required = Array.isArray(style.signature_motifs) ? style.signature_motifs.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => `MUST include: ${item.trim()}.`) : []
  const prohibited = Array.isArray(style.negative) ? style.negative.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => `MUST NOT include: ${item.trim()}.`) : []
  return [...dimensions, ...required, ...prohibited].join('\n')
}

export function extractBaoyuSkillCore(step: 'cover' | 'illustrations', skill: string) {
  const startHeading = step === 'cover' ? '## Five Dimensions' : '## Three Dimensions'
  const endHeading = step === 'cover' ? '## File Structure' : '## Workflow'
  const start = skill.indexOf(startHeading)
  const end = skill.indexOf(endHeading, start)
  if (start < 0 || end < 0) throw new Error(`Bundled ${step} skill is missing its core guidance`)
  return skill.slice(start, end).trim()
}

async function loadBaoyuSkillCore(step: 'cover' | 'illustrations') {
  const skillName = step === 'cover' ? 'baoyu-cover-image' : 'baoyu-article-illustrator'
  const skillPath = join(process.cwd(), 'skills', skillName, 'SKILL.md')
  try {
    return extractBaoyuSkillCore(step, await readFile(skillPath, 'utf8'))
  } catch (error) {
    if (error instanceof Error && error.message.includes('core guidance')) throw error
    throw new Error(`Bundled image skill is missing: ${skillName}`)
  }
}

async function loadBaoyuSkillRules(step: 'cover' | 'illustrations') {
  const skillName = step === 'cover' ? 'baoyu-cover-image' : 'baoyu-article-illustrator'
  const skillDir = join(process.cwd(), 'skills', skillName)
  const core = await loadBaoyuSkillCore(step)
  if (step === 'illustrations') return { skillName, rules: core, ruleSources: ['SKILL.md: Three Dimensions'] }
  try {
    const [autoSelection, promptTemplate] = await Promise.all([
      readFile(join(skillDir, 'references', 'auto-selection.md'), 'utf8'),
      readFile(join(skillDir, 'references', 'workflow', 'prompt-template.md'), 'utf8'),
    ])
    return { skillName, rules: `${core}\n\n${autoSelection}\n\n${promptTemplate}`, ruleSources: ['SKILL.md: Five Dimensions', 'references/auto-selection.md', 'references/workflow/prompt-template.md'] }
  } catch {
    throw new Error(`Bundled image skill references are missing: ${skillName}`)
  }
}

async function runImageFlow(job: Awaited<ReturnType<typeof getJob>>, step: 'cover' | 'illustrations') {
  const draftId = Number(job.input.draft_id)
  if (!Number.isSafeInteger(draftId) || draftId <= 0) throw new Error(`${step} flow requires draft_id`)
  const draft = await getDraft(draftId)
  const maxImages = step === 'cover' ? 1 : Math.max(1, Math.min(Number(job.input.max_images) || 1, 4))
  const image = await configuredImageModel()
  const provider = createOpenAI({ apiKey: image.apiKey, baseURL: image.baseURL })
  const text = await configuredTextModel()
  const textProvider = createOpenAI({ apiKey: text.apiKey, baseURL: text.baseURL })
  const assets: Array<{ id: number; url: string }> = []
  const rawStyle = job.input[step === 'cover' ? 'cover_style' : 'image_style'] ?? job.input.note ?? ''
  const style = typeof rawStyle === 'string' ? rawStyle : JSON.stringify(rawStyle)
  const coverConstraints = step === 'cover' && rawStyle && typeof rawStyle === 'object' && !Array.isArray(rawStyle)
    ? coverConstraintsFromStyle(rawStyle as CoverStyle) : ''
  const skill = await loadBaoyuSkillRules(step)
  await recordJobEvent(job.id, 'skill_loaded', { skill: skill.skillName, rule_sources: skill.ruleSources })
  if (coverConstraints) await recordJobEvent(job.id, 'cover_constraints', { constraints: coverConstraints })
  await generateText({
    model: textModelForProvider(textProvider, text.modelName),
    instructions: `${baoyuRuntimeInstructions(step, maxImages)}\n\nHard cover constraints:\n${coverConstraints || 'No account-specific constraints.'}\n\nBundled Baoyu skill rules:\n${skill.rules}`,
    prompt: JSON.stringify({ task: step, title: draft.title, article: draft.content.slice(0, 4000), style, max_images: maxImages }),
    stopWhen: stepCountIs(maxImages + 1),
    tools: {
      generateImage: tool({
        description: 'Generate one raster image from the supplied prompt and save it to this draft. Use this tool for every requested cover or illustration.',
        inputSchema: z.object({ prompt: z.string().min(20), filename_hint: z.string().min(1).max(80).optional() }),
        execute: async ({ prompt, filename_hint }) => {
          if (assets.length >= maxImages) return { error: `Image limit reached (${maxImages})` }
          const finalPrompt = step === 'cover' && coverConstraints ? `${coverConstraints}\n\n${prompt}` : prompt
          await recordJobEvent(job.id, 'generate_image_called', { tool: 'generateImage', prompt: finalPrompt, filename_hint: filename_hint ?? '' })
          const generated = await generateImage({ model: provider.image(image.modelName), prompt: finalPrompt, n: 1 })
          const output = generated.images[0]
          const asset = await saveDraftImage(job.id, draftId, `${filename_hint ?? step}-${job.id}-${assets.length + 1}.png`, output.uint8Array, output.mediaType)
          assets.push(asset)
          await recordJobEvent(job.id, 'generate_image_succeeded', { tool: 'generateImage', asset_id: asset.id, asset_url: asset.url })
          return asset
        },
      }),
    },
  })
  if (!assets.length) {
    throw new Error(`The ${step} skill did not call generateImage`)
  }
  return { draft_id: draftId, asset_ids: assets.map(asset => asset.id), asset_urls: assets.map(asset => asset.url) }
}

async function runDailyPlanFlow(job: Awaited<ReturnType<typeof getJob>>, model: ReturnType<typeof createOpenAI>, modelName: string) {
  const planId = Number(job.input.plan_id)
  if (!Number.isSafeInteger(planId) || planId <= 0) throw new Error('daily_plan flow requires plan_id')
  const result = await generateText({
    model: textModelForProvider(model, modelName),
    prompt: `Create today's content plan. Return only a valid JSON object, without Markdown fences. It must have a string note and a non-empty items array. Each item must include account_id, title, angle, reason, content_type (long, short, story, or share), sources (array), group_key (string), and is_primary (boolean). ${JSON.stringify(job.input)}`,
  })
  const plan = parseDailyPlanText(result.text)
  const saved = await saveDailyPlan(planId, plan.items, plan.note)
  return { plan_id: planId, item_count: saved.items.length }
}

export async function runContentJob(jobId: number) {
  const job = await getJob(jobId)
  const draftStep = job.steps.find(step => step.key === 'draft')
  if (draftStep?.output?.draft_id) return draftStep.output
  let activeStep: { id: number } | undefined
  try {
    if (job.flow === 'cover' || job.flow === 'illustrations') {
      activeStep = await startStep(job.id, job.flow)
      const output = await runImageFlow(job, job.flow)
      await completeStep(job.id, activeStep.id, output)
      activeStep = undefined
      await completeJob(job.id)
      return output
    }
    activeStep = await startStep(job.id, job.flow === 'daily_plan' ? 'daily_plan' : 'brief')
    const modelConfig = await configuredTextModel()
    const modelName = modelConfig.modelName
    const openai = createOpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL })
    if (job.flow === 'daily_plan') {
      const output = await runDailyPlanFlow(job, openai, modelName)
      await completeStep(job.id, activeStep.id, output)
      activeStep = undefined
      await completeJob(job.id)
      return output
    }
    if (job.flow !== 'draft') throw new Error(`Unsupported content flow: ${job.flow}`)
    const briefResult = await generateText({
      model: textModelForProvider(openai, modelName),
      instructions: '根据用户提供的素材和账号约束，生成简洁、可执行的中文写作 brief。不得调用外部工具。',
      prompt: JSON.stringify({ title: job.title, input: job.input }),
    })
    await completeStep(job.id, activeStep.id, { brief: briefResult.text })
    activeStep = await startStep(job.id, 'draft')
    let savedDraft: { draftId: number } | undefined
    const result = await generateText({
      model: textModelForProvider(openai, modelName),
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
