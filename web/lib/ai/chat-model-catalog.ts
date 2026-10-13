import { DEFAULT_CODEX_MODEL, usableCodexModel, usableCodexReasoningEffort } from '@/lib/ai/codex-model'

export type ChatReasoningEffortOption = {
  reasoningEffort: string
  description: string
}

export type ChatModelChoice = {
  id: string
  model: string
  displayName: string
  description: string
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: ChatReasoningEffortOption[]
}

export type ChatModelSelection = {
  model: string
  reasoningEffort: string
}

export const CHAT_MODEL_SELECTION_STORAGE_KEY = 'ediora.chat.model-selection'
export const CHAT_MODEL_SELECTION_CHANGED_EVENT = 'ediora-chat-model-selection'

const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  minimal: '极轻',
  low: '轻量',
  medium: '标准',
  high: '深入',
  xhigh: '很深入',
  max: '最大',
  ultra: '极致',
}

export const FALLBACK_CHAT_MODELS: ChatModelChoice[] = [{
  id: DEFAULT_CODEX_MODEL,
  model: DEFAULT_CODEX_MODEL,
  displayName: DEFAULT_CODEX_MODEL,
  description: '当前助手默认模型',
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: '更快，思考更轻' },
    { reasoningEffort: 'medium', description: '平衡速度和思考深度' },
    { reasoningEffort: 'high', description: '更深入的思考' },
    { reasoningEffort: 'xhigh', description: '复杂问题用更强的思考' },
  ],
}]

export function reasoningEffortLabel(effort: string) {
  return EFFORT_LABELS[effort] ?? effort
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseEffort(value: unknown): ChatReasoningEffortOption | null {
  const item = record(value)
  const reasoningEffort = text(item?.reasoningEffort)
  if (!item || !reasoningEffort) return null
  return {
    reasoningEffort,
    description: text(item.description),
  }
}

function parseModel(value: unknown): ChatModelChoice | null {
  const item = record(value)
  if (!item || item.hidden === true) return null
  const model = text(item.model) || text(item.id)
  const efforts = Array.isArray(item.supportedReasoningEfforts)
    ? item.supportedReasoningEfforts.flatMap(effort => {
      const parsed = parseEffort(effort)
      return parsed ? [parsed] : []
    })
    : []
  const defaultReasoningEffort = text(item.defaultReasoningEffort) || efforts[0]?.reasoningEffort || 'medium'
  if (!model || efforts.length === 0) return null
  const supported = efforts.some(effort => effort.reasoningEffort === defaultReasoningEffort)
    ? efforts
    : [{ reasoningEffort: defaultReasoningEffort, description: '' }, ...efforts]
  return {
    id: text(item.id) || model,
    model,
    displayName: text(item.displayName) || model,
    description: text(item.description),
    isDefault: item.isDefault === true,
    defaultReasoningEffort,
    supportedReasoningEfforts: supported,
  }
}

export function parseChatModelCatalog(payload: unknown): ChatModelChoice[] {
  const body = record(payload)
  const data = Array.isArray(payload)
    ? payload
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : []
  return data.flatMap(item => {
    const model = parseModel(item)
    return model ? [model] : []
  })
}

export function ensureAssistantModel(models: ChatModelChoice[]): ChatModelChoice[] {
  const available = models.length > 0 ? models : FALLBACK_CHAT_MODELS
  if (available.some(item => item.model === DEFAULT_CODEX_MODEL)) return available
  return [{ ...FALLBACK_CHAT_MODELS[0], isDefault: false }, ...available]
}

export function ensureNamedModel(
  models: ChatModelChoice[],
  modelId: string,
  reasoningEffort?: string,
): ChatModelChoice[] {
  const available = ensureAssistantModel(models)
  const id = usableCodexModel(modelId)
  if (!id || available.some(item => item.model === id)) return available
  const effort = usableCodexReasoningEffort(reasoningEffort)
  const supported = FALLBACK_CHAT_MODELS[0].supportedReasoningEfforts
  return [{
    id,
    model: id,
    displayName: id,
    description: '自定义模型',
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: effort && !supported.some(item => item.reasoningEffort === effort)
      ? [...supported, { reasoningEffort: effort, description: '' }]
      : supported,
  }, ...available]
}

export function resolveChatModelSelection(
  models: ChatModelChoice[],
  preferred?: { model?: string, reasoningEffort?: string } | null,
): ChatModelSelection {
  const available = ensureAssistantModel(models)
  const preferredModel = preferred?.model === 'deepseek-flash'
    ? DEFAULT_CODEX_MODEL
    : preferred?.model
  const model = available.find(item => item.model === preferredModel)
    ?? (preferredModel ? undefined : available.find(item => item.model === DEFAULT_CODEX_MODEL))
    ?? available.find(item => item.isDefault)
    ?? available[0]
  const effort = model.supportedReasoningEfforts.find(item => item.reasoningEffort === preferred?.reasoningEffort)
    ?? model.supportedReasoningEfforts.find(item => item.reasoningEffort === model.defaultReasoningEffort)
    ?? model.supportedReasoningEfforts[0]
  return {
    model: model.model,
    reasoningEffort: effort?.reasoningEffort ?? model.defaultReasoningEffort,
  }
}

export function readStoredChatModelSelection(
  storage: Pick<Storage, 'getItem'> | null,
): { model?: string, reasoningEffort?: string } | null {
  if (!storage) return null
  try {
    const parsed = record(JSON.parse(storage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) ?? ''))
    const model = text(parsed?.model)
    const reasoningEffort = text(parsed?.reasoningEffort)
    if (!model && !reasoningEffort) return null
    return {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  } catch {
    return null
  }
}

export function writeStoredChatModelSelection(
  storage: Pick<Storage, 'setItem'> | null,
  selection: ChatModelSelection,
) {
  storage?.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, JSON.stringify(selection))
}

export async function fetchChatModelCatalog(): Promise<ChatModelChoice[]> {
  try {
    const response = await fetch('/api/chat/models')
    if (!response.ok) return []
    return parseChatModelCatalog(await response.json())
  } catch {
    return []
  }
}
