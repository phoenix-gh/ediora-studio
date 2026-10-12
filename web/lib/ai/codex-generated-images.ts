import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { CODEX_HOME } from './codex-app-server'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMAGE_BYTES = 100 * 1024 * 1024

export type PublishedCodexImage = {
  id: string
  url: string
}

function textField(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export function chatUploadsDirectory() {
  return process.env.WMS_UPLOADS_DIR
    ?? path.resolve(process.cwd(), '../backend/uploads')
}

export function codexGeneratedImageRoot() {
  return path.join(CODEX_HOME, 'generated_images')
}

function isGeneratedImageItem(item: Record<string, unknown>) {
  const type = textField(item.type)
  const kind = textField(item.kind)
  return type === 'imageGeneration'
    || type === 'ImageGeneration'
    || ((type === 'extension' || type === 'Extension') && kind === 'image_gen.generation')
}

export function codexGeneratedImagePaths(items: readonly Record<string, unknown>[]) {
  const paths: string[] = []
  for (const item of items) {
    if (!isGeneratedImageItem(item)) continue
    const status = textField(item.status) || 'completed'
    if (status !== 'completed' || item.failure) continue
    const saved = textField(item.savedPath) || textField(item.saved_path)
    if (saved) paths.push(saved)
  }
  return paths
}

async function filesInside(root: string, candidates: readonly string[]) {
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch {
    return []
  }
  const accepted: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    let resolved: string
    try {
      resolved = await realpath(candidate)
      const info = await stat(resolved)
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) continue
    } catch {
      continue
    }
    const extension = path.extname(resolved).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension)) continue
    const relative = path.relative(rootReal, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    accepted.push(resolved)
  }
  return accepted
}

async function threadImageCandidates(threadId: string, root: string) {
  if (!/^[0-9a-zA-Z-]+$/.test(threadId)) return []
  const directory = path.join(root, threadId)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  return names.map(name => path.join(directory, name))
}

export async function publishCodexGeneratedImages(
  input: { threadId?: string | null; items?: readonly Record<string, unknown>[] },
  options: { uploadsDir?: string; generatedRoot?: string } = {},
): Promise<PublishedCodexImage[]> {
  const root = options.generatedRoot ?? codexGeneratedImageRoot()
  const candidates = [
    ...codexGeneratedImagePaths(input.items ?? []),
    ...await threadImageCandidates(input.threadId ?? '', root),
  ]
  const files = await filesInside(root, candidates)
  if (files.length === 0) return []
  const uploadsDir = options.uploadsDir ?? chatUploadsDirectory()
  await mkdir(uploadsDir, { recursive: true })
  const published: PublishedCodexImage[] = []
  for (const file of files) {
    const extension = path.extname(file).toLowerCase()
    const filename = `${randomUUID().replaceAll('-', '')}${extension === '.jpeg' ? '.jpg' : extension}`
    await copyFile(file, path.join(uploadsDir, filename))
    published.push({ id: filename, url: `/api/uploads/${filename}` })
  }
  return published
}

export function codexImageMessageParts(images: readonly PublishedCodexImage[]) {
  return images.map(image => ({
    type: 'tool-event' as const,
    toolName: 'generateImage' as const,
    toolCallId: image.id,
    state: 'output-available' as const,
    output: { asset_url: image.url },
  }))
}
