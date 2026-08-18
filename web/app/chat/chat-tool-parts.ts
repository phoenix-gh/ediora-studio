import { creativeAssetUrl } from '@/lib/api/assets'

export type ChatToolPartLike = {
  type: string
  toolName?: string
  output?: unknown
  state?: string
  approval?: { approved?: boolean }
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

export function imageGenerationSummary(parts: ChatToolPartLike[]) {
  const imageParts = parts.filter(part => chatToolName(part) === 'generateImage')
  if (imageParts.length === 0) return ''
  const successful = imageParts.filter(part => generatedImageUrls(part).length > 0).length
  const failed = imageParts.filter(part => part.state === 'output-error' || part.state === 'error').length
  if (successful > 0 && failed > 0) return `已生成 ${successful} 张图片（失败 ${failed} 次）`
  if (successful > 0) return `已生成 ${successful} 张图片`
  if (failed > 0) return `图片生成失败 ${failed} 次`
  return `正在生成 ${imageParts.length} 张图片`
}

export function chatToolStatus(part: ChatToolPartLike) {
  if (part.state === 'approval-requested') return '等待你确认'
  if (part.state === 'running' || part.state === 'input-available') return '进行中'
  if (part.state === 'approval-responded') return part.approval?.approved ? '已批准' : '已拒绝'
  if (part.state === 'output-error' || part.state === 'error') return '失败'
  return '已完成'
}

export function legacyImageJobId(part: ChatToolPartLike) {
  if (chatToolName(part) !== 'generateImage' || !part.output || typeof part.output !== 'object') return null
  const jobId = (part.output as { jobId?: unknown }).jobId
  return typeof jobId === 'number' ? jobId : null
}
