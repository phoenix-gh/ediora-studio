import { randomUUID } from 'node:crypto'

import { createOpenAI } from '@ai-sdk/openai'
import { generateImage } from 'ai'

import { apiBase as defaultApiBase, workerHeaders } from './job-client'
import {
  imageModelConfigFromSettings,
  type ImageModelSettings,
} from './runtime-config'

export type ImageModelConfig = {
  apiKey: string
  modelName: string
  baseURL?: string
}

export type ImageReference = {
  bytes: Uint8Array
  mediaType: string
}

export type GenerateAndSaveImageInput = {
  apiBase?: string
  jobId?: number
  prompt: string
  title?: string
  directory?: string
  referenceImages?: ImageReference[]
  size?: `${number}x${number}`
}

export type GeneratedImageAsset = {
  asset_id: number
  asset_url: string
  title: string
  directory: string
  model: string
}

export function creativeAssetUploadQuery(title: string, directory = '') {
  const query = new URLSearchParams({ media_kind: 'image', title })
  if (directory.trim()) query.set('directory', directory.trim())
  return query.toString()
}

function normalizedApiBase(value?: string) {
  return (value ?? defaultApiBase()).replace(/\/$/, '')
}

export async function configuredImageModel(apiRoot = normalizedApiBase()): Promise<ImageModelConfig> {
  const response = await fetch(`${normalizedApiBase(apiRoot)}/settings/ai-runtime`, {
    cache: 'no-store',
    headers: workerHeaders(),
  })
  if (!response.ok) throw new Error('无法读取设置中的图片模型配置')
  const settings = await response.json() as { image?: ImageModelSettings }
  return imageModelConfigFromSettings(settings.image ?? {})
}

export async function saveCreativeAssetImage(
  jobId: number | undefined,
  title: string,
  filename: string,
  bytes: Uint8Array,
  mediaType: string,
  directory = '',
  apiRoot = normalizedApiBase(),
) {
  const form = new FormData()
  const data = new Uint8Array(bytes.byteLength)
  data.set(bytes)
  form.append('file', new Blob([data], { type: mediaType }), filename)
  const response = await fetch(`${normalizedApiBase(apiRoot)}/assets/upload?${creativeAssetUploadQuery(title, directory)}`, {
    method: 'POST',
    headers: workerHeaders(jobId),
    body: form,
  })
  if (!response.ok) throw new Error(`Creative asset upload failed (${response.status})`)
  return response.json() as Promise<{ id: number; url: string; title: string }>
}

export async function recordJobEvent(
  jobId: number,
  kind: string,
  payload: Record<string, unknown>,
  apiRoot = normalizedApiBase(),
) {
  const response = await fetch(`${normalizedApiBase(apiRoot)}/jobs/${jobId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, payload }),
  })
  if (!response.ok) throw new Error(`Unable to record ${kind} event`)
}

export async function generateAndSaveImage({
  apiBase,
  jobId,
  prompt,
  title,
  directory,
  referenceImages,
  size,
}: GenerateAndSaveImageInput): Promise<GeneratedImageAsset> {
  const apiRoot = normalizedApiBase(apiBase)
  const normalizedPrompt = prompt.trim()
  if (!normalizedPrompt) throw new Error('generateImage requires a prompt')
  const normalizedTitle = title?.trim() || 'Chat 生图'
  const normalizedDirectory = directory?.trim() || ''
  const image = await configuredImageModel(apiRoot)
  const provider = createOpenAI({ apiKey: image.apiKey, baseURL: image.baseURL })
  const refs = referenceImages?.filter(item => item.bytes.byteLength > 0) ?? []

  if (jobId !== undefined) {
    await recordJobEvent(jobId, 'generate_image_called', {
      tool: 'generateImage',
      prompt: normalizedPrompt,
      standalone: true,
      reference_count: refs.length,
    }, apiRoot)
  }
  const generated = await generateImage({
    model: provider.image(image.modelName),
    prompt: refs.length
      ? {
          text: normalizedPrompt,
          images: refs.map(item => item.bytes),
        }
      : normalizedPrompt,
    n: 1,
    ...(size ? { size } : {}),
  })
  const output = generated.images[0]
  if (!output) throw new Error('Image model returned no image')
  const asset = await saveCreativeAssetImage(
    jobId,
    normalizedTitle,
    `chat-image-${randomUUID()}.png`,
    output.uint8Array,
    output.mediaType,
    normalizedDirectory,
    apiRoot,
  )
  if (jobId !== undefined) {
    await recordJobEvent(jobId, 'generate_image_succeeded', {
      tool: 'generateImage', asset_id: asset.id, asset_url: asset.url,
      directory: normalizedDirectory, standalone: true,
    }, apiRoot)
  }
  return {
    asset_id: asset.id,
    asset_url: asset.url,
    title: asset.title,
    directory: normalizedDirectory,
    model: image.modelName,
  }
}
