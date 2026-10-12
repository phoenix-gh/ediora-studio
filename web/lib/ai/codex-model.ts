// Imported by client components. Do not add Node built-ins here.
export const DEFAULT_CODEX_MODEL = 'proxy/deepseek-v4-flash'

// Same rule as the settings API: letters, digits, dot, underscore, hyphen, and slash.
// The id cannot start or end with a slash, and it stays within 200 characters.
const CODEX_MODEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9])?$/
const UNSUPPORTED_CODEX_MODELS = new Set(['deepseek-flash', 'proxy/deepseek-flash'])

export function codexModelRejection(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return '模型名只能包含字母、数字、点、下划线、短横线和斜线，且不能以斜线开头或结尾'
  }
  const model = value.trim()
  if (UNSUPPORTED_CODEX_MODELS.has(model)) {
    return 'deepseek-flash 没有可用通道，请改用 proxy/deepseek-v4-flash'
  }
  if (!CODEX_MODEL_ID.test(model)) {
    return '模型名只能包含字母、数字、点、下划线、短横线和斜线，且不能以斜线开头或结尾'
  }
  return undefined
}

export function usableCodexModel(value: unknown): string | undefined {
  if (typeof value !== 'string' || codexModelRejection(value)) return undefined
  return value.trim()
}

const CODEX_EFFORT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function usableCodexReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const effort = value.trim()
  return CODEX_EFFORT_ID.test(effort) ? effort : undefined
}

// `provider/model` selects that Codex provider. The request model is the part after the slash.
export function codexThreadModel(model = DEFAULT_CODEX_MODEL): {
  model: string
  modelProvider?: string
} {
  const separator = model.indexOf('/')
  if (separator <= 0 || separator === model.length - 1) return { model }
  return {
    model: model.slice(separator + 1),
    modelProvider: model.slice(0, separator),
  }
}
