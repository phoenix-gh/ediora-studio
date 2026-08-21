import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

import { loadSkillContext, SkillRegistryError } from '../skills/registry'
import {
  configuredImageModel,
  generateImageBytes,
  generateAndSaveImage,
  imageExtensionForMediaType,
  recordJobEvent,
  saveCreativeAssetImage,
} from './image-generation'
import { workerHeaders } from './job-client'
import {
  textModelConfigFromSettings,
  type TextModelSettings,
} from './runtime-config'

const apiBase = () => (process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')

type ModelConfig = {
  apiKey: string
  modelName: string
  baseURL?: string
  headers: Record<string, string>
}
type CoverStyle = Record<string, unknown>

export type ContentStep = 'brief' | 'draft' | 'cover' | 'illustrations' | 'standalone_image' | 'prompt_image_generation' | 'template_extraction'

const stepToolNames: Record<ContentStep, string[]> = {
  brief: ['loadSource', 'loadAccountContext', 'saveBrief'],
  draft: ['getBrief', 'loadWritingContext', 'saveDraft'],
  cover: ['getDraft', 'loadCoverContext', 'saveCoverAsset'],
  illustrations: ['getDraft', 'loadImageContext', 'saveInlineAsset'],
  standalone_image: ['generateImage', 'saveCreativeAsset'],
  prompt_image_generation: ['generateImage', 'saveCreativeAsset'],
  template_extraction: [],
}

export function toolsForContentStep(step: ContentStep): string[] {
  return stepToolNames[step]
}

export { creativeAssetUploadQuery } from './image-generation'

export function imageToolNamesForSkill(step: 'cover' | 'illustrations'): string[] {
  void step
  return ['generateImage']
}

export function insertInlineImage(content: string, imageUrl: string, anchorHeading: string) {
  if (content.includes(`](${imageUrl})`)) return { content, placement: 'existing' as const }
  const marker = `## ${anchorHeading.trim()}`
  const headingStart = content.indexOf(marker)
  const markdown = `![插图](${imageUrl})`
  if (headingStart < 0) {
    return { content: `${content.trimEnd()}\n\n${markdown}`, placement: 'append' as const }
  }
  const headingEnd = content.indexOf('\n', headingStart)
  const insertAt = headingEnd < 0 ? content.length : headingEnd + 1
  return {
    content: `${content.slice(0, insertAt)}\n${markdown}\n${content.slice(insertAt)}`,
    placement: 'anchor' as const,
  }
}

export function textModelForProvider<T>(provider: { chat: (modelName: string) => T }, modelName: string): T {
  return provider.chat(modelName)
}


const templateCandidateSchema = z.object({
  recommendation: z.enum(['create', 'merge', 'skip']),
  title: z.string(),
  genre: z.enum(['tutorial', 'commentary', 'story', 'review']),
  writing_guide: z.string(),
  title_formula: z.string(),
  unsuitable_for: z.union([z.string(), z.array(z.string())]).transform(value => Array.isArray(value) ? value.join('\n') : value),
  genericity_check: z.string(),
  merge_target_id: z.number().int().positive().nullable().optional(),
  reason: z.string(),
})

export function parseTemplateCandidate(text: string) {
  const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return templateCandidateSchema.parse(JSON.parse(json))
}

export const coverSpecSchema = z.object({
  visual_concept: z.string().min(10).max(500),
  composition: z.string().min(10).max(500),
  text_elements: z.array(z.string().min(1).max(200)).max(8),
})

const imageGenerationInputSchema = z.object({
  prompt: z.string().min(20),
  filename_hint: z.string().min(1).max(80).optional(),
  cover_spec: coverSpecSchema.optional(),
  anchor_heading: z.string().min(1).max(160).optional(),
})

export const illustrationImageInputSchema = imageGenerationInputSchema.extend({
  anchor_heading: z.string().min(1).max(160),
})


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

async function updateDraftContent(jobId: number, draftId: number, content: string) {
  const response = await fetch(`${apiBase()}/write/drafts/${draftId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Content-Job-Id': String(jobId) },
    body: JSON.stringify({ content }),
  })
  if (!response.ok) throw new Error(`Draft image insertion failed (${response.status})`)
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

async function configuredTextModel(): Promise<ModelConfig> {
  const response = await fetch(`${apiBase()}/settings/ai-runtime`, {
    cache: 'no-store',
    headers: workerHeaders(),
  })
  if (!response.ok) throw new Error('无法读取设置中的文本模型配置')
  return textModelConfigFromSettings(await response.json() as TextModelSettings)
}

export function baoyuRuntimeInstructions(step: 'cover' | 'illustrations', maxImages: number) {
  const common = `This application has already collected preferences and user confirmation. Work autonomously: do not ask questions, do not perform first-time setup, and do not write prompt files. Use generateImage exactly ${maxImages} time${maxImages === 1 ? '' : 's'}; an image is created only when that tool succeeds. Do not put text in generated images unless the request explicitly asks for it.`
  if (step === 'cover') {
    return `You are the runtime adapter for the vendored baoyu-cover-image skill. Create an elegant raster article cover using its five dimensions: type (hero, conceptual, typography, metaphor, scene, minimal), palette, rendering (flat-vector, hand-drawn, painterly, digital, pixel, chalk, screen-print), text level, and mood. Infer suitable choices from the article and supplied style. Write one complete, concrete image-generation prompt with subject, composition, palette, rendering, aspect ratio, and any explicit no-text instruction. ${common}`
  }
  return `You are the runtime adapter for the vendored baoyu-article-illustrator skill. Analyze the article and choose the most useful ${maxImages} visual explanation point${maxImages === 1 ? '' : 's'}. For each, create a clear 16:9 hand-drawn editorial infographic or conceptual illustration with strong visual hierarchy, ample whitespace, and no photorealism. The images must explain the surrounding content rather than repeat the cover. For every generateImage call, provide anchor_heading exactly matching the most relevant existing level-two Markdown heading from the supplied article. ${common}`
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

async function loadBaoyuSkillRules(step: 'cover' | 'illustrations') {
  const skillName = step === 'cover' ? 'baoyu-cover-image' : 'baoyu-article-illustrator'
  const referencePaths = step === 'cover'
    ? ['references/auto-selection.md', 'references/workflow/prompt-template.md']
    : []
  let context
  try {
    context = await loadSkillContext(skillName, referencePaths)
  } catch (error) {
    if (error instanceof SkillRegistryError && error.code === 'not_found') {
      throw new Error(`Bundled image skill is unavailable or disabled: ${skillName}`)
    }
    throw error
  }
  const core = extractBaoyuSkillCore(step, context.instructions)
  if (step === 'illustrations') return { skillName, rules: core, ruleSources: ['SKILL.md: Three Dimensions'] }
  const [autoSelection, promptTemplate] = context.references.map(reference => reference.content)
  return { skillName, rules: `${core}\n\n${autoSelection}\n\n${promptTemplate}`, ruleSources: ['SKILL.md: Five Dimensions', ...referencePaths] }
}

export async function loadBaoyuSkillRulesForTest(step: 'cover' | 'illustrations') {
  return loadBaoyuSkillRules(step)
}

async function runImageFlow(job: Awaited<ReturnType<typeof getJob>>, step: 'cover' | 'illustrations') {
  const draftId = Number(job.input.draft_id)
  if (!Number.isSafeInteger(draftId) || draftId <= 0) throw new Error(`${step} flow requires draft_id`)
  const draft = await getDraft(draftId)
  const maxImages = step === 'cover' ? 1 : Math.max(1, Math.min(Number(job.input.max_images) || 1, 4))
  const image = await configuredImageModel()
  const text = await configuredTextModel()
  const textProvider = createOpenAI({
    apiKey: text.apiKey,
    baseURL: text.baseURL,
    headers: text.headers,
  })
  const assets: Array<{ id: number; url: string; anchor_heading?: string }> = []
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
        description: step === 'cover'
          ? 'Generate one raster cover image and save it to this draft. The cover_spec is mandatory and records the visual concept, composition, and requested visible text.'
          : 'Generate one raster image from the supplied prompt and save it to this draft. Use this tool for every requested illustration.',
        inputSchema: imageGenerationInputSchema,
        execute: async ({ prompt, filename_hint, cover_spec, anchor_heading }) => {
          if (assets.length >= maxImages) return { error: `Image limit reached (${maxImages})` }
          if (step === 'cover' && !cover_spec) return { error: 'cover_spec is required for cover generation' }
          if (step === 'illustrations' && !anchor_heading) return { error: 'anchor_heading is required for illustration generation' }
          const specPrompt = cover_spec ? `Cover spec:\n- Visual concept: ${cover_spec.visual_concept}\n- Composition: ${cover_spec.composition}\n- Visible text: ${cover_spec.text_elements.join(' | ')}` : ''
          const finalPrompt = step === 'cover' && coverConstraints ? `${coverConstraints}\n\n${specPrompt}\n\n${prompt}` : prompt
          await recordJobEvent(job.id, 'generate_image_called', { tool: 'generateImage', prompt: finalPrompt, filename_hint: filename_hint ?? '', cover_spec: cover_spec ?? {} })
          const generated = await generateImageBytes(image, finalPrompt, { n: 1 })
          const asset = await saveDraftImage(
            job.id,
            draftId,
            `${filename_hint ?? step}-${job.id}-${assets.length + 1}.${imageExtensionForMediaType(generated.mediaType)}`,
            generated.bytes,
            generated.mediaType,
          )
          assets.push({ ...asset, anchor_heading })
          await recordJobEvent(job.id, 'generate_image_succeeded', { tool: 'generateImage', asset_id: asset.id, asset_url: asset.url, anchor_heading: anchor_heading ?? '' })
          return asset
        },
      }),
    },
  })
  if (!assets.length) {
    throw new Error(`The ${step} skill did not call generateImage`)
  }
  const placements: Array<{ asset_id: number; asset_url: string; anchor_heading: string; placement: 'anchor' | 'append' | 'existing' }> = []
  if (step === 'illustrations') {
    let current = await getDraft(draftId)
    for (const asset of assets) {
      const anchorHeading = asset.anchor_heading ?? ''
      const inserted = insertInlineImage(current.content, asset.url, anchorHeading)
      current = { ...current, content: inserted.content }
      placements.push({ asset_id: asset.id, asset_url: asset.url, anchor_heading: anchorHeading, placement: inserted.placement })
    }
    await updateDraftContent(job.id, draftId, current.content)
    await recordJobEvent(job.id, 'inline_images_inserted', { placements })
  }
  return { draft_id: draftId, asset_ids: assets.map(asset => asset.id), asset_urls: assets.map(asset => asset.url), placements }
}

async function runStandaloneImageFlow(job: Awaited<ReturnType<typeof getJob>>) {
  const prompt = String(job.input.prompt ?? '').trim()
  if (!prompt) throw new Error('standalone_image flow requires prompt')
  const directory = String(job.input.directory ?? '').trim()
  return generateAndSaveImage({
    apiBase: apiBase(), jobId: job.id, prompt, title: job.title, directory,
  })
}


async function completePromptGeneration(
  jobId: number,
  generationId: number,
  mediaAssetId: number,
  provider: string,
  model: string,
) {
  const response = await fetch(
    `${apiBase()}/assets/generations/${generationId}/succeed`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerHeaders(jobId) },
      body: JSON.stringify({
        media_asset_id: mediaAssetId,
        provider,
        model,
      }),
    },
  )
  if (!response.ok) throw new Error(`Prompt generation completion failed (${response.status})`)
}

async function failPromptGeneration(jobId: number, generationId: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const response = await fetch(
    `${apiBase()}/assets/generations/${generationId}/fail`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerHeaders(jobId) },
      body: JSON.stringify({ error: message.slice(0, 500) }),
    },
  )
  if (!response.ok) throw new Error(`Prompt generation failure update failed (${response.status})`)
}

export async function runPromptImageGenerationFlow(job: Awaited<ReturnType<typeof getJob>>) {
  const generationId = Number(job.input.generation_id)
  if (!Number.isSafeInteger(generationId) || generationId <= 0) {
    throw new Error('prompt_image_generation flow requires generation_id')
  }
  const prompt = String(job.input.prompt_snapshot ?? '').trim()
  if (!prompt) throw new Error('prompt_image_generation flow requires prompt_snapshot')
  const title = String(job.input.title_snapshot ?? job.title).trim() || `提示词图片 ${job.id}`

  try {
    const image = await configuredImageModel()
    await recordJobEvent(job.id, 'generate_image_called', {
      tool: 'generateImage',
      prompt,
      prompt_asset_id: Number(job.input.prompt_asset_id),
      generation_id: generationId,
    })
    const generated = await generateImageBytes(image, prompt, { n: 1 })
    const asset = await saveCreativeAssetImage(
      job.id,
      title,
      `prompt-image-${job.id}.${imageExtensionForMediaType(generated.mediaType)}`,
      generated.bytes,
      generated.mediaType,
    )
    await recordJobEvent(job.id, 'generate_image_succeeded', {
      tool: 'generateImage',
      asset_id: asset.id,
      asset_url: asset.url,
      prompt_asset_id: Number(job.input.prompt_asset_id),
      generation_id: generationId,
      model: image.modelName,
    })
    await completePromptGeneration(
      job.id,
      generationId,
      asset.id,
      'openai-compatible',
      image.modelName,
    )
    return {
      generation_id: generationId,
      asset_id: asset.id,
      asset_url: asset.url,
      model: image.modelName,
    }
  } catch (error) {
    await failPromptGeneration(job.id, generationId, error)
    throw error
  }
}


async function runTemplateExtractionFlow(job: Awaited<ReturnType<typeof getJob>>, model: ReturnType<typeof createOpenAI>, modelName: string) {
  const customPrompt = String(job.input.prompt ?? '')
  const override = job.input.template_extraction_override === true
  const result = await generateText({
    model: textModelForProvider(model, modelName),
    instructions: override ? customPrompt : `你是写作模板提炼助手。请从原文中提炼一个可复用的写作模板，只返回合法 JSON，不要调用工具，不要创建或更新模板。所有面向用户的字段必须跟随原文语言输出。去除人名、品牌名、产品名、日期、数字、受众假设和平台排版规则；如果无法识别稳定且可迁移的写作结构，recommendation 必须为 skip。\n\n${customPrompt}`,
    prompt: `请只返回 JSON：recommendation(create|merge|skip)、title、genre(tutorial|commentary|story|review)、writing_guide、title_formula、unsuitable_for、genericity_check、可选 merge_target_id、reason。JSON 字段名和枚举值保持英文；title、writing_guide、title_formula、unsuitable_for、genericity_check、reason 必须使用原文语言。原文输入：${JSON.stringify(job.input)}`,
  })
  return { candidate: parseTemplateCandidate(result.text) }
}

export async function runContentJob(jobId: number) {
  const job = await getJob(jobId)
  const draftStep = job.steps.find(step => step.key === 'draft')
  if (draftStep?.output?.draft_id) return draftStep.output
  let activeStep: { id: number } | undefined
  try {
    if (job.flow === 'cover' || job.flow === 'illustrations' || job.flow === 'standalone_image' || job.flow === 'prompt_image_generation') {
      activeStep = await startStep(job.id, job.flow)
      const output = job.flow === 'standalone_image'
        ? await runStandaloneImageFlow(job)
        : job.flow === 'prompt_image_generation'
          ? await runPromptImageGenerationFlow(job)
          : await runImageFlow(job, job.flow)
      await completeStep(job.id, activeStep.id, output)
      activeStep = undefined
      await completeJob(job.id)
      return output
    }
    activeStep = await startStep(
      job.id,
      job.flow === 'template_extraction' ? 'template_extraction' : 'brief',
    )
    const text = await configuredTextModel()
    const openai = createOpenAI({
      apiKey: text.apiKey,
      baseURL: text.baseURL,
      headers: text.headers,
    })
    const modelName = text.modelName
    if (job.flow === 'template_extraction') {
      const output = await runTemplateExtractionFlow(job, openai, modelName)
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
