import { techTextV1Manifest } from './templates/tech-text-v1/manifest'
import {
  captionFocusV1Manifest,
  editorialCardV1Manifest,
  kineticPunchV1Manifest,
  voicePulseV1Manifest,
} from './templates/presets-v1/manifest'

type TemplateIdentity = {
  id: string
  version: number
  compositionId: string
  defaults: Record<string, unknown>
  settings: readonly {
    fields: readonly {
      key: string
    }[]
  }[]
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

    const settingKeys = new Set<string>()
    for (const group of manifest.settings) {
      for (const field of group.fields) {
        if (settingKeys.has(field.key)) {
          throw new Error(`重复模板设置字段：${field.key}`)
        }
        if (!Object.hasOwn(manifest.defaults, field.key)) {
          throw new Error(`模板设置字段缺少默认值：${field.key}`)
        }
        settingKeys.add(field.key)
      }
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

export const textVideoTemplates = [
  techTextV1Manifest,
  kineticPunchV1Manifest,
  captionFocusV1Manifest,
  editorialCardV1Manifest,
  voicePulseV1Manifest,
] as const

const templates = createTextVideoTemplateRegistry(textVideoTemplates)

export function resolveTextVideoTemplate(id: string, version: number) {
  if (
    typeof id !== 'string'
    || !id.trim()
    || typeof version !== 'number'
    || !Number.isSafeInteger(version)
    || version <= 0
  ) {
    throw new Error(`未知文字视频模板：${String(id)}@${String(version)}`)
  }
  const key = templateKey(id, version)
  const template = templates.get(key)
  if (!template) {
    throw new Error(`未知文字视频模板：${key}`)
  }
  return template
}
