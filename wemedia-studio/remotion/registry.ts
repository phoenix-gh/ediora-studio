import { techTextV1Manifest } from './templates/tech-text-v1/manifest'

const templates = new Map<string, typeof techTextV1Manifest>([
  [techTextV1Manifest.id, techTextV1Manifest],
])

export function resolveTextVideoTemplate(id: string) {
  const template = templates.get(id)
  if (!template) {
    throw new Error(`未知文字视频模板：${id}`)
  }
  return template
}

export const textVideoTemplates = [techTextV1Manifest] as const
