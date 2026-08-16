import { creativeAssetUrl } from '@/lib/api/assets'

export type ChatToolPartLike = {
  type: string
  toolName?: string
  output?: unknown
}

export function isChatToolPart(part: { type: string }) {
  return part.type === 'dynamic-tool'
    || part.type === 'tool-event'
    || part.type === 'tool-result'
    || part.type.startsWith('tool-')
}

export function chatToolName(part: ChatToolPartLike) {
  if (typeof part.toolName === 'string') return part.toolName
  return part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : '工具调用'
}

export function generatedImageUrls(part: ChatToolPartLike) {
  if (chatToolName(part) !== 'generateImage' || !part.output || typeof part.output !== 'object') return []
  const assetUrl = (part.output as { asset_url?: unknown }).asset_url
  return typeof assetUrl === 'string' && assetUrl.trim() ? [creativeAssetUrl(assetUrl)] : []
}

export function legacyImageJobId(part: ChatToolPartLike) {
  if (chatToolName(part) !== 'generateImage' || !part.output || typeof part.output !== 'object') return null
  const jobId = (part.output as { jobId?: unknown }).jobId
  return typeof jobId === 'number' ? jobId : null
}
