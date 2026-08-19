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
  responseFormat?: 'url' | 'base64'
}

export type ImageReference = {
  bytes: Uint8Array
  mediaType: string
}

export type ImagePrompt = string | {
  text: string
  images: ImageReference[]
}

export type GeneratedImageBytes = {
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

export const DEFAULT_IMAGE_DIRECTORY = '临时文件'

export function creativeAssetUploadQuery(title: string, directory = '') {
  const query = new URLSearchParams({ media_kind: 'image', title })
  if (directory.trim()) query.set('directory', directory.trim())
  return query.toString()
}

function normalizedApiBase(value?: string) {
  return (value ?? defaultApiBase()).replace(/\/$/, '')
}

export function normalizeImageDirectory(directory?: string) {
  return directory?.trim() || DEFAULT_IMAGE_DIRECTORY
}

export async function validateMediaDirectory(
  directory: string,
  apiRoot = normalizedApiBase(),
  jobId?: number,
) {
  const response = await fetch(`${normalizedApiBase(apiRoot)}/assets/directories?asset_type=media`, {
    cache: 'no-store',
    headers: workerHeaders(jobId),
  })
  if (!response.ok) throw new Error('无法读取多媒体资产目录')
  const directories = await response.json() as unknown
  const exists = Array.isArray(directories)
    && directories.some(item => (
      item
      && typeof item === 'object'
      && 'name' in item
      && item.name === directory
    ))
  if (!exists) throw new Error(`多媒体目录不存在：${directory}`)
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
  directory = DEFAULT_IMAGE_DIRECTORY,
  apiRoot = normalizedApiBase(),
) {
  const uploadUrl = `${normalizedApiBase(apiRoot)}/assets/upload?${creativeAssetUploadQuery(title, directory)}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const form = new FormData()
    const data = new Uint8Array(bytes.byteLength)
    data.set(bytes)
    form.append('file', new Blob([data], { type: mediaType }), filename)
    let response: Response
    try {
      response = await fetch(uploadUrl, {
        method: 'POST',
        headers: workerHeaders(jobId),
        body: form,
      })
    } catch (error) {
      if (attempt === 0) continue
      throw error
    }
    if (response.ok) return response.json() as Promise<{ id: number; url: string; title: string }>
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === 1) throw new Error(`Creative asset upload failed (${response.status})`)
  }
  throw new Error('Creative asset upload failed')
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

function imageApiBase(config: ImageModelConfig) {
  return (config.baseURL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
}

function mediaTypeFromUrl(url: string) {
  const pathname = new URL(url).pathname.toLowerCase()
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
  if (pathname.endsWith('.webp')) return 'image/webp'
  if (pathname.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

function mediaTypeFromDownload(response: Response, url: string) {
  const header = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (header?.startsWith('image/')) return header
  if (header && header !== 'application/octet-stream') {
    throw new Error(`Downloaded image has an invalid media type: ${header}`)
  }
  return mediaTypeFromUrl(url)
}

export function imageExtensionForMediaType(mediaType: string) {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

async function responseError(response: Response, action: string) {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 240)
  } catch {
    // Keep the status as the useful error when the body is unreadable.
  }
  return new Error(`${action} failed (${response.status})${detail ? `: ${detail}` : ''}`)
}

async function generateImageFromUrl(
  config: ImageModelConfig,
  prompt: ImagePrompt,
  options: { n: number; size?: `${number}x${number}` },
): Promise<GeneratedImageBytes> {
  const headers = { Authorization: `Bearer ${config.apiKey}` }
  let response: Response
  if (typeof prompt === 'string') {
    response = await fetch(`${imageApiBase(config)}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.modelName,
        prompt,
        n: options.n,
        ...(options.size ? { size: options.size } : {}),
        response_format: 'url',
      }),
    })
  } else {
    const form = new FormData()
    form.append('model', config.modelName)
    form.append('prompt', prompt.text)
    form.append('n', String(options.n))
    if (options.size) form.append('size', options.size)
    form.append('response_format', 'url')
    prompt.images.forEach((image, index) => {
      const data = new Uint8Array(image.bytes.byteLength)
      data.set(image.bytes)
      form.append(
        'image',
        new Blob([data], { type: image.mediaType || 'application/octet-stream' }),
        `reference-${index}.${imageExtensionForMediaType(image.mediaType)}`,
      )
    })
    response = await fetch(`${imageApiBase(config)}/images/edits`, {
      method: 'POST',
      headers,
      body: form,
    })
  }

  if (!response.ok) throw await responseError(response, 'Image provider request')
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Image provider returned invalid JSON')
  }
  const imageUrl = (
    payload
    && typeof payload === 'object'
    && 'data' in payload
    && Array.isArray(payload.data)
    && payload.data[0]
    && typeof payload.data[0] === 'object'
    && 'url' in payload.data[0]
    && typeof payload.data[0].url === 'string'
  ) ? payload.data[0].url : ''
  if (!imageUrl) throw new Error('Image provider response did not include an image URL')
  const parsedUrl = new URL(imageUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Image provider returned a non-HTTP image URL')
  }

  const downloaded = await fetch(parsedUrl)
  if (!downloaded.ok) throw await responseError(downloaded, 'Image download')
  const bytes = new Uint8Array(await downloaded.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('Image download returned an empty file')
  return {
    bytes,
    mediaType: mediaTypeFromDownload(downloaded, parsedUrl.toString()),
  }
}

export async function generateImageBytes(
  config: ImageModelConfig,
  prompt: ImagePrompt,
  options: { n?: number; size?: `${number}x${number}` } = {},
): Promise<GeneratedImageBytes> {
  const n = options.n ?? 1
  if (config.responseFormat === 'url') {
    return generateImageFromUrl(config, prompt, { n, size: options.size })
  }
  const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  const generated = await generateImage({
    model: provider.image(config.modelName),
    prompt: typeof prompt === 'string'
      ? prompt
      : { text: prompt.text, images: prompt.images.map(image => image.bytes) },
    n,
    ...(options.size ? { size: options.size } : {}),
  })
  const output = generated.images[0]
  if (!output) throw new Error('Image model returned no image')
  return { bytes: output.uint8Array, mediaType: output.mediaType }
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
  const normalizedDirectory = normalizeImageDirectory(directory)
  await validateMediaDirectory(normalizedDirectory, apiRoot, jobId)
  const image = await configuredImageModel(apiRoot)
  const refs = referenceImages?.filter(item => item.bytes.byteLength > 0) ?? []

  if (jobId !== undefined) {
    await recordJobEvent(jobId, 'generate_image_called', {
      tool: 'generateImage',
      prompt: normalizedPrompt,
      standalone: true,
      reference_count: refs.length,
    }, apiRoot)
  }
  const output = await generateImageBytes(
    image,
    refs.length ? { text: normalizedPrompt, images: refs } : normalizedPrompt,
    { n: 1, size },
  )
  const asset = await saveCreativeAssetImage(
    jobId,
    normalizedTitle,
    `chat-image-${randomUUID()}.${imageExtensionForMediaType(output.mediaType)}`,
    output.bytes,
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
