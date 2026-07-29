import { techTextV1Manifest } from './templates/tech-text-v1/manifest'

type TemplateIdentity = {
  id: string
  version: number
  compositionId: string
}

function templateKey(id: string, version: number) {
  return `${id}@${version}`
}

export function createTextVideoTemplateRegistry<const T extends TemplateIdentity>(
  manifests: readonly T[],
) {
  const templatesByKey = new Map<string, T>()
  const compositionIds = new Set<string>()

  for (const manifest of manifests) {
    if (!manifest.id.trim()) {
      throw new Error('文字视频模板 id 不能为空')
    }
    if (!Number.isSafeInteger(manifest.version) || manifest.version <= 0) {
      throw new Error(`文字视频模板版本必须是正安全整数：${manifest.id}@${manifest.version}`)
    }
    if (!manifest.compositionId.trim() || manifest.compositionId.includes('@')) {
      throw new Error(`Remotion compositionId 无效：${manifest.compositionId}`)
    }

    const key = templateKey(manifest.id, manifest.version)
    if (templatesByKey.has(key)) {
      throw new Error(`重复文字视频模板：${key}`)
    }
    if (compositionIds.has(manifest.compositionId)) {
      throw new Error(`重复 Remotion compositionId：${manifest.compositionId}`)
    }
    templatesByKey.set(key, manifest)
    compositionIds.add(manifest.compositionId)
  }

  return templatesByKey
}

export const textVideoTemplates = [techTextV1Manifest] as const

const templates = createTextVideoTemplateRegistry(textVideoTemplates)

export function resolveTextVideoTemplate(id: string, version: number) {
  const key = templateKey(id, version)
  const template = templates.get(key)
  if (!template) {
    throw new Error(`未知文字视频模板：${key}`)
  }
  return template
}
